/**
 * LLM client for the fallback STT→LLM→TTS path.
 *
 * Uses OpenAI Chat API directly (synchronous response) instead of routing
 * through OpenClaw hooks (which is async and won't return a reply in-band).
 *
 * The primary path (OpenAI Realtime) handles LLM natively — this is only
 * used when Realtime is unavailable.
 */

import axios from 'axios';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? '';
const FALLBACK_MODEL = 'gpt-4o-mini';

const SYSTEM_PROMPT =
  "You are KleinClaw, Klein's AI assistant, answering a phone call. " +
  'Be helpful, concise, and direct. Keep responses to one or two sentences ' +
  'unless asked for more detail.';

export async function sendToOpenClaw(text: string): Promise<string> {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY not set — cannot generate fallback response');
  }

  const response = await axios.post(
    'https://api.openai.com/v1/chat/completions',
    {
      model: FALLBACK_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: text },
      ],
      max_tokens: 150,
      temperature: 0.7,
    },
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 10_000,
    },
  );

  const reply: string = response.data?.choices?.[0]?.message?.content ?? '';
  if (!reply) {
    throw new Error('OpenAI returned empty response for fallback LLM call');
  }

  console.log(`[gateway] Fallback LLM response: "${reply.slice(0, 100)}${reply.length > 100 ? '…' : ''}"`);
  return reply;
}
