/**
 * Speech-to-text with failover.
 * Primary: Spark Whisper (local/on-prem)
 * Fallback: OpenAI Audio Transcriptions API
 */

const STT_URL = process.env.SPARK_STT_URL ?? 'http://dgx-spark.local:18092/v1/audio/transcriptions';
const STT_MODEL = process.env.STT_MODEL ?? 'openai/whisper-large-v3';
const SPARK_API_KEY = process.env.SPARK_API_KEY ?? '';

const STT_FALLBACK_URL = 'https://api.openai.com/v1/audio/transcriptions';
const STT_FALLBACK_MODEL = 'whisper-1';
const STT_FALLBACK_API_KEY = process.env.OPENAI_API_KEY ?? '';

type SttAttemptResult = {
  ok: boolean;
  text: string;
  status?: number;
  networkError?: boolean;
  timeoutError?: boolean;
  error?: string;
};

function isTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'AbortError' || /timeout/i.test(err.message);
}

async function requestTranscription(params: {
  url: string;
  model: string;
  apiKey?: string;
  wavBuffer: Buffer;
  timeoutMs: number;
}): Promise<SttAttemptResult> {
  const { url, model, apiKey, wavBuffer, timeoutMs } = params;

  const formData = new FormData();
  formData.append('file', new Blob([new Uint8Array(wavBuffer)], { type: 'audio/wav' }), 'audio.wav');
  formData.append('model', model);
  formData.append('language', 'en');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      body: formData,
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return {
        ok: false,
        text: '',
        status: response.status,
        error: `HTTP ${response.status} ${response.statusText} — ${body}`,
      };
    }

    const result = (await response.json()) as { text?: string };
    return {
      ok: true,
      text: (result.text ?? '').trim(),
      status: response.status,
    };
  } catch (err) {
    return {
      ok: false,
      text: '',
      networkError: true,
      timeoutError: isTimeoutError(err),
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Transcribe a WAV audio buffer.
 * Returns empty string on total failure.
 */
export async function transcribe(wavBuffer: Buffer): Promise<string> {
  console.log(`[stt] Starting transcription (${wavBuffer.length} bytes WAV)`);

  const tStart = Date.now();
  const primary = await requestTranscription({
    url: STT_URL,
    model: STT_MODEL,
    apiKey: SPARK_API_KEY,
    wavBuffer,
    timeoutMs: Number(process.env.STT_PRIMARY_TIMEOUT_MS ?? 8_000),
  });
  console.log(`[stt] Primary took ${Date.now() - tStart}ms (ok=${primary.ok}${primary.error ? ' err=' + primary.error.slice(0, 60) : ''})`);

  if (primary.ok) {
    if (primary.text) {
      console.log(`[stt] Spark transcribed: "${primary.text.slice(0, 100)}${primary.text.length > 100 ? '…' : ''}"`);
    }
    return primary.text;
  }

  const shouldFallback =
    primary.networkError ||
    primary.timeoutError ||
    (typeof primary.status === 'number' && primary.status >= 500);

  if (!shouldFallback) {
    console.error(`[stt] Spark request failed (no fallback): ${primary.error ?? 'unknown error'}`);
    return '';
  }

  if (!STT_FALLBACK_API_KEY) {
    console.error('[stt] Spark failed and no OpenAI API key found for fallback');
    return '';
  }

  console.warn(`[stt] Spark unavailable; falling back to Whisper API (${STT_FALLBACK_URL})`);
  const fallback = await requestTranscription({
    url: STT_FALLBACK_URL,
    model: STT_FALLBACK_MODEL,
    apiKey: STT_FALLBACK_API_KEY,
    wavBuffer,
    timeoutMs: 30_000,
  });

  if (!fallback.ok) {
    console.error(`[stt] Whisper fallback failed: ${fallback.error ?? 'unknown error'}`);
    return '';
  }

  if (fallback.text) {
    console.log(
      `[stt] Whisper fallback transcribed: "${fallback.text.slice(0, 100)}${fallback.text.length > 100 ? '…' : ''}"`,
    );
  }

  return fallback.text;
}
