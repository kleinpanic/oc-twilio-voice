#!/usr/bin/env ts-node
/**
 * Test 2: Fallback pipeline (STT → LLM → TTS)
 * Tests each stage individually. No Twilio call needed.
 * Requires Spark or OpenAI to be reachable.
 */

import * as dotenv from 'dotenv';
dotenv.config();
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

function pass(label: string) { console.log(`[PASS] ${label}`); }
function fail(label: string, reason: string) { console.log(`[FAIL] ${label}: ${reason}`); }

async function run() {
  console.log('\n=== Pipeline Tests ===\n');

  // ── Test 1: mulaw↔WAV conversion ─────────────────────────────────────────
  {
    const { mulawToWav, audioToMulaw, mulawToPcm16, pcm16ToMulaw } = require('../src/mulaw');
    try {
      // Generate 0.5s of silent 8kHz mulaw (0x7f = silence in µ-law)
      const silentMulaw = Buffer.alloc(4000, 0x7f);
      const wav = await mulawToWav(silentMulaw);
      const wavOk = wav.slice(0, 4).toString() === 'RIFF';
      console.log(`[${wavOk ? 'PASS' : 'FAIL'}] mulawToWav: produces valid WAV (${wav.length} bytes)`);

      // Pure-JS decode
      const pcm = mulawToPcm16(silentMulaw, 24000);
      const pcmOk = pcm.length > 0;
      console.log(`[${pcmOk ? 'PASS' : 'FAIL'}] mulawToPcm16: decoded ${pcm.length} bytes at 24kHz`);

      // Round-trip encode
      const reencoded = pcm16ToMulaw(pcm, 24000);
      console.log(`[PASS] pcm16ToMulaw: encoded ${reencoded.length} bytes`);
    } catch (e) {
      fail('mulaw conversion', String(e));
    }
  }

  // ── Test 2: LLM (gateway / OpenAI Chat) ──────────────────────────────────
  {
    const { sendToOpenClaw } = require('../src/gateway');
    try {
      console.log('\n[...] Testing LLM (OpenAI Chat API)...');
      const reply = await sendToOpenClaw('Say "hello test" and nothing else.');
      const ok = reply.length > 0;
      console.log(`[${ok ? 'PASS' : 'FAIL'}] LLM response: "${reply.slice(0, 80)}"`);
    } catch (e) {
      fail('LLM', String(e));
    }
  }

  // ── Test 3: TTS (Spark → ElevenLabs fallback) ────────────────────────────
  {
    const { synthesize } = require('../src/tts');
    try {
      console.log('\n[...] Testing TTS...');
      const audio: Buffer = await synthesize('Hello, this is a TTS test.');
      const ok = audio.length > 1000;
      const outPath = '/tmp/tts-test.mp3';
      fs.writeFileSync(outPath, audio);
      console.log(`[${ok ? 'PASS' : 'FAIL'}] TTS: got ${audio.length} bytes → ${outPath}`);
    } catch (e) {
      fail('TTS', String(e));
    }
  }

  // ── Test 4: STT (Spark → OpenAI Whisper fallback) ────────────────────────
  // Requires a WAV file. Generate a short sine wave via ffmpeg.
  {
    const { transcribe } = require('../src/stt');
    try {
      console.log('\n[...] Generating test audio for STT...');
      // Generate 2s of 440Hz tone as 16kHz WAV
      const testWav = '/tmp/stt-test.wav';
      await new Promise<void>((res, rej) => {
        const ff = spawn('/bin/ffmpeg', [
          '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
          '-ar', '16000', '-ac', '1', testWav,
        ]);
        ff.on('close', (code) => code === 0 ? res() : rej(new Error(`ffmpeg ${code}`)));
        ff.on('error', rej);
      });
      const wavBuf = fs.readFileSync(testWav);
      console.log('[...] Testing STT (tone audio — may transcribe as empty/noise)...');
      const transcript = await transcribe(wavBuf);
      // A tone won't produce real words, but it shouldn't throw
      console.log(`[PASS] STT returned (tone input): "${transcript || '(empty — expected for tone)'}"`);
    } catch (e) {
      fail('STT', String(e));
    }
  }

  // ── Test 5: OpenAI Realtime quota check ──────────────────────────────────
  {
    console.log('\n[...] Checking OpenAI Realtime API access...');
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? '';
    try {
      const WebSocket = require('ws');
      await new Promise<void>((res, rej) => {
        const ws = new WebSocket(
          'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17',
          { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'OpenAI-Beta': 'realtime=v1' } },
        );
        const timeout = setTimeout(() => { ws.close(); rej(new Error('timeout')); }, 8000);
        ws.on('message', (raw: Buffer) => {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'session.created') {
            clearTimeout(timeout);
            ws.close();
            res();
          }
        });
        ws.on('error', (e: Error) => { clearTimeout(timeout); rej(e); });
      });
      pass('OpenAI Realtime: connected and session created ✅ — Realtime path will work');
    } catch (e) {
      const msg = String(e);
      if (msg.includes('insufficient_quota') || msg.includes('quota')) {
        console.log('[WARN] OpenAI Realtime: QUOTA EXHAUSTED — will fall back to STT/Chat/TTS path');
      } else {
        console.log(`[WARN] OpenAI Realtime: ${msg} — will use fallback path`);
      }
    }
  }

  console.log('\n=== Done ===\n');
}

run().catch(console.error);
