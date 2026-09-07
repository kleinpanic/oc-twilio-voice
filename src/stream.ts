/**
 * Twilio Media Streams WebSocket handler.
 *
 * Primary path: OpenAI Realtime (realtime.ts handles all audio when active).
 * Fallback path: energy-VAD → Scribe STT → Gemini LLM → ElevenLabs TTS loop.
 *
 * Key insight: Twilio sends continuous audio even during silence, so a simple
 * "no-media" silence timer never fires. We use a lightweight µ-law energy
 * detector to distinguish speech from silence and trigger turn processing.
 */

import WebSocket, { WebSocketServer } from 'ws';
import { createRealtimeBridge } from './realtime.js';
import { transcribe } from './stt.js';
import { synthesize } from './tts.js';
import { sendToOpenClaw } from './gateway.js';
import { mulawToWav, audioToMulaw } from './mulaw.js';

// Fallback turn-taking config
const SPEECH_SILENCE_MS   = 1500;  // ms of silence after speech → process turn
const MAX_TURN_MS         = 10000; // force-process after this long regardless
const SPEECH_ENERGY_RATIO = 0.04;  // fraction of chunk bytes that must be "loud" (lower = more sensitive)
const SPEECH_ENERGY_DELTA = 10;    // min byte deviation from µ-law silence (lower = catches quiet speech)
const MIN_AUDIO_MS        = 300;   // skip clips shorter than this

/**
 * Lightweight µ-law speech detector.
 * G.711 µ-law silence ≈ 0x7F. We count bytes that deviate > SPEECH_ENERGY_DELTA
 * from silence. Returns true if > SPEECH_ENERGY_RATIO of bytes are "loud".
 */
function hasSpeech(chunk: Buffer): boolean {
  let loud = 0;
  for (let i = 0; i < chunk.length; i++) {
    if (Math.abs((chunk[i] as number) - 0x7f) > SPEECH_ENERGY_DELTA) loud++;
  }
  return loud / chunk.length > SPEECH_ENERGY_RATIO;
}

export function handleStream(wss: WebSocketServer): void {
  wss.on('connection', (ws: WebSocket) => {
    console.log('[stream] New Twilio Media Streams connection');

    let callSid   = '';
    let streamSid = '';
    let agentId   = 'main';
    let modelOverride = '';
    let openingMessage = '';
    let realtimeFailed = false;
    let callEnded = false;

    // Fallback accumulation state
    let mulawChunks: Buffer[] = [];
    let lastSpeechAt  = 0;   // timestamp of last loud chunk
    let turnStartAt   = 0;   // timestamp when this turn started
    let silenceTimer: ReturnType<typeof setTimeout> | null = null;
    let maxTurnTimer:  ReturnType<typeof setTimeout> | null = null;
    let processingFallback = false;

    function clearTurnTimers(): void {
      if (silenceTimer)  { clearTimeout(silenceTimer);  silenceTimer  = null; }
      if (maxTurnTimer)  { clearTimeout(maxTurnTimer);  maxTurnTimer  = null; }
    }

    // ── Fallback greeting ─────────────────────────────────────────────────────
    async function playFallbackGreeting(): Promise<void> {
      try {
        console.log(`[stream] Synthesizing fallback greeting (agent=${agentId})…`);
        // Use caller-supplied opening message if set, otherwise default per agent
        const greeting = openingMessage ||
          (agentId === 'main'
            ? "Hey Klein, KleinClaw here. Realtime's down, I'm in fallback mode. Go ahead."
            : `Hey Klein, this is your ${agentId} agent calling. Go ahead.`);
        const audio = await synthesize(greeting);
        const mulawAudio = await audioToMulaw(audio, 'mp3');
        if (ws.readyState === WebSocket.OPEN && streamSid) {
          ws.send(JSON.stringify({
            event: 'media', streamSid,
            media: { payload: mulawAudio.toString('base64') },
          }));
          console.log('[stream] Played fallback greeting');
        }
      } catch (err) {
        console.error('[stream] Failed to play fallback greeting:', (err as Error).message);
      }
    }

    // ── Realtime bridge ───────────────────────────────────────────────────────
    function tryRealtime(): void {
      createRealtimeBridge(ws, callSid, streamSid, () => {
        if (!realtimeFailed && !callEnded) {
          console.warn('[stream] Realtime closed mid-call, switching to fallback STT/TTS');
          realtimeFailed = true;
          void playFallbackGreeting();
        }
      })
        .then(() => {
          console.log('[stream] OpenAI Realtime bridge active — realtime.ts handling audio');
        })
        .catch((err: Error) => {
          if (!callEnded) {
            console.warn(`[stream] Realtime unavailable (${err.message}), switching to fallback`);
            realtimeFailed = true;
            void playFallbackGreeting();
          }
        });
    }

    // ── Fallback turn processor ───────────────────────────────────────────────
    async function processUtterance(): Promise<void> {
      clearTurnTimers();
      if (processingFallback || mulawChunks.length === 0) return;
      processingFallback = true;

      const combined = Buffer.concat(mulawChunks);
      mulawChunks = [];
      turnStartAt = 0;

      const durationMs = (combined.length / 8000) * 1000;
      if (durationMs < MIN_AUDIO_MS) {
        console.log(`[stream] Skipping short clip (${durationMs.toFixed(0)}ms)`);
        processingFallback = false;
        return;
      }
      console.log(`[stream] Processing ${(durationMs / 1000).toFixed(1)}s utterance`);

      try {
        const wavBuf    = await mulawToWav(combined);
        const transcript = await transcribe(wavBuf);
        if (!transcript.trim()) {
          console.log('[stream] Empty transcript, skipping');
          processingFallback = false;
          return;
        }
        console.log(`[stream] Transcribed: "${transcript}"`);

        const reply = await sendToOpenClaw(transcript, agentId, modelOverride || undefined);
        if (!reply.trim()) { processingFallback = false; return; }
        console.log(`[stream] LLM reply: "${reply}"`);

        const ttsAudio  = await synthesize(reply);
        const mulawOut  = await audioToMulaw(ttsAudio, 'mp3');

        if (streamSid && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            event: 'media', streamSid,
            media: { payload: mulawOut.toString('base64') },
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
      } catch { return; }

      if (msg.event === 'connected') {
        // Connection-level event (fires before 'start')
        console.log('[stream] Twilio connected');

      } else if (msg.event === 'start') {
        const start = msg.start as Record<string, unknown>;
        callSid   = start.callSid as string;
        streamSid = start.streamSid as string;

        // Read per-call agent routing from customParameters
        const customParams = (start.customParameters ?? {}) as Record<string, string>;
        agentId        = customParams.agentId        || 'main';
        modelOverride  = customParams.model          || '';
        openingMessage = customParams.openingMessage || '';

        console.log(`[stream] Call started: CallSid=${callSid} StreamSid=${streamSid} agent=${agentId}`);
        tryRealtime();

      } else if (msg.event === 'media') {
        if (!realtimeFailed || processingFallback) return;

        const media = msg.media as Record<string, string>;
        const chunk = Buffer.from(media.payload, 'base64');
        mulawChunks.push(chunk);

        if (hasSpeech(chunk)) {
          const now = Date.now();
          lastSpeechAt = now;

          // Start the max-duration safety timer when speech first arrives
          if (turnStartAt === 0) {
            turnStartAt = now;
            maxTurnTimer = setTimeout(() => {
              console.log('[stream] Max turn length reached, processing');
              void processUtterance();
            }, MAX_TURN_MS);
          }

          // Reset the post-speech silence timer
          if (silenceTimer) clearTimeout(silenceTimer);
          silenceTimer = setTimeout(() => {
            console.log('[stream] Post-speech silence detected, processing turn');
            void processUtterance();
          }, SPEECH_SILENCE_MS);
        }
        // Silent chunks just accumulate without resetting timers

      } else if (msg.event === 'stop') {
        console.log(`[stream] Call ended: CallSid=${callSid}`);
        callEnded = true;
        clearTurnTimers();
        if (realtimeFailed && mulawChunks.length > 0) {
          void processUtterance();
        }
      }
    });

    ws.on('close', () => {
      console.log(`[stream] WebSocket closed: CallSid=${callSid}`);
      clearTurnTimers();
    });

    ws.on('error', (err) => {
      console.error(`[stream] WebSocket error (CallSid=${callSid}):`, err.message);
    });
  });
}
