/**
 * Twilio Media Streams WebSocket handler.
 *
 * Primary path: OpenAI Realtime (realtime.ts handles all audio when active).
 * Fallback path: Spark STT → OpenAI Chat LLM → Spark TTS (with ElevenLabs sub-fallback).
 *
 * The dual-listener issue is avoided by having realtime.ts attach its own
 * ws.on('message') listener, while this handler only processes media events
 * when realtimeFailed=true.
 */

import WebSocket, { WebSocketServer } from 'ws';
import { createRealtimeBridge } from './realtime';
import { transcribe } from './stt';
import { synthesize } from './tts';
import { sendToOpenClaw } from './gateway';
import { mulawToWav, audioToMulaw } from './mulaw';

const SILENCE_THRESHOLD_MS = 500;
const MIN_AUDIO_MS = 300; // don't transcribe clips shorter than this

export function handleStream(wss: WebSocketServer): void {
  wss.on('connection', (ws: WebSocket) => {
    console.log('[stream] New Twilio Media Streams connection');

    let callSid = '';
    let streamSid = '';
    let realtimeFailed = false;

    // Fallback audio accumulation
    let mulawChunks: Buffer[] = [];
    let lastMediaAt = 0;
    let silenceTimer: ReturnType<typeof setTimeout> | null = null;
    let processingFallback = false;

    // ── Attempt realtime bridge once we have the callSid ─────────────────────
    // realtime.ts attaches its own ws.on('message') for audio forwarding.
    // This handler only processes media when realtimeFailed=true.
    function tryRealtime(): void {
      createRealtimeBridge(ws, callSid)
        .then(() => {
          console.log('[stream] OpenAI Realtime bridge active — realtime.ts handling audio');
        })
        .catch((err: Error) => {
          console.warn(`[stream] Realtime unavailable (${err.message}), switching to fallback`);
          realtimeFailed = true;
        });
    }

    // ── Fallback: silence-triggered STT → LLM → TTS loop ─────────────────────
    async function processUtterance(): Promise<void> {
      if (processingFallback || mulawChunks.length === 0) return;
      processingFallback = true;

      const combined = Buffer.concat(mulawChunks);
      mulawChunks = [];

      // Rough duration check: 8kHz mono = 8000 bytes/sec
      const durationMs = (combined.length / 8000) * 1000;
      if (durationMs < MIN_AUDIO_MS) {
        console.log(`[stream] Skipping short clip (${durationMs.toFixed(0)}ms)`);
        processingFallback = false;
        return;
      }

      try {
        // STT: µ-law → WAV → transcript (Spark → OpenAI Whisper fallback in stt.ts)
        const wavBuf = await mulawToWav(combined);
        const transcript = await transcribe(wavBuf);
        if (!transcript.trim()) {
          console.log('[stream] Empty transcript, skipping');
          processingFallback = false;
          return;
        }
        console.log(`[stream] Transcribed: "${transcript}"`);

        // LLM: OpenAI Chat (synchronous response)
        const reply = await sendToOpenClaw(transcript);
        if (!reply.trim()) {
          processingFallback = false;
          return;
        }
        console.log(`[stream] LLM reply: "${reply}"`);

        // TTS: text → audio Buffer (Spark Kokoro → ElevenLabs fallback in tts.ts)
        const ttsAudio = await synthesize(reply);

        // Convert TTS output (mp3) → 8kHz µ-law for Twilio
        const mulawAudio = await audioToMulaw(ttsAudio, 'mp3');

        if (streamSid && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            event: 'media',
            streamSid,
            media: { payload: mulawAudio.toString('base64') },
          }));
          console.log('[stream] Sent TTS audio back to Twilio');
        }
      } catch (err) {
        console.error('[stream] Fallback pipeline error:', err);
      } finally {
        processingFallback = false;
      }
    }

    // ── Main message handler ──────────────────────────────────────────────────
    ws.on('message', (data: WebSocket.RawData) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString()) as Record<string, unknown>;
      } catch {
        return;
      }

      if (msg.event === 'start') {
        const start = msg.start as Record<string, string>;
        callSid = start.callSid;
        streamSid = start.streamSid;
        console.log(`[stream] Call started: CallSid=${callSid} StreamSid=${streamSid}`);
        tryRealtime();

      } else if (msg.event === 'media') {
        // Only process in fallback mode — realtime.ts handles it when Realtime is active
        if (!realtimeFailed) return;

        const media = msg.media as Record<string, string>;
        const chunk = Buffer.from(media.payload, 'base64');
        mulawChunks.push(chunk);
        lastMediaAt = Date.now();

        // Reset silence timer
        if (silenceTimer) clearTimeout(silenceTimer);
        silenceTimer = setTimeout(() => {
          void processUtterance();
        }, SILENCE_THRESHOLD_MS);

      } else if (msg.event === 'stop') {
        console.log(`[stream] Call ended: CallSid=${callSid}`);
        if (silenceTimer) clearTimeout(silenceTimer);
        // Flush any remaining audio
        if (realtimeFailed && mulawChunks.length > 0) {
          void processUtterance();
        }
      }
    });

    ws.on('close', () => {
      console.log(`[stream] WebSocket closed: CallSid=${callSid}`);
      if (silenceTimer) clearTimeout(silenceTimer);
    });

    ws.on('error', (err) => {
      console.error(`[stream] WebSocket error (CallSid=${callSid}):`, err.message);
    });
  });
}
