/**
 * Text-to-speech with failover.
 * Primary: Spark Kokoro endpoint
 * Fallback: ElevenLabs API
 */

const TTS_URL = process.env.SPARK_TTS_URL ?? 'http://dgx-spark.local:18093/v1/audio/speech';
const TTS_VOICE = process.env.SPARK_TTS_VOICE ?? 'af_heart';
const SPARK_API_KEY = process.env.SPARK_API_KEY ?? '';

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY ?? '';
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID ?? 'EXAVITQu4vr4xnSDxMaL';
const ELEVENLABS_MODEL_ID = process.env.ELEVENLABS_MODEL_ID ?? 'eleven_flash_v2_5';

type TtsAttempt = {
  ok: boolean;
  audio?: Buffer;
  status?: number;
  networkError?: boolean;
  timeoutError?: boolean;
  error?: string;
};

function isTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'AbortError' || /timeout/i.test(err.message);
}

async function requestSparkTts(text: string): Promise<TtsAttempt> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(TTS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SPARK_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'kokoro',
        input: text,
        voice: TTS_VOICE,
        response_format: 'mp3',
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return {
        ok: false,
        status: response.status,
        error: `HTTP ${response.status} ${response.statusText} — ${body}`,
      };
    }

    const arrayBuffer = await response.arrayBuffer();
    return { ok: true, audio: Buffer.from(arrayBuffer), status: response.status };
  } catch (err) {
    return {
      ok: false,
      networkError: true,
      timeoutError: isTimeoutError(err),
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function requestElevenLabsTts(text: string): Promise<TtsAttempt> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);

  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(ELEVENLABS_VOICE_ID)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
          'xi-api-key': ELEVENLABS_API_KEY,
        },
        body: JSON.stringify({
          model_id: ELEVENLABS_MODEL_ID,
          text,
          output_format: 'mp3_44100_128',
        }),
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return {
        ok: false,
        status: response.status,
        error: `HTTP ${response.status} ${response.statusText} — ${body}`,
      };
    }

    const arrayBuffer = await response.arrayBuffer();
    return { ok: true, audio: Buffer.from(arrayBuffer), status: response.status };
  } catch (err) {
    return {
      ok: false,
      networkError: true,
      timeoutError: isTimeoutError(err),
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function synthesize(text: string): Promise<Buffer> {
  const primary = await requestSparkTts(text);
  if (primary.ok && primary.audio) {
    return primary.audio;
  }

  const shouldFallback =
    primary.networkError ||
    primary.timeoutError ||
    (typeof primary.status === 'number' && primary.status >= 500);

  if (!shouldFallback) {
    throw new Error(`Spark TTS failed (no fallback): ${primary.error ?? 'unknown error'}`);
  }

  if (!ELEVENLABS_API_KEY) {
    throw new Error(
      `Spark TTS failed and ELEVENLABS_API_KEY missing: ${primary.error ?? 'unknown error'}`,
    );
  }

  console.warn('[tts] Spark unavailable; falling back to ElevenLabs');
  const fallback = await requestElevenLabsTts(text);
  if (!fallback.ok || !fallback.audio) {
    throw new Error(`ElevenLabs fallback failed: ${fallback.error ?? 'unknown error'}`);
  }

  return fallback.audio;
}
