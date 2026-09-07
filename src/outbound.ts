/**
 * Outbound call initiator.
 * Called by agents via POST /call or the oc-voice-call CLI.
 */

import twilio from 'twilio';

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID ?? '';
const TWILIO_AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN  ?? '';
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER ?? '';
const PUBLIC_URL_HOST    = process.env.PUBLIC_URL_HOST    ?? 'localhost';
const ALLOWED_CALLERS    = (process.env.ALLOWED_CALLERS   ?? '').split(',').map(n => n.trim());

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

export interface CallOptions {
  to:              string;
  agentId?:        string;   // which agent backs this call (main, dev, school…)
  model?:          string;   // LLM model override (openrouter model string)
  openingMessage?: string;   // first thing the AI says when call answers
}

export interface CallResult {
  callSid: string;
  agentId: string;
}

export async function initiateOutboundCall(opts: CallOptions): Promise<CallResult> {
  const { to, agentId = 'main', model, openingMessage } = opts;

  if (!ALLOWED_CALLERS.includes(to)) {
    throw new Error(`Unauthorized call target: ${to}. Only allowlisted numbers may be called.`);
  }

  // Build webhook URL with call context as query params
  const params = new URLSearchParams({ agentId });
  if (model)          params.set('model',          model);
  if (openingMessage) params.set('openingMessage', openingMessage);

  const webhookUrl = `https://${PUBLIC_URL_HOST}/voice/webhook?${params.toString()}`;
  console.log(`[outbound] Calling ${to} as agent=${agentId}, webhook=${webhookUrl}`);

  const call = await client.calls.create({
    to,
    from: TWILIO_FROM_NUMBER,
    url:  webhookUrl,
  });

  console.log(`[outbound] Call SID: ${call.sid}`);
  return { callSid: call.sid, agentId };
}
