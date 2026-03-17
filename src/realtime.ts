/**
 * OpenAI Realtime API bridge (primary voice path).
 *
 * Bridges Twilio Media Streams (8kHz µ-law) ↔ OpenAI Realtime (PCM16 24kHz).
 * Uses pure-JS mulaw codec — zero ffmpeg spawning per chunk.
 *
 * Returns a Promise that resolves when the OpenAI WebSocket is open and ready.
 * Rejects if the connection cannot be established.
 */

import WebSocket from 'ws';
import { mulawToPcm16, pcm16ToMulaw } from './mulaw';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const SYSTEM_PROMPT =
  "You are KleinClaw, Klein's AI assistant, answering a phone call. " +
  'Be helpful, concise, and direct. Keep voice responses to one or two sentences ' +
  'unless the caller asks for more detail. Start by greeting Klein when the call connects.';

export function createRealtimeBridge(twilioWs: WebSocket, callSid: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!OPENAI_API_KEY) {
      reject(new Error('OPENAI_API_KEY not set'));
      return;
    }

    const openaiWs = new WebSocket(
      'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01',
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'OpenAI-Beta': 'realtime=v1',
        },
      },
    );

    let streamSid: string | null = null;
    let resolved = false;

    // ── OpenAI WS open ───────────────────────────────────────────────────────
    openaiWs.on('open', () => {
      console.log(`[realtime] Connected to OpenAI Realtime for CallSid=${callSid}`);

      // Configure session
      openaiWs.send(JSON.stringify({
        type: 'session.update',
        session: {
          modalities: ['audio', 'text'],
          instructions: SYSTEM_PROMPT,
          voice: 'alloy',
          input_audio_format: 'pcm16',
          output_audio_format: 'pcm16',
          input_audio_transcription: { model: 'whisper-1' },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 500,
          },
        },
      }));

      // Trigger opening greeting
      openaiWs.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'The call just connected. Greet me.' }],
        },
      }));
      openaiWs.send(JSON.stringify({ type: 'response.create' }));

      if (!resolved) {
        resolved = true;
        resolve(); // signal stream.ts that bridge is ready
      }
    });

    openaiWs.on('error', (err) => {
      console.error('[realtime] OpenAI WS error:', err.message);
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });

    // ── OpenAI → Twilio (audio delta) ────────────────────────────────────────
    openaiWs.on('message', (raw) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        return;
      }

      if (msg.type === 'response.audio.delta' && typeof msg.delta === 'string') {
        // OpenAI sends PCM16 at 24kHz — convert to 8kHz µ-law for Twilio
        const pcmBuf = Buffer.from(msg.delta as string, 'base64');
        const mulawBuf = pcm16ToMulaw(pcmBuf, 24000);

        if (streamSid) {
          twilioWs.send(JSON.stringify({
            event: 'media',
            streamSid,
            media: { payload: mulawBuf.toString('base64') },
          }));
        }
      }
    });

    openaiWs.on('close', () => {
      console.log(`[realtime] OpenAI WS closed for CallSid=${callSid}`);
    });

    // ── Twilio → OpenAI (audio chunks) ───────────────────────────────────────
    twilioWs.on('message', (data) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString()) as Record<string, unknown>;
      } catch {
        return;
      }

      if (msg.event === 'start') {
        const start = msg.start as Record<string, string>;
        streamSid = start.streamSid;
        console.log(`[realtime] Stream started: ${streamSid}`);
      } else if (msg.event === 'media' && openaiWs.readyState === WebSocket.OPEN) {
        const media = msg.media as Record<string, string>;
        // Twilio sends 8kHz µ-law — decode + upsample to 24kHz PCM16
        const mulawBuf = Buffer.from(media.payload, 'base64');
        const pcmBuf = mulawToPcm16(mulawBuf, 24000);
        openaiWs.send(JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: pcmBuf.toString('base64'),
        }));
      } else if (msg.event === 'stop') {
        console.log(`[realtime] Twilio stream stopped for CallSid=${callSid}`);
        openaiWs.close();
      }
    });

    twilioWs.on('close', () => {
      console.log(`[realtime] Twilio WS closed for CallSid=${callSid}`);
      openaiWs.close();
    });
  });
}
