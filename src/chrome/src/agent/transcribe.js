/**
 * Whisper-compatible transcription client.
 *
 * Used by the Tab Recorder's optional "Transcribe after recording" toggle.
 * We POST the recorded audio (or audio+video webm) to an OpenAI-compatible
 * /v1/audio/transcriptions endpoint and save the text result alongside
 * the .webm.
 *
 * Provider selection
 *   The Whisper API isn't a separate first-class provider in webbrain's
 *   provider manager — that would mean another settings tab. Instead we
 *   reuse whichever existing OpenAI-compatible provider the user already
 *   has configured. We try them in this order:
 *
 *     openai      → model "whisper-1" (canonical home of Whisper)
 *     groq        → "whisper-large-v3" (fastest, basically free)
 *     lmstudio    → user-configured local Whisper model
 *     llamacpp    → user-configured local Whisper model
 *     anything else of type 'openai' with apiKey + baseUrl
 *
 *   Providers that don't host Whisper (anthropic, deepseek-chat-only, xai,
 *   mistral, gemini's chat endpoint) are skipped.
 *
 * Error model
 *   Returns { ok: false, error: "..." } on failure rather than throwing,
 *   so the caller (background's stop_tab_recording) can record-but-not-
 *   transcribe gracefully — the user still gets their .webm.
 */

// Provider id → default Whisper-style model name.
const WHISPER_MODEL_BY_PROVIDER = {
  openai: 'whisper-1',
  groq: 'whisper-large-v3',
  // Local servers vary; sensible default but users can override via
  // settings.transcriptionModel (added in a later release if needed).
  lmstudio: 'whisper-1',
  llamacpp: 'whisper-1',
};

// Providers that definitely DON'T host Whisper. Skip even if they have
// an apiKey configured.
const NO_WHISPER = new Set([
  'anthropic', // Claude — no audio transcription endpoint
  'gemini',    // separate audio endpoint, not OpenAI-compatible for transcription
  'deepseek',  // chat-only
  'xai',       // chat-only
  'mistral',   // chat-only (audio in private beta as of writing)
  'nvidia',    // chat-only via NIM
]);

function pickProvider(providers) {
  const order = ['openai', 'groq', 'lmstudio', 'llamacpp'];
  // First try the priority list…
  for (const id of order) {
    const p = providers.get?.(id) ?? providers[id];
    if (!p) continue;
    const cfg = p.config || p;
    if (NO_WHISPER.has(id)) continue;
    if (cfg.enabled !== false && cfg.baseUrl && (cfg.apiKey || id === 'lmstudio' || id === 'llamacpp')) {
      return { id, baseUrl: cfg.baseUrl, apiKey: cfg.apiKey || '' };
    }
  }
  // …then any other OpenAI-compatible provider not on the blocklist.
  const iter = providers.entries ? providers.entries() : Object.entries(providers);
  for (const [id, p] of iter) {
    if (NO_WHISPER.has(id)) continue;
    const cfg = p.config || p;
    if (cfg.type !== 'openai') continue;
    if (cfg.enabled === false) continue;
    if (!cfg.baseUrl) continue;
    if (!cfg.apiKey) continue;
    return { id, baseUrl: cfg.baseUrl, apiKey: cfg.apiKey };
  }
  return null;
}

/**
 * Transcribe a webm/wav/mp3 blob.
 *
 * @param {Map|Object} providers — providerManager.providers (Map) or a plain object.
 * @param {Blob} audioBlob
 * @param {object} opts
 * @param {string} [opts.filename='recording.webm']
 * @param {string} [opts.modelOverride]  — if you want to force a specific model.
 * @returns {Promise<{ok:true,text,providerId,model,latencyMs}|{ok:false,error}>}
 */
export async function transcribeAudio(providers, audioBlob, opts = {}) {
  if (!audioBlob || audioBlob.size === 0) {
    return { ok: false, error: 'Transcription: empty audio blob.' };
  }
  const picked = pickProvider(providers);
  if (!picked) {
    return {
      ok: false,
      error: 'No Whisper-compatible provider configured. Add an API key to OpenAI (whisper-1) or Groq (whisper-large-v3) in Settings → Providers, then re-record.',
    };
  }

  const model = opts.modelOverride || WHISPER_MODEL_BY_PROVIDER[picked.id] || 'whisper-1';
  const filename = opts.filename || 'recording.webm';

  // Whisper endpoint convention: /v1/audio/transcriptions. baseUrl already
  // includes /v1 for every provider in our manager, so just append.
  const url = picked.baseUrl.replace(/\/$/, '') + '/audio/transcriptions';

  // Re-tag the blob as audio/webm before upload. The recorder produces a
  // single WebM container with video + audio tracks, so its native MIME
  // is video/webm. OpenAI's /v1/audio/transcriptions accepts the .webm
  // extension but rejects video MIMEs at the gateway with HTTP 415
  // ("Unsupported Media Type") — even though the bytes are otherwise
  // identical and the server would extract the audio track anyway. Groq
  // is lenient about this and accepts video/webm, but the right fix is
  // to send the audio MIME everywhere. We re-wrap rather than mutating
  // the original blob because Blob.type is read-only.
  const t0 = audioBlob.type || '';
  const uploadBlob = t0.startsWith('audio/')
    ? audioBlob
    : new Blob([audioBlob], { type: 'audio/webm' });

  const form = new FormData();
  form.append('file', uploadBlob, filename);
  form.append('model', model);
  form.append('response_format', 'verbose_json'); // gets segments + timestamps
  form.append('temperature', '0');

  const headers = {};
  if (picked.apiKey) headers['Authorization'] = `Bearer ${picked.apiKey}`;

  const start = Date.now();
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers, body: form });
  } catch (e) {
    return { ok: false, error: `Transcription network error: ${e.message || e}` };
  }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 300); } catch {}
    return {
      ok: false,
      error: `Transcription ${picked.id} HTTP ${res.status}: ${detail || res.statusText}`,
    };
  }
  let body;
  try {
    body = await res.json();
  } catch (e) {
    return { ok: false, error: `Transcription: failed to parse response (${e.message}).` };
  }
  const text = (body.text || body.transcript || '').trim();
  if (!text) {
    return { ok: false, error: 'Transcription: provider returned no text.' };
  }
  return {
    ok: true,
    text,
    segments: Array.isArray(body.segments) ? body.segments : null,
    providerId: picked.id,
    model,
    latencyMs: Date.now() - start,
  };
}
