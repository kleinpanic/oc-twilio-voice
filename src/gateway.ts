/**
 * LLM client for the fallback STT→LLM→TTS path.
 *
 * Routes through the local Spark OpenAI-compatible chat-completions endpoint
 * (same SPARK_* env + Bearer-token convention as src/stt.ts and src/tts.ts),
 * keeping voice inference local-first. Each agent gets its own system prompt
 * and default model.
 *
 * The primary path (OpenAI Realtime) handles LLM natively. This is only used
 * when Realtime is unavailable. OpenRouter is intentionally NOT used here:
 * it is a locked-forbidden default/fallback provider for this install.
 */

import axios from 'axios';

const SPARK_API_KEY = process.env.SPARK_API_KEY ?? '';
const SPARK_LLM_URL =
  process.env.SPARK_LLM_URL ?? 'http://dgx-spark.local:18091/v1/chat/completions';

// Default fallback model id — local Spark-served, overridable via env.
const DEFAULT_FALLBACK_MODEL = process.env.VOICE_FALLBACK_MODEL ?? 'spark/llm';

// Per-agent voice personas.
// Any agent not listed falls back to 'main'.
const AGENT_CONFIGS: Record<string, { model: string; systemPrompt: string }> = {
  main: {
    model: DEFAULT_FALLBACK_MODEL,
    systemPrompt:
      "You are KleinClaw, Klein's primary AI assistant, taking a phone call from Klein. " +
      'Be helpful, direct, and concise — 1-2 sentences unless asked for more. ' +
      "You coordinate Klein's entire AI system: email, calendar, tasks, agents. " +
      "Speak naturally like you're on a phone call.",
  },
  dev: {
    model: DEFAULT_FALLBACK_MODEL,
    systemPrompt:
      "You are dev, Klein's senior software engineer AI agent, on a phone call with Klein. " +
      'Speak like a peer engineer — direct, technical, and concise. ' +
      'Focus on code, architecture, and implementation details. ' +
      "Keep replies to 1-2 sentences unless Klein asks for more.",
  },
  school: {
    model: DEFAULT_FALLBACK_MODEL,
    systemPrompt:
      "You are Cortex, Klein's academic AI agent, on a phone call with Klein. " +
      'You help with coursework, assignments, Canvas, and study plans at Virginia Tech. ' +
      'Be helpful and encouraging. Keep replies brief for a phone call.',
  },
  research: {
    model: DEFAULT_FALLBACK_MODEL,
    systemPrompt:
      "You are a research agent on a phone call with Klein. " +
      'You specialize in deep research, synthesis, and analysis. ' +
      'Keep phone call responses brief — offer to send detailed findings in chat.',
  },
  immune: {
    model: DEFAULT_FALLBACK_MODEL,
    systemPrompt:
      "You are immune, Klein's system health and security AI agent, on a phone call with Klein. " +
      'Focus on infrastructure health, security issues, and system status. ' +
      'Be direct and technical. Keep replies brief.',
  },
};

function getAgentConfig(agentId: string, modelOverride?: string): { model: string; systemPrompt: string } {
  const config = AGENT_CONFIGS[agentId] ?? AGENT_CONFIGS.main!;
  return {
    model:        modelOverride || config.model,
    systemPrompt: config.systemPrompt,
  };
}

export async function sendToOpenClaw(
  text:          string,
  agentId:       string = 'main',
  modelOverride?: string,
): Promise<string> {
  if (!SPARK_API_KEY) {
    throw new Error('SPARK_API_KEY not set — cannot generate fallback response');
  }

  const { model, systemPrompt } = getAgentConfig(agentId, modelOverride);

  const response = await axios.post(
    SPARK_LLM_URL,
    {
      model,
      messages: [
        { role: 'system',    content: systemPrompt },
        { role: 'user',      content: text },
      ],
      max_tokens:  150,
      temperature: 0.7,
    },
    {
      headers: {
        Authorization:  `Bearer ${SPARK_API_KEY}`,
        'Content-Type': 'application/json',
      },
    },
  );

  const reply: string = response.data?.choices?.[0]?.message?.content ?? '';
  if (!reply) throw new Error('Spark LLM returned empty response');

  console.log(`[gateway] agent=${agentId} model=${model}: "${reply.slice(0, 100)}${reply.length > 100 ? '…' : ''}"`);
  return reply;
}
