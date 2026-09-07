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
import twilio from 'twilio';

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN,
);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const SYSTEM_PROMPT =
  "You are KleinClaw, Klein's AI assistant, answering a phone call. " +
  'Be helpful, concise, and direct. Keep voice responses to one or two sentences ' +
  'unless the caller asks for more detail. Start by greeting Klein when the call connects.';

/**
 * Returns a Promise that resolves when the OpenAI WS is open and ready.
 * The optional onClosed callback fires when OpenAI WS closes mid-call
 * (e.g. quota error) so stream.ts can activate the fallback path.
 */
export function createRealtimeBridge(
  twilioWs: WebSocket, callSid: string, initialStreamSid: string,
  onClosed?: () => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!OPENAI_API_KEY) {
      reject(new Error('OPENAI_API_KEY not set'));
      return;
    }

    const openaiWs = new WebSocket(
      'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17',
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'OpenAI-Beta': 'realtime=v1',
        },
      },
    );

    let streamSid: string | null = initialStreamSid || null;
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
          input_audio_format: 'g711_ulaw',   // Twilio native — zero conversion needed
          output_audio_format: 'g711_ulaw',  // Twilio native — zero conversion needed
          input_audio_transcription: { model: 'whisper-1' },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 500,
          },
          tools: [
            {
              type: 'function',
              name: 'hang_up',
              description: 'End the phone call. Use this when the conversation is naturally over — user says bye, take care, thanks, goodbye, etc.',
              parameters: { type: 'object', properties: {} },
            },
          ],
          tool_choice: 'auto',
        },
      }));

      // Trigger opening greeting — explicitly request audio output
      openaiWs.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'The call just connected. Greet me.' }],
        },
      }));
      openaiWs.send(JSON.stringify({
        type: 'response.create',
        response: { modalities: ['text', 'audio'] },
      }));

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

      // Log all non-audio events for debugging
      if (msg.type !== 'response.audio.delta') {
        const extra = (msg.type === 'error' || msg.type === 'response.done')
          ? JSON.stringify(msg).slice(0, 300) : '';
        console.log(`[realtime] OpenAI event: ${msg.type as string}`, extra);

        // Fatal quota/auth errors — signal caller to fall back
        if (msg.type === 'response.done') {
          const resp = msg.response as Record<string, unknown> | undefined;
          const errCode = (resp?.status_details as Record<string, unknown> | undefined)
            ?.error as Record<string, string> | undefined;
          if (resp?.status === 'failed' && errCode?.code === 'insufficient_quota') {
            console.warn('[realtime] Insufficient quota — closing and falling back to STT/TTS path');
            openaiWs.close();
          }
        }
      }

      if (msg.type === 'response.audio.delta' && typeof msg.delta === 'string') {
        // OpenAI sends g711_ulaw — forward directly to Twilio, zero conversion
        if (streamSid && twilioWs.readyState === WebSocket.OPEN) {
          twilioWs.send(JSON.stringify({
            event: 'media',
            streamSid,
            media: { payload: msg.delta },
          }));
        }
      }

      // ── hang_up function call ────────────────────────────────────────────
      if (msg.type === 'response.output_item.done') {
        const item = msg.item as Record<string, unknown> | undefined;
        if (item?.type === 'function_call' && item?.name === 'hang_up') {
          console.log(`[realtime] AI requested hang_up for CallSid=${callSid}`);
          // Submit function result so OpenAI knows it's done
          openaiWs.send(JSON.stringify({
            type: 'conversation.item.create',
            item: { type: 'function_call_output', call_id: item.call_id, output: 'call_ended' },
          }));
          // End the call via Twilio REST API
          twilioClient.calls(callSid).update({ status: 'completed' })
            .then(() => console.log(`[realtime] Call ${callSid} ended via hang_up`))
            .catch((e: Error) => console.error('[realtime] hang_up REST error:', e.message));
        }
      }
    });

    openaiWs.on('close', () => {
      console.log(`[realtime] OpenAI WS closed for CallSid=${callSid}`);
      onClosed?.();
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
        // Twilio sends g711_ulaw — forward directly to OpenAI, zero conversion
        openaiWs.send(JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: media.payload,   // already base64 g711_ulaw
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
