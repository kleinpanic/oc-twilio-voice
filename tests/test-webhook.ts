#!/usr/bin/env ts-node
/**
 * Test 1: Webhook handler
 * Simulates Twilio POST requests and checks TwiML responses.
 * No actual call needed.
 */

import * as dotenv from 'dotenv';
dotenv.config();

// Minimal mock req/res
function mockReqRes(body: Record<string, string>, query: Record<string, string> = {}) {
  let sentBody = '';
  let sentType = '';
  const res = {
    type: (t: string) => { sentType = t; return res; },
    send: (b: string) => { sentBody = b; },
    status: (code: number) => { console.log(`  status: ${code}`); return res; },
    json: (b: unknown) => { sentBody = JSON.stringify(b); },
  };
  return { req: { body, query }, res, getSent: () => ({ body: sentBody, type: sentType }) };
}

// Dynamically import compiled webhook
async function run() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
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
    const pass = body.includes('<Connect>') && body.includes('<Stream') && body.includes('/voice/stream');
    console.log(`[${pass ? 'PASS' : 'FAIL'}] Allowed caller gets Stream TwiML`);
    if (!pass) console.log('  Got:', body.slice(0, 200));
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
    const pass = body.includes('<Reject') || body.includes('<Reject/>');
    console.log(`[${pass ? 'PASS' : 'FAIL'}] Unknown caller gets Reject TwiML`);
    if (!pass) console.log('  Got:', body.slice(0, 200));
  }

  // Test 3: Outbound call answer with agent routing
  {
    const { req, res, getSent } = mockReqRes(
      { From: '+12673184436', To: '+12673479614', CallSid: 'CAtest003', CallStatus: 'in-progress' },
      { agentId: 'dev', openingMessage: 'Hey Klein, calling about the PR' },
    );
    handleWebhook(req as never, res as never);
    const { body } = getSent();
    const pass = body.includes('<Stream') && body.includes('agentId') && body.includes('dev');
    console.log(`[${pass ? 'PASS' : 'FAIL'}] Outbound call gets dev agent params in TwiML`);
    if (!pass) console.log('  Got:', body.slice(0, 300));
  }

  console.log('\nDone.\n');
}

run().catch(console.error);
