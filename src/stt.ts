/**
 * Speech-to-text with failover chain:
 *   1. Spark Parakeet (local/on-prem, fastest)
 *   2. OpenAI Whisper API
 *   3. ElevenLabs Scribe (scribe_v1) — quota-safe fallback
 */

const STT_URL = process.env.SPARK_STT_URL ?? 'http://dgx-spark.local:18092/v1/audio/transcriptions';
const STT_MODEL = process.env.STT_MODEL ?? 'openai/whisper-large-v3';
const SPARK_API_KEY = process.env.SPARK_API_KEY ?? '';

const STT_FALLBACK_URL = 'https://api.openai.com/v1/audio/transcriptions';
const STT_FALLBACK_MODEL = 'whisper-1';
const STT_FALLBACK_API_KEY = process.env.OPENAI_API_KEY ?? '';

const ELEVENLABS_STT_URL = 'https://api.elevenlabs.io/v1/speech-to-text';
const ELEVENLABS_STT_MODEL = 'scribe_v1';
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY ?? '';

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
  apiKeyHeader?: 'Authorization' | 'xi-api-key';
  wavBuffer: Buffer;
  timeoutMs: number;
}): Promise<SttAttemptResult> {
  const { url, model, apiKey, apiKeyHeader = 'Authorization', wavBuffer, timeoutMs } = params;

  const formData = new FormData();
  formData.append('file', new Blob([new Uint8Array(wavBuffer)], { type: 'audio/wav' }), 'audio.wav');
  formData.append('model_id', model);  // ElevenLabs uses model_id
  formData.append('model', model);     // OpenAI/Spark use model

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  const headers: Record<string, string> = {};
  if (apiKey) {
    headers[apiKeyHeader] = apiKeyHeader === 'Authorization' ? `Bearer ${apiKey}` : apiKey;
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
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

function shouldFallback(result: SttAttemptResult): boolean {
  return !!(
    result.networkError ||
    result.timeoutError ||
    (typeof result.status === 'number' && result.status >= 500) ||
    // 429 (rate limit / quota) and 401/403 (missing/stale Spark token)
    result.status === 429 ||
    result.status === 401 ||
    result.status === 403
  );
}

/**
 * Transcribe a WAV audio buffer.
 * Returns empty string on total failure.
 */
export async function transcribe(wavBuffer: Buffer): Promise<string> {
  console.log(`[stt] Starting transcription (${wavBuffer.length} bytes WAV)`);

  // ── 1. Spark Parakeet ────────────────────────────────────────────────────
  const tStart = Date.now();
  const primary = await requestTranscription({
    url: STT_URL,
    model: STT_MODEL,
    apiKey: SPARK_API_KEY,
    wavBuffer,
    timeoutMs: Number(process.env.STT_PRIMARY_TIMEOUT_MS ?? 8_000),
  });
  console.log(`[stt] Spark took ${Date.now() - tStart}ms (ok=${primary.ok}${primary.error ? ' err=' + primary.error.slice(0, 60) : ''})`);

  if (primary.ok) {
    if (primary.text) console.log(`[stt] Spark: "${primary.text.slice(0, 100)}"`);
    return primary.text;
  }

  if (!shouldFallback(primary)) {
    console.error(`[stt] Spark failed (no fallback): ${primary.error ?? 'unknown'}`);
    return '';
  }

  // ── 2. OpenAI Whisper ────────────────────────────────────────────────────
  if (STT_FALLBACK_API_KEY) {
    console.warn('[stt] Spark unavailable → trying OpenAI Whisper');
    const whisper = await requestTranscription({
      url: STT_FALLBACK_URL,
      model: STT_FALLBACK_MODEL,
      apiKey: STT_FALLBACK_API_KEY,
      wavBuffer,
      timeoutMs: 30_000,
    });

    if (whisper.ok) {
      if (whisper.text) console.log(`[stt] Whisper: "${whisper.text.slice(0, 100)}"`);
      return whisper.text;
    }

    console.warn(`[stt] Whisper failed (${whisper.error?.slice(0, 80)}) → trying ElevenLabs Scribe`);
  } else {
    console.warn('[stt] No OpenAI key → skipping Whisper, trying ElevenLabs Scribe');
  }

  // ── 3. ElevenLabs Scribe ─────────────────────────────────────────────────
  if (!ELEVENLABS_API_KEY) {
    console.error('[stt] All STT providers exhausted (no ElevenLabs key)');
    return '';
  }

  const scribe = await requestTranscription({
    url: ELEVENLABS_STT_URL,
    model: ELEVENLABS_STT_MODEL,
    apiKey: ELEVENLABS_API_KEY,
    apiKeyHeader: 'xi-api-key',
    wavBuffer,
    timeoutMs: 30_000,
  });

  if (scribe.ok) {
    if (scribe.text) console.log(`[stt] ElevenLabs Scribe: "${scribe.text.slice(0, 100)}"`);
    return scribe.text;
  }

  console.error(`[stt] All STT providers failed. Last error: ${scribe.error ?? 'unknown'}`);
  return '';
}
