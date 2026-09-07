/**
 * Twilio webhook handler.
 * Responds to inbound calls and outbound call-answer events.
 * Passes agentId / model / openingMessage through to the Stream as <Parameter>s
 * so stream.ts can route each call to the right agent LLM.
 */

import { Request, Response } from 'express';
import crypto from 'crypto';

const ALLOWED_CALLERS = (process.env.ALLOWED_CALLERS ?? '').split(',').map(n => n.trim());
const PUBLIC_URL_HOST = process.env.PUBLIC_URL_HOST ?? 'localhost';

export function handleWebhook(req: Request, res: Response) {
  const { From, To, CallSid, CallStatus } = req.body as Record<string, string>;
  console.log(`[webhook] Incoming call: From=${From}, To=${To}, Sid=${CallSid}, Status=${CallStatus}`);

  // For outbound calls, From will be our Twilio number and To will be Klein's number.
  // Allow if either direction involves an allowlisted number.
  const callerAllowed = ALLOWED_CALLERS.includes(From) || ALLOWED_CALLERS.includes(To);
  if (!callerAllowed) {
    console.warn(`[webhook] Blocking unauthorized caller: ${From}`);
    res.type('text/xml');
    res.send('<?xml version="1.0" encoding="UTF-8"?><Response><Reject/></Response>');
    return;
  }

  // Read agent routing from URL query params (set by outbound.ts)
  // Inbound calls don't have these → defaults to main/standard
  const query = req.query as Record<string, string>;
  const agentId        = query.agentId        ?? 'main';
  const model          = query.model          ?? '';
  const openingMessage = query.openingMessage ?? '';

  const streamToken = crypto.randomUUID();
  console.log(`[webhook] Routing call ${CallSid} → agent=${agentId}${model ? ` model=${model}` : ''}`);

  // Build <Parameter> elements to pass context through the WebSocket stream
  const params = [
    `<Parameter name="token"   value="${streamToken}" />`,
    `<Parameter name="agentId" value="${agentId}" />`,
    model          ? `<Parameter name="model"          value="${model}" />`          : '',
    openingMessage ? `<Parameter name="openingMessage" value="${openingMessage.replace(/"/g, '&quot;')}" />` : '',
  ].filter(Boolean).join('\n      ');

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${PUBLIC_URL_HOST}/voice/stream">
      ${params}
    </Stream>
  </Connect>
</Response>`;

  res.type('text/xml');
  res.send(twiml);
}
