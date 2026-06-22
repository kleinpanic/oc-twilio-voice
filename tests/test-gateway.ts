#!/usr/bin/env tsx
/**
 * Behaviour tests for the fallback LLM gateway (src/gateway.ts).
 *
 * Asserts the post-Phase-39 behaviour:
 *   - No OpenRouter URL and no dead `google/gemini-3-flash-preview` model id.
 *   - Fallback routes through the local Spark OpenAI-compatible LLM endpoint.
 *   - Auth reads SPARK_API_KEY (NOT OPENROUTER_API_KEY).
 *   - modelOverride > per-agent model > main default precedence is preserved.
 *
 * Style mirrors tests/test-pipeline.ts: tsx, no framework, [PASS]/[FAIL] lines.
 * axios is mocked so the test never makes a real network call and never needs
 * a live Spark endpoint. Secret values are never printed.
 */

import * as dotenv from 'dotenv';
dotenv.config();
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`[PASS] ${label}`);
  } else {
    failures++;
    console.log(`[FAIL] ${label}${detail ? ': ' + detail : ''}`);
  }
}

async function run(): Promise<void> {
  console.log('\n=== Gateway (fallback LLM) Tests ===\n');

  const gatewaySrc = fs.readFileSync(
    path.join(__dirname, '../src/gateway.ts'),
    'utf8',
  );

  // ── Test 1: source is OpenRouter-free and dead-model-free ─────────────────
  check(
    'gateway.ts contains no openrouter.ai URL',
    !/openrouter\.ai/i.test(gatewaySrc),
    'found an openrouter.ai reference',
  );
  check(
    'gateway.ts contains no google/gemini-3-flash-preview literal',
    !gatewaySrc.includes('google/gemini-3-flash-preview'),
    'found the dead gemini-3-flash-preview model id',
  );
  check(
    'gateway.ts does not read OPENROUTER_API_KEY',
    !gatewaySrc.includes('OPENROUTER_API_KEY'),
    'still references OPENROUTER_API_KEY',
  );
  check(
    'gateway.ts routes through the Spark LLM env (SPARK_API_KEY)',
    gatewaySrc.includes('SPARK_API_KEY'),
    'no SPARK_API_KEY reference found',
  );

  // ── Test 2: with key set, posts to the Spark endpoint, returns reply ──────
  {
    const SAVED = { ...process.env };
    process.env.SPARK_API_KEY = 'test-key-not-a-real-secret';
    process.env.SPARK_LLM_URL = 'http://dgx-spark.local:18091/v1/chat/completions';
    // Force a deterministic model id we can assert on.
    process.env.VOICE_FALLBACK_MODEL = 'spark/test-model';

    const realPost = axios.post;
    let capturedUrl = '';
    let capturedBody: any = null;
    let capturedAuth = '';
    (axios as any).post = async (url: string, body: any, cfg: any) => {
      capturedUrl = url;
      capturedBody = body;
      capturedAuth = cfg?.headers?.Authorization ?? '';
      return { data: { choices: [{ message: { content: 'hello from spark' } }] } };
    };

    try {
      // Fresh import so module-level env reads pick up our values.
      delete require.cache[require.resolve('../src/gateway')];
      const { sendToOpenClaw } = require('../src/gateway');

      const reply = await sendToOpenClaw('hi', 'main');
      check('sendToOpenClaw resolves to a non-empty string', reply.length > 0, JSON.stringify(reply));
      check(
        'request targets the Spark endpoint (not openrouter.ai)',
        capturedUrl.includes('dgx-spark.local') && !capturedUrl.includes('openrouter.ai'),
        capturedUrl.replace(/spark\.local/, 'spark.local'),
      );
      check(
        'Authorization header is Bearer SPARK_API_KEY',
        capturedAuth.startsWith('Bearer ') && capturedAuth.includes('test-key-not-a-real-secret'),
        'auth header did not use SPARK_API_KEY',
      );
      check(
        'main persona resolves to VOICE_FALLBACK_MODEL default',
        capturedBody?.model === 'spark/test-model',
        `model was ${capturedBody?.model}`,
      );

      // modelOverride precedence
      capturedBody = null;
      const reply2 = await sendToOpenClaw('hi', 'dev', 'override/model-x');
      check(
        'modelOverride wins over per-agent model',
        capturedBody?.model === 'override/model-x',
        `model was ${capturedBody?.model}`,
      );
      check('override path still returns a reply', reply2.length > 0);
    } catch (e) {
      check('Test 2 ran without throwing', false, String(e));
    } finally {
      (axios as any).post = realPost;
      process.env = SAVED;
    }
  }

  // ── Test 3: with key UNSET, throw references SPARK, not OPENROUTER ─────────
  {
    const SAVED = { ...process.env };
    delete process.env.SPARK_API_KEY;

    try {
      delete require.cache[require.resolve('../src/gateway')];
      const { sendToOpenClaw } = require('../src/gateway');
      let threw = false;
      let msg = '';
      try {
        await sendToOpenClaw('hi', 'main');
      } catch (e) {
        threw = true;
        msg = (e as Error).message;
      }
      check('throws when the Spark key is unset', threw);
      check(
        'throw message references SPARK_API_KEY, not OPENROUTER',
        threw && msg.includes('SPARK_API_KEY') && !/OPENROUTER/i.test(msg),
        msg,
      );
    } finally {
      process.env = SAVED;
    }
  }

  console.log(`\n=== Done (${failures} failure${failures === 1 ? '' : 's'}) ===\n`);
  if (failures > 0) process.exit(1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
