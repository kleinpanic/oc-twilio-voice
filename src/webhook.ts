import { Request, Response } from 'express';
import crypto from 'crypto';

const ALLOWED_CALLERS = (process.env.ALLOWED_CALLERS || '').split(',').map(n => n.trim());
const PUBLIC_URL_HOST = process.env.PUBLIC_URL_HOST || 'localhost';

export function handleWebhook(req: Request, res: Response) {
  const { From, To, CallSid, CallStatus } = req.body;
  console.log(`[webhook] Incoming call: From=${From}, To=${To}, Sid=${CallSid}, Status=${CallStatus}`);

  // Allowlist check
  if (!ALLOWED_CALLERS.includes(From)) {
    console.warn(`[webhook] Blocking unauthorized caller: ${From}`);
    res.type('text/xml');
    res.send('<?xml version="1.0" encoding="UTF-8"?><Response><Reject/></Response>');
    return;
  }

  const streamToken = crypto.randomUUID();
  console.log(`[webhook] Allowed caller: ${From}. Connecting to stream with token: ${streamToken}`);

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${PUBLIC_URL_HOST}/voice/stream">
      <Parameter name="token" value="${streamToken}" />
    </Stream>
  </Connect>
</Response>`;

  res.type('text/xml');
  res.send(twiml);
}
