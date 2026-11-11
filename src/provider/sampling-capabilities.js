'use strict';

const {
  PROVIDER_BASE_URL,
  PROVIDER_API_KEY,
  PROVIDER_MODEL,
  PROVIDER_MODEL_METADATA_TIMEOUT_MS,
  PROVIDER_CAPABILITIES_CACHE_MS,
  PROVIDER_SAMPLING_AUTO_PROBE,
  PROVIDER_SAMPLING_PROBE_TIMEOUT_MS,
  PROVIDER_SUPPORTED_SAMPLING_PARAMETERS
} = require('../config');
const { apiRootUrl, modelMetadataUrls, findModelRecord } = require('./capabilities');

const PROBE_VALUES = Object.freeze({
  temperature: 0.2,
  top_p: 0.9,
  top_k: 40,
  min_p: 0.05,
  frequency_penalty: 0.2,
  presence_penalty: 0.1,
  repetition_penalty: 1.1,
  typical_p: 0.95,
  top_a: 0.1,
  tfs_z: 0.9,
  seed: 42,
  mirostat: 1,
  mirostat_tau: 5,
  mirostat_eta: 0.1
});

const PROBE_PARAMETER_NAMES = Object.freeze(Object.keys(PROBE_VALUES));
const FILTERED_TOP_LEVEL_FIELDS = Object.freeze([
  'temperature',
  'top_p',
  'top_k',
  'reasoning_effort'
]);

function uniqueStrings(value) {
  if (!Array.isArray(value)) return null;
  const result = [];
  for (const entry of value) {
    if (typeof entry === 'string' && entry.trim() && !result.includes(entry.trim())) {
      result.push(entry.trim());
    }
  }
  return result;
}

function extractReasoningEffortLevels(payload, model) {
  const record = findModelRecord(payload, model);
  if (!record) return null;
  const candidates = [
    record,
    record.capabilities,
    record.reasoning,
    record.top_provider,
    record.topProvider
  ];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    for (const key of [
      'supported_reasoning_efforts',
      'reasoning_efforts',
      'supported_effort_levels'
    ]) {
      const values = uniqueStrings(candidate[key]);
      if (values !== null) {
        return values.filter((value) =>
          ['low', 'medium', 'high', 'xhigh', 'max'].includes(value)
        );
      }
    }
  }
  return null;
}

const REASONING_EFFORT_LEVELS = Object.freeze([
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
]);

function extractSupportedParameters(payload, model) {
  const record = findModelRecord(payload, model);
  if (!record) return null;

  const candidates = [
    record,
    record.capabilities,
    record.top_provider,
    record.topProvider
  ];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    for (const key of ['supported_parameters', 'supportedParameters', 'supported_params']) {
      const parameters = uniqueStrings(candidate[key]);
      if (parameters !== null) return parameters;
    }
  }
  return null;
}

function samplingMetadataUrls(baseUrl, model) {
  return modelMetadataUrls(baseUrl, model);
}

async function fetchJson(url, timeoutMs = PROVIDER_MODEL_METADATA_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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
    clearTimeout(timer);
  }
}

async function discoverSupportedParametersFromMetadata() {
  if (!PROVIDER_BASE_URL || !PROVIDER_MODEL) {
    return { supportedParameters: null, reasoningEffortLevels: null, status: 'not_configured' };
  }

  let urls;
  try {
    urls = samplingMetadataUrls(PROVIDER_BASE_URL, PROVIDER_MODEL);
  } catch {
    return { supportedParameters: null, reasoningEffortLevels: null, status: 'unavailable' };
  }

  // Prefer the exact model-detail resource, then inspect the model catalog.
  // OpenRouter exposes supported_parameters in its model catalog; other
  // compatible providers may publish the same optional metadata.
  for (const url of [urls.detail, urls.collection]) {
    const response = await fetchJson(url);
    if (!response.ok) continue;
    const supportedParameters = extractSupportedParameters(response.payload, PROVIDER_MODEL);
    if (supportedParameters !== null) {
      return {
        supportedParameters,
        reasoningEffortLevels: extractReasoningEffortLevels(response.payload, PROVIDER_MODEL),
        status: 'available'
      };
    }
  }

  return { supportedParameters: null, status: 'unavailable' };
}

function chatCompletionsUrl(baseUrl) {
  const root = apiRootUrl(baseUrl);
  root.pathname = root.pathname.replace(/\/+$/, '') + '/chat/completions';
  return root.toString();
}

async function probeRequest(extraFields = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_SAMPLING_PROBE_TIMEOUT_MS);
  try {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    };
    if (PROVIDER_API_KEY) headers.Authorization = 'Bearer ' + PROVIDER_API_KEY;

    const response = await fetch(chatCompletionsUrl(PROVIDER_BASE_URL), {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: PROVIDER_MODEL,
        messages: [{ role: 'user', content: 'Reply with OK.' }],
        max_tokens: 1,
        stream: false,
        ...extraFields
      })
    });

    // A 2xx response proves request-level acceptance, not that a provider
    // actually applied the setting internally.
    if (response.ok) {
      try { await response.body?.cancel(); } catch {}
      return { supported: true, status: response.status };
    }

    const detail = await response.text().catch(() => '');
    if (response.status === 400 || response.status === 422) {
      return { supported: false, status: response.status, detail: detail.slice(0, 500) };
    }
    return { supported: null, status: response.status, detail: detail.slice(0, 500) };
  } catch (error) {
    return {
      supported: null,
      status: 0,
      detail: error && error.name === 'AbortError' ? 'probe_timeout' : 'probe_unavailable'
    };
  } finally {
    clearTimeout(timer);
  }
}

async function probeReasoningEffortLevels() {
  const levels = [];
  const unknown = [];
  for (const effort of REASONING_EFFORT_LEVELS) {
    const result = await probeRequest({ reasoning_effort: effort });
    if (result.supported === true) levels.push(effort);
    else if (result.supported === null) {
      unknown.push(effort);
      break;
    }
  }
  return { levels, unknown };
}

function mapMetadataParameters(supportedParameters) {
  const reported = new Set(supportedParameters);
  const parameters = {};
  for (const name of [...PROBE_PARAMETER_NAMES, 'reasoning_effort', 'logit_bias']) {
    parameters[name] = reported.has(name);
  }
  return parameters;
}

function parseManualSupportedParameters(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const values = raw.split(',').map((value) => value.trim()).filter(Boolean);
  const allowed = new Set([...PROBE_PARAMETER_NAMES, 'reasoning_effort', 'logit_bias']);
  const invalid = values.filter((value) => !allowed.has(value));
  if (invalid.length) {
    return { error: 'Unknown sampling parameter(s) in PROVIDER_SUPPORTED_SAMPLING_PARAMETERS: ' + invalid.join(', ') };
  }
  return { values: [...new Set(values)] };
}

function buildSnapshot(parameters, source, status, extras = {}) {
  const supported = Object.keys(parameters).filter((name) => parameters[name] === true);
  const unsupported = Object.keys(parameters).filter((name) => parameters[name] === false);
  const unknown = Object.keys(parameters).filter((name) => parameters[name] === null);
  return {
    provider_model: PROVIDER_MODEL || null,
    status,
    source,
    parameters,
    supported_parameters: supported,
    unsupported_parameters: unsupported,
    unknown_parameters: unknown,
    reasoning_effort_levels: extras.reasoning_effort_levels === undefined ? null : extras.reasoning_effort_levels,
    unknown_reasoning_effort_levels: extras.unknown_reasoning_effort_levels || [],
    checked_at: new Date().toISOString(),
    ...extras
  };
}

async function probeSamplingParameters() {
  const parameters = Object.fromEntries(
    [...PROBE_PARAMETER_NAMES, 'reasoning_effort', 'logit_bias'].map((name) => [name, null])
  );

  if (!PROVIDER_BASE_URL || !PROVIDER_MODEL) {
    return buildSnapshot(parameters, 'unknown', 'not_configured');
  }
  if (!PROVIDER_SAMPLING_AUTO_PROBE) {
    return buildSnapshot(parameters, 'unknown', 'probe_disabled');
  }

  const baseline = await probeRequest();
  if (baseline.supported !== true) {
    return buildSnapshot(parameters, 'active_probe', 'baseline_unavailable', {
      baseline_status: baseline.status,
      baseline_detail: baseline.detail || null
    });
  }

  let inconclusive = false;
  for (const [name, value] of Object.entries(PROBE_VALUES)) {
    const result = await probeRequest({ [name]: value });
    parameters[name] = result.supported;
    if (result.supported === null) {
      // Authentication, quota, rate-limit, server, and network failures make
      // the remaining fields unknown. Fail closed rather than guessing.
      inconclusive = true;
      break;
    }
  }

  const effortResult = inconclusive
    ? { levels: [], unknown: REASONING_EFFORT_LEVELS.slice() }
    : await probeReasoningEffortLevels();
  parameters.reasoning_effort = effortResult.levels.length > 0
    ? true
    : effortResult.unknown.length > 0 ? null : false;

  return buildSnapshot(parameters, 'active_probe', 'available', {
    baseline_status: baseline.status,
    reasoning_effort_levels: effortResult.levels,
    unknown_reasoning_effort_levels: effortResult.unknown,
    probe_timeout_ms: PROVIDER_SAMPLING_PROBE_TIMEOUT_MS
  });
}

async function discoverSamplingCapabilities() {
  if (!PROVIDER_BASE_URL || !PROVIDER_MODEL) {
    return buildSnapshot(
      Object.fromEntries([...PROBE_PARAMETER_NAMES, 'reasoning_effort', 'logit_bias'].map((name) => [name, null])),
      'unknown',
      'not_configured'
    );
  }

  const manual = parseManualSupportedParameters(PROVIDER_SUPPORTED_SAMPLING_PARAMETERS);
  if (manual && manual.error) {
    return buildSnapshot(
      Object.fromEntries([...PROBE_PARAMETER_NAMES, 'reasoning_effort', 'logit_bias'].map((name) => [name, null])),
      'unknown',
      'invalid_manual_override',
      { warning: manual.error }
    );
  }
  if (manual) {
    const parameters = mapMetadataParameters(manual.values);
    let effortLevels = null;
    let unknownEffortLevels = [];
    if (parameters.reasoning_effort === true && PROVIDER_SAMPLING_AUTO_PROBE) {
      const effortResult = await probeReasoningEffortLevels();
      effortLevels = effortResult.levels;
      unknownEffortLevels = effortResult.unknown;
      parameters.reasoning_effort = effortLevels.length > 0
        ? true
        : unknownEffortLevels.length > 0 ? null : false;
    }
    return buildSnapshot(
      parameters,
      'environment',
      'available',
      {
        note: 'Explicit allowlist; fields not listed are disabled.',
        reasoning_effort_levels: effortLevels,
        unknown_reasoning_effort_levels: unknownEffortLevels
      }
    );
  }

  const metadata = await discoverSupportedParametersFromMetadata();
  if (metadata.supportedParameters !== null) {
    const parameters = mapMetadataParameters(metadata.supportedParameters);
    let effortLevels = metadata.reasoningEffortLevels;
    let unknownEffortLevels = [];
    if (parameters.reasoning_effort === true && effortLevels === null && PROVIDER_SAMPLING_AUTO_PROBE) {
      const effortResult = await probeReasoningEffortLevels();
      effortLevels = effortResult.levels;
      unknownEffortLevels = effortResult.unknown;
      parameters.reasoning_effort = effortLevels.length > 0
        ? true
        : unknownEffortLevels.length > 0 ? null : false;
    }
    const isOpenRouter = (() => {
      try { return new URL(PROVIDER_BASE_URL).hostname === 'openrouter.ai'; } catch { return false; }
    })();
    return buildSnapshot(parameters, 'provider_metadata', 'available', {
      metadata_status: metadata.status,
      // OpenRouter's model-level list is the union of its serving endpoints.
      // This request hint makes its router choose an endpoint that honors
      // every optional field BYV sends.
      provider_require_parameters: isOpenRouter,
      reasoning_effort_levels: effortLevels,
      unknown_reasoning_effort_levels: unknownEffortLevels
    });
  }

  const probed = await probeSamplingParameters();
  return {
    ...probed,
    metadata_status: metadata.status
  };
}

let cachedCapabilities = null;
let cachedAt = 0;
let inFlight = null;

async function getSamplingCapabilities(options = {}) {
  const forceRefresh = options.forceRefresh === true;
  if (!forceRefresh && cachedCapabilities && Date.now() - cachedAt < PROVIDER_CAPABILITIES_CACHE_MS) {
    return cachedCapabilities;
  }
  if (!forceRefresh && inFlight) return inFlight;

  inFlight = discoverSamplingCapabilities();
  try {
    cachedCapabilities = await inFlight;
    cachedAt = Date.now();
    return cachedCapabilities;
  } finally {
    inFlight = null;
  }
}

function filterSamplingOptions(options = {}, capabilities = {}) {
  const filtered = { ...options };
  const parameters = capabilities.parameters && typeof capabilities.parameters === 'object'
    ? capabilities.parameters
    : {};
  const omitted = [];

  for (const field of FILTERED_TOP_LEVEL_FIELDS) {
    if (filtered[field] === undefined || filtered[field] === null) continue;
    if (parameters[field] !== true) {
      delete filtered[field];
      omitted.push(field);
      continue;
    }
    if (field === 'reasoning_effort') {
      const levels = capabilities.reasoning_effort_levels;
      if (!Array.isArray(levels) || !levels.includes(filtered[field])) {
        delete filtered[field];
        omitted.push(field);
      }
    }
  }

  if (filtered.provider_params && typeof filtered.provider_params === 'object') {
    const accepted = {};
    for (const [name, value] of Object.entries(filtered.provider_params)) {
      if (parameters[name] === true) accepted[name] = value;
      else omitted.push(name);
    }
    if (Object.keys(accepted).length) filtered.provider_params = accepted;
    else delete filtered.provider_params;
  }

  if (capabilities.provider_require_parameters === true) {
    filtered.provider = {
      ...(filtered.provider && typeof filtered.provider === 'object' ? filtered.provider : {}),
      require_parameters: true
    };
  }

  return { options: filtered, omitted: [...new Set(omitted)] };
}

module.exports = {
  PROBE_VALUES,
  PROBE_PARAMETER_NAMES,
  REASONING_EFFORT_LEVELS,
  extractSupportedParameters,
  extractReasoningEffortLevels,
  samplingMetadataUrls,
  discoverSupportedParametersFromMetadata,
  parseManualSupportedParameters,
  discoverSamplingCapabilities,
  getSamplingCapabilities,
  filterSamplingOptions
};
