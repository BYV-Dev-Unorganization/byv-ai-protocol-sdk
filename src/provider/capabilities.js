'use strict';

const {
  PROVIDER_BASE_URL,
  PROVIDER_API_KEY,
  PROVIDER_MODEL,
  PROVIDER_NATIVE_REASONING_EFFORT,
  PROVIDER_CONTEXT_WINDOW_TOKENS,
  PROVIDER_MAX_INPUT_TOKENS,
  PROVIDER_MAX_OUTPUT_TOKENS,
  PROVIDER_MODEL_METADATA_TIMEOUT_MS,
  PROVIDER_CAPABILITIES_CACHE_MS
} = require('../config');

function positiveInteger(value) {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function apiRootUrl(baseUrl) {
  const url = new URL(baseUrl);
  url.search = '';
  url.hash = '';
  let pathname = url.pathname.replace(/\/+$/, '');
  if (pathname.endsWith('/chat/completions')) {
    pathname = pathname.slice(0, -'/chat/completions'.length);
  } else if (!pathname.endsWith('/v1')) {
    pathname += '/v1';
  }
  url.pathname = pathname || '/v1';
  return url;
}

function modelMetadataUrls(baseUrl, model) {
  const root = apiRootUrl(baseUrl);
  return {
    detail: new URL(root.pathname.replace(/\/+$/, '') + '/models/' + encodeURIComponent(model), root.origin).toString(),
    collection: new URL(root.pathname.replace(/\/+$/, '') + '/models', root.origin).toString()
  };
}

function findModelRecord(payload, model) {
  if (!payload || typeof payload !== 'object') return null;
  const candidates = [];
  if (payload.data && !Array.isArray(payload.data) && typeof payload.data === 'object') candidates.push(payload.data);
  if (payload.model && typeof payload.model === 'object') candidates.push(payload.model);
  if (Array.isArray(payload.data)) candidates.push(...payload.data);
  if (Array.isArray(payload.models)) candidates.push(...payload.models);
  candidates.push(payload);

  for (const item of candidates) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const id = typeof item.id === 'string' ? item.id
      : typeof item.name === 'string' ? item.name
        : typeof item.model === 'string' ? item.model : null;
    if (id === model || (!id && candidates.length === 1)) return item;
  }
  return null;
}

function firstPositiveInteger(objects, keys) {
  for (const object of objects) {
    if (!object || typeof object !== 'object') continue;
    for (const key of keys) {
      const value = positiveInteger(object[key]);
      if (value !== null) return value;
    }
  }
  return null;
}

function firstBoolean(objects, keys) {
  for (const object of objects) {
    if (!object || typeof object !== 'object') continue;
    for (const key of keys) {
      if (typeof object[key] === 'boolean') return object[key];
    }
  }
  return null;
}

function extractModelMetadata(payload, model) {
  const record = findModelRecord(payload, model);
  if (!record) return null;

  const nested = [
    record,
    record.limits,
    record.top_provider,
    record.topProvider,
    record.capabilities,
    record.context
  ];
  const metadata = {
    context_window_tokens: firstPositiveInteger(nested, [
      'context_window_tokens',
      'context_limit',
      'context_window',
      'context_length',
      'context_length_tokens',
      'max_context_tokens',
      'max_context_length'
    ]),
    max_input_tokens: firstPositiveInteger(nested, [
      'max_input_tokens',
      'max_prompt_tokens',
      'input_token_limit',
      'max_input_token_count'
    ]),
    max_output_tokens: firstPositiveInteger(nested, [
      'max_output_tokens',
      'max_completion_tokens',
      'output_token_limit',
      'max_output_token_count'
    ]),
    supports_prompt_caching: firstBoolean(nested, [
      'supports_prompt_caching',
      'prompt_caching_supported',
      'supports_prompt_cache'
    ])
  };

  return Object.values(metadata).some((value) => value !== null) ? metadata : null;
}

function mergeCapabilityValues(metadata = {}, overrides = {}) {
  const result = {};
  const sources = {};

  for (const field of ['context_window_tokens', 'max_input_tokens', 'max_output_tokens']) {
    const override = positiveInteger(overrides[field]);
    const detected = positiveInteger(metadata[field]);
    result[field] = override !== null ? override : detected;
    sources[field] = override !== null ? 'environment' : detected !== null ? 'provider_metadata' : 'unknown';
  }

  const overrideCache = typeof overrides.supports_prompt_caching === 'boolean'
    ? overrides.supports_prompt_caching : null;
  const detectedCache = typeof metadata.supports_prompt_caching === 'boolean'
    ? metadata.supports_prompt_caching : null;
  result.supports_prompt_caching = overrideCache !== null ? overrideCache : detectedCache;
  sources.supports_prompt_caching = overrideCache !== null
    ? 'environment' : detectedCache !== null ? 'provider_metadata' : 'unknown';

  result.field_sources = sources;
  return result;
}

async function fetchMetadata(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_MODEL_METADATA_TIMEOUT_MS);
  try {
    const headers = { Accept: 'application/json' };
    if (PROVIDER_API_KEY) headers.Authorization = 'Bearer ' + PROVIDER_API_KEY;
    const response = await fetch(url, { method: 'GET', headers, signal: controller.signal });
    if (!response.ok) return { ok: false, status: response.status, payload: null };
    const raw = await response.text();
    if (raw.length > 2 * 1024 * 1024) return { ok: false, status: response.status, payload: null };
    try {
      return { ok: true, status: response.status, payload: JSON.parse(raw) };
    } catch {
      return { ok: false, status: response.status, payload: null };
    }
  } catch {
    return { ok: false, status: 0, payload: null };
  } finally {
    clearTimeout(timeout);
  }
}

async function discoverModelMetadata() {
  if (!PROVIDER_BASE_URL || !PROVIDER_MODEL) {
    return { metadata: null, status: 'not_configured' };
  }

  let urls;
  try {
    urls = modelMetadataUrls(PROVIDER_BASE_URL, PROVIDER_MODEL);
  } catch {
    return { metadata: null, status: 'unavailable' };
  }

  const detail = await fetchMetadata(urls.detail);
  if (detail.ok) {
    const metadata = extractModelMetadata(detail.payload, PROVIDER_MODEL);
    if (metadata) return { metadata, status: 'available' };
  }

  // Some OpenAI-compatible providers expose model limits only in the model catalog.
  // Fall back to GET /models only when the model-detail response has no usable limits.
  const catalog = await fetchMetadata(urls.collection);
  if (catalog.ok) {
    const metadata = extractModelMetadata(catalog.payload, PROVIDER_MODEL);
    if (metadata) return { metadata, status: 'available' };
  }

  return { metadata: null, status: 'unavailable' };
}

let cachedCapabilities = null;
let cachedAt = 0;
let inFlight = null;

async function getModelCapabilities(options = {}) {
  const forceRefresh = options.forceRefresh === true;
  const now = Date.now();
  if (!forceRefresh && cachedCapabilities && now - cachedAt < PROVIDER_CAPABILITIES_CACHE_MS) {
    return cachedCapabilities;
  }
  if (!forceRefresh && inFlight) return inFlight;

  inFlight = (async () => {
    const discovered = await discoverModelMetadata();
    const overrides = {
      context_window_tokens: PROVIDER_CONTEXT_WINDOW_TOKENS,
      max_input_tokens: PROVIDER_MAX_INPUT_TOKENS,
      max_output_tokens: PROVIDER_MAX_OUTPUT_TOKENS
    };
    const merged = mergeCapabilityValues(discovered.metadata || {}, overrides);
    const hasEnvironmentValues = Object.values(overrides).some((value) => positiveInteger(value) !== null);
    const hasDetectedValues = discovered.metadata !== null;
    const metadataStatus = discovered.status === 'not_configured'
      ? 'not_configured'
      : hasDetectedValues
        ? 'available'
        : hasEnvironmentValues ? 'environment_override' : 'unknown';

    return {
      provider_model: PROVIDER_MODEL || null,
      metadata_status: metadataStatus,
      context_window_tokens: merged.context_window_tokens,
      max_input_tokens: merged.max_input_tokens,
      max_output_tokens: merged.max_output_tokens,
      supports_prompt_caching: merged.supports_prompt_caching,
      reasoning_effort_supported: PROVIDER_NATIVE_REASONING_EFFORT,
      reasoning_effort_levels: PROVIDER_NATIVE_REASONING_EFFORT ? ['low', 'medium', 'high', 'xhigh', 'max'] : [],
      field_sources: merged.field_sources,
      checked_at: new Date().toISOString()
    };
  })();

  try {
    cachedCapabilities = await inFlight;
    cachedAt = Date.now();
    return cachedCapabilities;
  } finally {
    inFlight = null;
  }
}

module.exports = {
  apiRootUrl,
  modelMetadataUrls,
  findModelRecord,
  extractModelMetadata,
  mergeCapabilityValues,
  discoverModelMetadata,
  getModelCapabilities
};
