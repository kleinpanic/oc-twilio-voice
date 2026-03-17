import twilio from 'twilio';

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER;
const PUBLIC_URL_HOST = process.env.PUBLIC_URL_HOST || 'localhost';
const ALLOWED_CALLERS = (process.env.ALLOWED_CALLERS || '').split(',').map(n => n.trim());

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

export async function initiateOutboundCall(to: string) {
  if (!ALLOWED_CALLERS.includes(to)) {
    throw new Error(`Unauthorized outbound call target: ${to}`);
  }

  console.log(`[outbound] Initiating call to ${to} from ${TWILIO_FROM_NUMBER}`);

  const call = await client.calls.create({
    to,
    from: TWILIO_FROM_NUMBER!,
    twiml: `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${PUBLIC_URL_HOST}/voice/stream" />
  </Connect>
</Response>`,
  });

  console.log(`[outbound] Call created: ${call.sid}`);
  return call.sid;
}
