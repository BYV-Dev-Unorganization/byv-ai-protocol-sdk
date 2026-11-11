'use strict';

const SAMPLING_PROBE_PARAMETERS = Object.freeze({
  temperature: 0.7,
  top_p: 0.9,
  top_k: 40,
  min_p: 0.05,
  frequency_penalty: 0,
  presence_penalty: 0,
  repetition_penalty: 1,
  typical_p: 0.95,
  top_a: 0.1,
  tfs_z: 0.9,
  seed: 1,
  logit_bias: Object.freeze({ '0': 0 }),
  mirostat: 0,
  mirostat_tau: 5,
  mirostat_eta: 0.1
});

const SAMPLING_PARAMETER_NAMES = Object.freeze(Object.keys(SAMPLING_PROBE_PARAMETERS));
let cachedCapabilities = null;
let inFlight = null;

function createResult({
  enabled = true,
  status,
  accepted = [],
  rejected = [],
  unknown = [],
  probeRequests = 0,
  error = null
}) {
  return {
    enabled,
    status,
    accepted_parameters: accepted,
    rejected_parameters: rejected,
    unknown_parameters: unknown,
    probe_requests: probeRequests,
    checked_at: enabled ? new Date().toISOString() : null,
    error: error || null
  };
}

function isParameterRejection(result) {
  return result && (result.status === 400 || result.status === 422);
}

async function initializeProviderSamplingCapabilities(options = {}) {
  if (options.enabled !== true) {
    return createResult({
      enabled: false,
      status: 'disabled'
    });
  }

  if (cachedCapabilities && options.forceRefresh !== true) return cachedCapabilities;
  if (inFlight && options.forceRefresh !== true) return inFlight;

  if (typeof options.probe !== 'function') {
    return createResult({
      status: 'unavailable',
      unknown: SAMPLING_PARAMETER_NAMES,
      error: 'No provider sampling probe function was supplied.'
    });
  }

  inFlight = (async () => {
    let probeRequests = 0;
    let batchResult;

    try {
      batchResult = await options.probe({ ...SAMPLING_PROBE_PARAMETERS });
      probeRequests++;
    } catch (error) {
      return createResult({
        status: 'unavailable',
        unknown: SAMPLING_PARAMETER_NAMES,
        error: String(error && error.message || error).slice(0, 500)
      });
    }

    if (batchResult && batchResult.ok === true) {
      return createResult({
        status: 'available',
        accepted: SAMPLING_PARAMETER_NAMES,
        probeRequests
      });
    }

    if (!isParameterRejection(batchResult)) {
      return createResult({
        status: 'unavailable',
        unknown: SAMPLING_PARAMETER_NAMES,
        probeRequests,
        error: batchResult && batchResult.error
          ? String(batchResult.error).slice(0, 500)
          : 'The provider sampling probe could not be completed.'
      });
    }

    // A combined request can fail because one field is unsupported or because
    // the provider disallows a combination. Isolate each field before classifying it.
    const accepted = [];
    const rejected = [];
    const unknown = [];
    let error = batchResult.error ? String(batchResult.error).slice(0, 500) : null;

    for (let index = 0; index < SAMPLING_PARAMETER_NAMES.length; index++) {
      const name = SAMPLING_PARAMETER_NAMES[index];
      let result;
      try {
        result = await options.probe({ [name]: SAMPLING_PROBE_PARAMETERS[name] });
        probeRequests++;
      } catch (probeError) {
        result = {
          ok: false,
          status: 0,
          error: String(probeError && probeError.message || probeError).slice(0, 500)
        };
      }

      if (result && result.ok === true) {
        accepted.push(name);
        continue;
      }

      if (isParameterRejection(result)) {
        rejected.push(name);
        error = result.error ? String(result.error).slice(0, 500) : error;
        continue;
      }

      unknown.push(...SAMPLING_PARAMETER_NAMES.slice(index));
      error = result && result.error
        ? String(result.error).slice(0, 500)
        : 'Provider sampling detection was interrupted by a non-validation error.';
      break;
    }

    const status = unknown.length
      ? 'partial'
      : accepted.length === 0
        ? 'none_supported'
        : rejected.length === 0
          ? 'available'
          : 'partial';

    return createResult({
      status,
      accepted,
      rejected,
      unknown,
      probeRequests,
      error
    });
  })();

  try {
    cachedCapabilities = await inFlight;
    return cachedCapabilities;
  } finally {
    inFlight = null;
  }
}

function getProviderSamplingCapabilities() {
  return cachedCapabilities;
}

function resetProviderSamplingCapabilities() {
  cachedCapabilities = null;
  inFlight = null;
}

module.exports = {
  SAMPLING_PROBE_PARAMETERS,
  SAMPLING_PARAMETER_NAMES,
  initializeProviderSamplingCapabilities,
  getProviderSamplingCapabilities,
  resetProviderSamplingCapabilities
};
