#!/usr/bin/env tsx
/**
 * Regression tests for the /call endpoint, the Media Streams WebSocket and
 * the fallback speech detector. Hermetic: no network beyond localhost.
 */

delete process.env.OPENAI_API_KEY;
// Keep the fallback greeting off the network when a test stream authorizes.
process.env.SPARK_TTS_URL = 'http://127.0.0.1:1/v1/audio/speech';
delete process.env.ELEVENLABS_API_KEY;

import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import WebSocket, { WebSocketServer } from 'ws';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`[PASS] ${label}`);
  } else {
    failures++;
    console.log(`[FAIL] ${label}${detail ? ': ' + detail : ''}`);
  }
}

function mockRes() {
  const out = { status: 200, body: undefined as unknown };
  const res = {
    status: (code: number) => { out.status = code; return res; },
    json: (b: unknown) => { out.body = b; return res; },
  };
  return { res, out };
}

async function testCallHandler(): Promise<void> {
  const { createCallHandler } = await import('../src/call-api.js');
  const calls: unknown[] = [];
  const initiate = async (opts: unknown) => { calls.push(opts); return { callSid: 'CA1', agentId: 'main' }; };
  const body = { to: '+15555550100' };

  {
    const { res, out } = mockRes();
    await createCallHandler('', initiate)({ headers: {}, body } as never, res as never);
    check('/call is refused when no API token is configured', out.status === 503 && calls.length === 0, String(out.status));
  }
  {
    const { res, out } = mockRes();
    await createCallHandler('secret', initiate)({ headers: { authorization: 'Bearer wrong' }, body } as never, res as never);
    check('/call rejects a wrong bearer token', out.status === 401 && calls.length === 0, String(out.status));
  }
  {
    const { res, out } = mockRes();
    await createCallHandler('secret', initiate)({ headers: {}, body } as never, res as never);
    check('/call rejects a missing bearer token', out.status === 401 && calls.length === 0, String(out.status));
  }
  {
    const { res, out } = mockRes();
    await createCallHandler('secret', initiate)(
      { headers: { authorization: 'Bearer secret' }, body: { to: ['+15555550100'] } } as never, res as never);
    check('/call rejects a non-string "to"', out.status === 400 && calls.length === 0, String(out.status));
  }
  {
    const { res, out } = mockRes();
    await createCallHandler('secret', initiate)(
      { headers: { authorization: 'Bearer secret' }, body: { to: '+15555550100', openingMessage: { x: 1 } } } as never, res as never);
    check('/call rejects a non-string optional field', out.status === 400 && calls.length === 0, String(out.status));
  }
  {
    const { res, out } = mockRes();
    await createCallHandler('secret', initiate)(
      { headers: { authorization: 'Bearer secret' }, body: { to: '+15555550100', agentId: 'dev', extra: 'x' } } as never, res as never);
    check('/call accepts a valid request', out.status === 200 && calls.length === 1, JSON.stringify(out));
    check(
      '/call forwards only known fields',
      JSON.stringify(calls[0]) === JSON.stringify({ to: '+15555550100', agentId: 'dev' }),
      JSON.stringify(calls[0]),
    );
  }
}

async function testStreamTokens(): Promise<void> {
  const { issueStreamToken, consumeStreamToken, parseAllowlist } = await import('../src/security.js');

  const t1 = issueStreamToken('CA100');
  check('stream token is rejected for a different CallSid', !consumeStreamToken(t1, 'CA999'));
  check('stream token is single-use', !consumeStreamToken(t1, 'CA100'));

  const t2 = issueStreamToken('CA200');
  check('stream token is accepted for its CallSid', consumeStreamToken(t2, 'CA200'));

  const t3 = issueStreamToken('CA300', Date.now() - 10 * 60 * 1000);
  check('expired stream token is rejected', !consumeStreamToken(t3, 'CA300'));
  check('unknown/absent token is rejected', !consumeStreamToken(undefined, 'CA300') && !consumeStreamToken('nope', 'CA300'));

  check('parseAllowlist drops blank entries', JSON.stringify(parseAllowlist(' +1, ,+2,')) === '["+1","+2"]');
  check('parseAllowlist of unset env is empty', parseAllowlist(undefined).length === 0);
}

async function testStreamSocket(): Promise<void> {
  const { handleStream } = await import('../src/stream.js');
  const { issueStreamToken } = await import('../src/security.js');
  const server = http.createServer();
  const wss = new WebSocketServer({ server, path: '/voice/stream' });
  handleStream(wss, 300);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;

  let uncaught: unknown = null;
  const onUncaught = (e: unknown) => { uncaught = e; };
  process.on('uncaughtException', onUncaught);

  const connect = () => new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/voice/stream`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
  const closeCode = (ws: WebSocket, ms = 1000) => new Promise<number | null>((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    ws.on('close', (code) => { clearTimeout(t); resolve(code); });
  });

  try {
    // Malformed frames must not crash the process
    {
      const ws = await connect();
      ws.send(JSON.stringify({ event: 'start' }));
      ws.send(JSON.stringify({ event: 'media' }));
      ws.send(JSON.stringify({ event: 'media', media: {} }));
      const code = await closeCode(ws);
      check('malformed start/media frames do not crash the server', uncaught === null, String(uncaught));
      check('malformed start is closed as unauthorized', code === 1008, String(code));
    }

    // A start event without a webhook-issued token is rejected
    {
      const ws = await connect();
      ws.send(JSON.stringify({
        event: 'start',
        start: { callSid: 'CAforged', streamSid: 'MZ1', customParameters: { token: 'made-up', agentId: 'main' } },
      }));
      const code = await closeCode(ws);
      check('stream with an unknown token is closed with 1008', code === 1008, String(code));
    }

    // A socket that never sends `start` is closed once the auth deadline passes
    {
      const ws = await connect();
      ws.send(JSON.stringify({ event: 'connected' }));
      const code = await closeCode(ws);
      check('stream that never authorizes is closed with 1008', code === 1008, String(code));
    }

    // An authorized stream is not closed by the auth deadline
    {
      const token = issueStreamToken('CAauthorized');
      const ws = await connect();
      ws.send(JSON.stringify({
        event: 'start',
        start: { callSid: 'CAauthorized', streamSid: 'MZ2', customParameters: { token } },
      }));
      const code = await closeCode(ws, 600);
      check('authorized stream stays open past the auth deadline', code === null, String(code));
      ws.close();
    }
  } finally {
    process.off('uncaughtException', onUncaught);
    wss.close();
    server.close();
  }
}

async function testHasSpeech(): Promise<void> {
  const { hasSpeech } = await import('../src/stream.js');
  check('µ-law negative-zero silence (0x7F) is not speech', !hasSpeech(Buffer.alloc(160, 0x7f)));
  check('µ-law positive-zero silence (0xFF) is not speech', !hasSpeech(Buffer.alloc(160, 0xff)));
  check('loud negative samples are speech', hasSpeech(Buffer.alloc(160, 0x10)));
  check('loud positive samples are speech', hasSpeech(Buffer.alloc(160, 0x90)));
  check('empty chunk is not speech', !hasSpeech(Buffer.alloc(0)));
}

function testEnvExample(): void {
  const example = fs.readFileSync(path.join(__dirname, '../.env.example'), 'utf8');
  const srcDir = path.join(__dirname, '../src');
  const src = fs.readdirSync(srcDir).map((f) => fs.readFileSync(path.join(srcDir, f), 'utf8')).join('\n');
  const keys = example.split('\n').map((l) => l.split('=')[0]!.trim()).filter((k) => k && !k.startsWith('#'));
  const required = ['PUBLIC_URL_HOST', 'TWILIO_AUTH_TOKEN', 'ALLOWED_CALLERS', 'CALL_API_TOKEN'];
  const missing = required.filter((k) => !keys.includes(k) || !src.includes(`process.env.${k}`));
  check('.env.example defines the keys the service reads', missing.length === 0, missing.join(', '));
  check('.env.example has no unread PUBLIC_URL key', !keys.includes('PUBLIC_URL') && !src.includes('process.env.PUBLIC_URL)'));
  check(
    '.env.example does not disable Twilio signature verification by default',
    !/^TWILIO_SKIP_SIGNATURE_VERIFICATION=true/m.test(example),
  );
}

async function run(): Promise<void> {
  console.log('\n=== Security / Input Tests ===\n');
  await testCallHandler();
  await testStreamTokens();
  await testStreamSocket();
  await testHasSpeech();
  testEnvExample();
  console.log(`\n=== Done (${failures} failure${failures === 1 ? '' : 's'}) ===\n`);
  process.exit(failures > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
