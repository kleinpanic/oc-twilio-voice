#!/usr/bin/env tsx
/**
 * Test 1: Webhook handler
 * Simulates Twilio POST requests and checks TwiML responses.
 * No actual call needed. Env is set here so the test is hermetic.
 */

process.env.ALLOWED_CALLERS = '+12673479614';
process.env.PUBLIC_URL_HOST = 'voice.example.com';
process.env.TWILIO_AUTH_TOKEN = 'test-auth-token-not-a-real-secret';
delete process.env.TWILIO_SKIP_SIGNATURE_VERIFICATION;

import twilio from 'twilio';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`[PASS] ${label}`);
  } else {
    failures++;
    console.log(`[FAIL] ${label}${detail ? ': ' + detail : ''}`);
  }
}

// Minimal mock req/res. Signs the request like Twilio unless told otherwise.
function mockReqRes(
  body: Record<string, string>,
  query: Record<string, unknown> = {},
  opts: { signature?: string | null } = {},
) {
  let sentBody = '';
  let sentType = '';
  let sentStatus = 200;
  const qs = new URLSearchParams(query as Record<string, string>).toString();
  const originalUrl = `/voice/webhook${qs ? `?${qs}` : ''}`;
  const signature = opts.signature === undefined
    ? twilio.getExpectedTwilioSignature(
        process.env.TWILIO_AUTH_TOKEN!,
        `https://${process.env.PUBLIC_URL_HOST}${originalUrl}`,
        body,
      )
    : opts.signature;
  const res = {
    type: (t: string) => { sentType = t; return res; },
    send: (b: string) => { sentBody = b; return res; },
    status: (code: number) => { sentStatus = code; return res; },
    json: (b: unknown) => { sentBody = JSON.stringify(b); return res; },
  };
  const req = {
    body,
    query,
    originalUrl,
    header: (name: string) => (name.toLowerCase() === 'x-twilio-signature' ? signature ?? undefined : undefined),
  };
  return { req, res, getSent: () => ({ body: sentBody, type: sentType, status: sentStatus }) };
}

async function run() {
  const { handleWebhook } = await import('../src/webhook.js') as { handleWebhook: (req: unknown, res: unknown) => void };

  console.log('\n=== Webhook Tests ===\n');

  // Test 1: Allowed caller
  {
    const { req, res, getSent } = mockReqRes({
      From: '+12673479614',
      To: '+12673184436',
      CallSid: 'CAtest001',
      CallStatus: 'ringing',
    });
    handleWebhook(req as never, res as never);
    const { body } = getSent();
    check(
      'Allowed caller gets Stream TwiML',
      body.includes('<Connect>') && body.includes('<Stream') && body.includes('/voice/stream'),
      body.slice(0, 200),
    );
  }

  // Test 2: Blocked caller
  {
    const { req, res, getSent } = mockReqRes({
      From: '+19995550000',
      To: '+12673184436',
      CallSid: 'CAtest002',
      CallStatus: 'ringing',
    });
    handleWebhook(req as never, res as never);
    const { body } = getSent();
    check('Unknown caller gets Reject TwiML', body.includes('<Reject/>'), body.slice(0, 200));
  }

  // Test 3: Outbound call answer with agent routing
  {
    const { req, res, getSent } = mockReqRes(
      { From: '+12673184436', To: '+12673479614', CallSid: 'CAtest003', CallStatus: 'in-progress' },
      { agentId: 'dev', openingMessage: 'Hey Klein, calling about the PR' },
    );
    handleWebhook(req as never, res as never);
    const { body } = getSent();
    check(
      'Outbound call gets dev agent params in TwiML',
      body.includes('<Stream') && body.includes('name="agentId" value="dev"'),
      body.slice(0, 300),
    );
  }

  // Test 4: Missing Twilio signature is rejected
  {
    const { req, res, getSent } = mockReqRes(
      { From: '+12673479614', To: '+12673184436', CallSid: 'CAtest004', CallStatus: 'ringing' },
      {},
      { signature: null },
    );
    handleWebhook(req as never, res as never);
    const { body, status } = getSent();
    check('Unsigned request is rejected with 403', status === 403 && !body.includes('<Stream'), `${status} ${body}`);
  }

  // Test 5: Forged Twilio signature is rejected
  {
    const { req, res, getSent } = mockReqRes(
      { From: '+12673479614', To: '+12673184436', CallSid: 'CAtest005', CallStatus: 'ringing' },
      {},
      { signature: 'Zm9yZ2VkLXNpZ25hdHVyZQ==' },
    );
    handleWebhook(req as never, res as never);
    const { status } = getSent();
    check('Forged signature is rejected with 403', status === 403, String(status));
  }

  // Test 6: Query params cannot inject TwiML
  {
    const evil = '"/><Dial>+15555550123</Dial><Parameter name="x" value="';
    const { req, res, getSent } = mockReqRes(
      { From: '+12673184436', To: '+12673479614', CallSid: 'CAtest006', CallStatus: 'in-progress' },
      { agentId: evil, model: evil, openingMessage: 'Tom & Jerry <3' },
    );
    handleWebhook(req as never, res as never);
    const { body } = getSent();
    check('agentId/model are XML-escaped (no injected <Dial>)', !body.includes('<Dial>'), body);
    check(
      'openingMessage is XML-escaped',
      body.includes('value="Tom &amp; Jerry &lt;3"'),
      body,
    );
  }

  // Test 7: Repeated query params (arrays) fall back to defaults
  {
    const { req, res, getSent } = mockReqRes(
      { From: '+12673184436', To: '+12673479614', CallSid: 'CAtest007', CallStatus: 'in-progress' },
      {},
    );
    (req as { query: Record<string, unknown> }).query = { agentId: ['a', 'b'] };
    handleWebhook(req as never, res as never);
    const { body } = getSent();
    check('Non-string agentId falls back to main', body.includes('name="agentId" value="main"'), body);
  }

  // Test 8: Blank ALLOWED_CALLERS entries do not allow empty From/To
  {
    process.env.ALLOWED_CALLERS = '+12673479614,';
    // Fresh load so the module-level allowlist picks up the new env.
    delete require.cache[require.resolve('../src/webhook')];
    const mod = require('../src/webhook') as { handleWebhook: (req: unknown, res: unknown) => void };
    process.env.ALLOWED_CALLERS = '+12673479614';
    const { req, res, getSent } = mockReqRes({ From: '', To: '', CallSid: 'CAtest008', CallStatus: 'ringing' });
    mod.handleWebhook(req as never, res as never);
    const { body } = getSent();
    check('Empty From/To is rejected even with a trailing comma in ALLOWED_CALLERS', body.includes('<Reject/>'), body);
  }

  console.log(`\n=== Done (${failures} failure${failures === 1 ? '' : 's'}) ===\n`);
  if (failures > 0) process.exit(1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
