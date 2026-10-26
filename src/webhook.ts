/**
 * Twilio webhook handler.
 * Responds to inbound calls and outbound call-answer events.
 * Passes agentId / model / openingMessage through to the Stream as <Parameter>s
 * so stream.ts can route each call to the right agent LLM.
 */

import { Request, Response } from 'express';
import twilio from 'twilio';
import { escapeXml, issueStreamToken, parseAllowlist } from './security.js';

const ALLOWED_CALLERS = parseAllowlist(process.env.ALLOWED_CALLERS);
const PUBLIC_URL_HOST = process.env.PUBLIC_URL_HOST ?? 'localhost';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN ?? '';
const SKIP_SIGNATURE_VERIFICATION = process.env.TWILIO_SKIP_SIGNATURE_VERIFICATION === 'true';

const REJECT_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response><Reject/></Response>';

function hasValidTwilioSignature(req: Request): boolean {
  if (SKIP_SIGNATURE_VERIFICATION) return true;
  const signature = req.header('X-Twilio-Signature');
  if (!TWILIO_AUTH_TOKEN || !signature) return false;
  // Twilio signs the full public URL it requested, including the query string.
  const url = `https://${PUBLIC_URL_HOST}${req.originalUrl}`;
  return twilio.validateRequest(TWILIO_AUTH_TOKEN, signature, url, req.body ?? {});
}

function queryString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function handleWebhook(req: Request, res: Response) {
  if (!hasValidTwilioSignature(req)) {
    console.warn('[webhook] Rejecting request with missing/invalid Twilio signature');
    res.status(403).type('text/plain').send('Forbidden');
    return;
  }

  const { From, To, CallSid, CallStatus } = (req.body ?? {}) as Record<string, string>;
  console.log(`[webhook] Incoming call: From=${From}, To=${To}, Sid=${CallSid}, Status=${CallStatus}`);

  // For outbound calls, From will be our Twilio number and To will be Klein's number.
  // Allow if either direction involves an allowlisted number.
  const callerAllowed = ALLOWED_CALLERS.includes(From) || ALLOWED_CALLERS.includes(To);
  if (!callerAllowed || typeof CallSid !== 'string' || !CallSid) {
    console.warn(`[webhook] Blocking unauthorized caller: ${From}`);
    res.type('text/xml');
    res.send(REJECT_TWIML);
    return;
  }

  // Read agent routing from URL query params (set by outbound.ts)
  // Inbound calls don't have these → defaults to main/standard
  const agentId        = queryString(req.query.agentId) || 'main';
  const model          = queryString(req.query.model);
  const openingMessage = queryString(req.query.openingMessage);

  const streamToken = issueStreamToken(CallSid);
  console.log(`[webhook] Routing call ${CallSid} → agent=${agentId}${model ? ` model=${model}` : ''}`);

  // Build <Parameter> elements to pass context through the WebSocket stream
  const params = [
    `<Parameter name="token"   value="${escapeXml(streamToken)}" />`,
    `<Parameter name="agentId" value="${escapeXml(agentId)}" />`,
    model          ? `<Parameter name="model"          value="${escapeXml(model)}" />`          : '',
    openingMessage ? `<Parameter name="openingMessage" value="${escapeXml(openingMessage)}" />` : '',
  ].filter(Boolean).join('\n      ');

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${escapeXml(PUBLIC_URL_HOST)}/voice/stream">
      ${params}
    </Stream>
  </Connect>
</Response>`;

  res.type('text/xml');
  res.send(twiml);
}
