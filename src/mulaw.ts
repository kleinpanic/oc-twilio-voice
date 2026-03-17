import { spawn } from 'child_process';

const FFMPEG_PATH = '/bin/ffmpeg';

// ── Pure-JS mulaw codec (no ffmpeg, no spawning per chunk) ────────────────────
// Used by the OpenAI Realtime path to avoid 50x/sec ffmpeg process spawns.

/** Decode a single 8-bit µ-law sample to 16-bit signed PCM */
function decodeMulawSample(u: number): number {
  u = (~u) & 0xff;
  const sign = u & 0x80 ? -1 : 1;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  const magnitude = ((mantissa << 1) | 1) << (exponent + 2);
  return sign * (magnitude - 4);
}

/**
 * Decode a Buffer of 8-bit µ-law samples (8 kHz) to PCM16LE at a target rate.
 * Uses simple nearest-neighbour resampling (good enough for voice).
 * Returns a Buffer of 16-bit LE samples at targetRate Hz.
 */
export function mulawToPcm16(mulawBuf: Buffer, targetRate = 24000): Buffer {
  const srcRate = 8000;
  const srcSamples = mulawBuf.length;
  const dstSamples = Math.floor((srcSamples * targetRate) / srcRate);
  const out = Buffer.alloc(dstSamples * 2);
  for (let i = 0; i < dstSamples; i++) {
    const srcIdx = Math.min(Math.floor((i * srcRate) / targetRate), srcSamples - 1);
    const sample = decodeMulawSample(mulawBuf[srcIdx]);
    out.writeInt16LE(sample, i * 2);
  }
  return out;
}

/** Encode a 16-bit signed PCM sample to µ-law */
function encodeMulawSample(s: number): number {
  const BIAS = 0x84;
  const CLIP = 32635;
  const sign = s < 0 ? 0x80 : 0;
  if (s < 0) s = -s;
  if (s > CLIP) s = CLIP;
  s += BIAS;
  let exp = 7;
  for (let expMask = 0x4000; (s & expMask) === 0 && exp > 0; exp--, expMask >>= 1);
  const mantissa = (s >> (exp + 3)) & 0x0f;
  return ~(sign | (exp << 4) | mantissa) & 0xff;
}

/**
 * Encode PCM16LE Buffer (any rate) to 8-bit µ-law at 8 kHz.
 * Uses nearest-neighbour downsampling.
 */
export function pcm16ToMulaw(pcmBuf: Buffer, srcRate = 24000): Buffer {
  const dstRate = 8000;
  const srcSamples = pcmBuf.length / 2;
  const dstSamples = Math.floor((srcSamples * dstRate) / srcRate);
  const out = Buffer.alloc(dstSamples);
  for (let i = 0; i < dstSamples; i++) {
    const srcIdx = Math.min(Math.floor((i * srcRate) / dstRate), srcSamples - 1);
    const sample = pcmBuf.readInt16LE(srcIdx * 2);
    out[i] = encodeMulawSample(sample);
  }
  return out;
}

/**
 * Convert 8kHz mulaw Buffer to 16kHz WAV for STT
 */
export async function mulawToWav(mulawBuffer: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(FFMPEG_PATH, [
      '-f', 'mulaw',
      '-ar', '8000',
      '-ac', '1',
      '-i', 'pipe:0',
      '-f', 'wav',
      '-ar', '16000',
      '-ac', '1',
      'pipe:1'
    ]);

    const chunks: Buffer[] = [];
    ffmpeg.stdout.on('data', (chunk) => chunks.push(chunk));
    ffmpeg.stderr.on('data', (data) => {
      // ffmpeg writes info to stderr, can be ignored or logged for debugging
      // console.error(`ffmpeg stderr: ${data}`);
    });

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks));
      } else {
        reject(new Error(`ffmpeg exited with code ${code}`));
      }
    });

    ffmpeg.on('error', reject);

    ffmpeg.stdin.write(mulawBuffer);
    ffmpeg.stdin.end();
  });
}

/**
 * Convert TTS output (mp3/wav) to 8kHz mulaw for Twilio
 */
export async function audioToMulaw(audioBuffer: Buffer, inputFormat: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(FFMPEG_PATH, [
      '-f', inputFormat,
      '-i', 'pipe:0',
      '-f', 'mulaw',
      '-ar', '8000',
      '-ac', '1',
      'pipe:1'
    ]);

    const chunks: Buffer[] = [];
    ffmpeg.stdout.on('data', (chunk) => chunks.push(chunk));
    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks));
      } else {
        reject(new Error(`ffmpeg exited with code ${code}`));
      }
    });

    ffmpeg.on('error', reject);

    ffmpeg.stdin.write(audioBuffer);
    ffmpeg.stdin.end();
  });
}

/**
 * Convert PCM16 (e.g. 24kHz) to 8kHz mulaw
 */
export async function pcmToMulaw(pcmBuffer: Buffer, inputRate: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(FFMPEG_PATH, [
      '-f', 's16le',
      '-ar', inputRate.toString(),
      '-ac', '1',
      '-i', 'pipe:0',
      '-f', 'mulaw',
      '-ar', '8000',
      '-ac', '1',
      'pipe:1'
    ]);

    const chunks: Buffer[] = [];
    ffmpeg.stdout.on('data', (chunk) => chunks.push(chunk));
    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks));
      } else {
        reject(new Error(`ffmpeg exited with code ${code}`));
      }
    });

    ffmpeg.on('error', reject);

    ffmpeg.stdin.write(pcmBuffer);
    ffmpeg.stdin.end();
  });
}
