export const DEFAULT_LOCAL_CONTEXT_WINDOW = 16384;
export const DEFAULT_CLOUD_CONTEXT_WINDOW = 128000;
export const MIN_CONTEXT_WINDOW = 4096;
export const MAX_CONTEXT_WINDOW = 1048576;

const K128 = 131072;
const K256 = 262144;
const M1 = 1000000;

function clean(value) {
  return String(value || '').trim().toLowerCase();
}

/**
 * Clamp a detected/server-reported context window into the range Settings
 * accepts. Returns null when the value is missing, unusable, or below the
 * Settings minimum — callers keep the existing config/default rather than
 * inventing a larger window than the server reported.
 */
export function normalizeDetectedContextWindow(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const floored = Math.floor(n);
  if (floored < MIN_CONTEXT_WINDOW) return null;
  return Math.min(MAX_CONTEXT_WINDOW, floored);
}

/**
 * Whether an auto-detected window should replace the stored Settings value.
 * Always refresh when unset/default; always shrink when the server reports a
 * smaller window (fixes overstated compaction budgets); never enlarge a
 * non-default user override.
 */
export function shouldApplyDetectedContextWindow(current, detected) {
  const next = normalizeDetectedContextWindow(detected);
  if (next == null) return false;
  const cur = Number(current);
  if (!Number.isFinite(cur) || cur <= 0) return true;
  if (cur === DEFAULT_LOCAL_CONTEXT_WINDOW) return true;
  return next < cur;
}

/**
 * llama.cpp `GET /props` — prefer default_generation_settings.n_ctx, then
 * top-level n_ctx.
 */
export function parseLlamaCppPropsContextWindow(data) {
  if (!data || typeof data !== 'object') return null;
  return normalizeDetectedContextWindow(
    data.default_generation_settings?.n_ctx ?? data.n_ctx
  );
}

/**
 * Parse `num_ctx` from Ollama `/api/show` `parameters`, which is usually a
 * whitespace-separated string (`"num_ctx 8192\\nstop ..."`), not an object.
 */
export function parseOllamaNumCtx(parameters) {
  if (parameters == null) return null;
  if (typeof parameters === 'object' && !Array.isArray(parameters)) {
    return normalizeDetectedContextWindow(parameters.num_ctx ?? parameters.numCtx);
  }
  const text = String(parameters);
  const match = text.match(/(?:^|[\s;])num_ctx\s*[=\s]\s*(\d+)/i) || text.match(/\bnum_ctx\s+(\d+)/i);
  return match ? normalizeDetectedContextWindow(match[1]) : null;
}

/**
 * Ollama `GET /api/ps` — live allocated context for a running model.
 * Field is `context_length` on each entry (see `ollama ps` CONTEXT column).
 */
export function parseOllamaPsContextWindow(data, preferredModel = '') {
  const models = Array.isArray(data?.models) ? data.models : [];
  if (!models.length) return null;

  const want = String(preferredModel || '').trim().toLowerCase();
  const candidates = want
    ? models.filter((m) => {
        const name = String(m?.name || m?.model || '').trim().toLowerCase();
        return name === want || name.startsWith(`${want}:`) || want.startsWith(`${name}:`);
      })
    : models;

  for (const model of candidates.length ? candidates : models) {
    const n = normalizeDetectedContextWindow(
      model?.context_length ?? model?.contextLength ?? model?.size_vram?.context_length
    );
    if (n != null) return n;
  }
  return null;
}

/**
 * Ollama `POST /api/show` — prefer Modelfile/runtime `num_ctx`, not
 * `model_info.*.context_length` (architecture max; overstates the live window).
 */
export function parseOllamaShowContextWindow(data) {
  if (!data || typeof data !== 'object') return null;

  const fromParams = parseOllamaNumCtx(data.parameters);
  if (fromParams != null) return fromParams;

  return normalizeDetectedContextWindow(
    data.context_length ?? data.details?.context_length
  );
}

/**
 * Architecture max from `/api/show` `model_info.*.context_length`. Not used for
 * auto-persist (overstates), but exported for tests / future UI hints.
 */
export function parseOllamaModelMaxContextWindow(data) {
  if (!data || typeof data !== 'object') return null;
  const info = data.model_info;
  if (info && typeof info === 'object') {
    for (const [key, value] of Object.entries(info)) {
      if (String(key).toLowerCase().endsWith('.context_length')) {
        const n = normalizeDetectedContextWindow(value);
        if (n != null) return n;
      }
    }
  }
  return null;
}

/**
 * LM Studio `GET /api/v0/models` — prefer a matching/loaded model's
 * loaded_context_length, then max_context_length.
 */
export function parseLmStudioModelsContextWindow(data, preferredModel = '') {
  const source = Array.isArray(data?.data) ? data.data : [];
  if (!source.length) return null;

  const want = String(preferredModel || '').trim();
  const chat = source.filter((m) => m && m.id && m.type !== 'embeddings');
  const loaded = chat.filter((m) => m.state === 'loaded');
  const preferred = want
    ? chat.find((m) => m.id === want) || loaded.find((m) => m.id === want)
    : null;
  const candidates = [
    preferred,
    ...(loaded.length ? loaded : []),
    ...chat,
  ].filter(Boolean);

  for (const model of candidates) {
    const n = normalizeDetectedContextWindow(
      model.loaded_context_length ?? model.max_context_length ?? model.context_length
    );
    if (n != null) return n;
  }
  return null;
}

/**
 * Best-effort context-window metadata for cloud/router models. Local models
 * are runtime-configured by the user/server; they stay on the conservative 16k
 * default until Settings supplies `config.contextWindow` (including values
 * filled by Test connection / Load models auto-detect).
 */
export function inferContextWindow(config = {}) {
  const category = clean(config.category);
  if (category === 'local') return DEFAULT_LOCAL_CONTEXT_WINDOW;

  const provider = clean(config.providerName || config.type || config.label);
  const model = clean(config.model);

  if (!model) return DEFAULT_CLOUD_CONTEXT_WINDOW;

  // OpenAI
  if (model.includes('gpt-5.5-pro')) return 1050000;
  if (/^gpt-5(?:[.\-]|$)/.test(model) || model.includes('/gpt-5')) return 400000;

  // Anthropic Claude
  if (/claude-(?:fable-5|mythos-5|mythos|opus-4-[6-8]|sonnet-4-6)/.test(model)) return M1;
  if (model.includes('claude-')) return 200000;

  // Google Gemini
  if (/gemini-(?:3|3\.|2\.5)/.test(model)) return M1;

  // Cloudflare Workers AI
  if (provider === 'cloudflare' && model.includes('@cf/zai-org/glm-5.2')) return K256;

  // Mistral
  if (/mistral-medium-(?:3\.5|2604)/.test(model)) return K256;

  // DeepSeek
  if (model.includes('deepseek-v4')) return M1;

  // xAI
  if (model.includes('grok-4.3')) return M1;

  // Groq-hosted common models and OpenAI open-weight GPT-OSS models.
  if (model.includes('gpt-oss')) return K128;
  if (provider === 'groq' && /(?:llama-3\.[13]|compound)/.test(model)) return K128;

  // NVIDIA NIM defaults in WebBrain.
  if (/(?:nemotron.*49b|llama-3[._-]3-nemotron|llama-3\.1-8b)/.test(model)) return K128;

  // MiniMax direct and OpenRouter slugs.
  if (/minimax.*m3/.test(model)) return M1;
  if (/minimax.*(?:m2\.7|m2\.5|m2\.1|m2)(?:-|$|\/|\.)/.test(model) || model.includes('minimax-01')) {
    return 204800;
  }

  // Alibaba / Qwen direct models and OpenRouter Qwen slugs.
  if (model.includes('qwen3.7-plus')) return M1;
  if (model.includes('qwen3.7-max')) return K256;
  if (model.includes('qwen3-max')) return K256;
  if (/qwen(?:3\.5)?-(?:plus|turbo)/.test(model)) return M1;
  if (model.includes('qwen-max')) return 32768;
  if (/qwen3-(?:235b|30b|32b|next)/.test(model)) return K128;

  return DEFAULT_CLOUD_CONTEXT_WINDOW;
}
