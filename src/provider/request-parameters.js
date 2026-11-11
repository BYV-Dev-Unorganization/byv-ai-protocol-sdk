'use strict';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function inRange(value, min, max) {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max;
}

function isIntegerInRange(value, min, max) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

function isValidLogitBias(value) {
  if (!isPlainObject(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= 4096 && entries.every(([tokenId, bias]) =>
    /^\d+$/.test(tokenId) && inRange(bias, -100, 100)
  );
}

const PROVIDER_PARAMETER_VALIDATORS = Object.freeze({
  min_p: (value) => inRange(value, 0, 1),
  frequency_penalty: (value) => inRange(value, -2, 2),
  presence_penalty: (value) => inRange(value, -2, 2),
  repetition_penalty: (value) => inRange(value, Number.EPSILON, 2),
  typical_p: (value) => inRange(value, 0, 1),
  top_a: (value) => inRange(value, 0, 1),
  tfs_z: (value) => inRange(value, 0, 1),
  seed: (value) => isIntegerInRange(value, -2147483648, 2147483647),
  logit_bias: isValidLogitBias,
  mirostat: (value) => isIntegerInRange(value, 0, 2),
  mirostat_tau: (value) => inRange(value, Number.EPSILON, 100),
  mirostat_eta: (value) => inRange(value, 0, 1)
});

function validateProviderParams(params) {
  if (params === undefined) return null;
  if (!isPlainObject(params)) {
    return 'Field provider_params must be a JSON object.';
  }

  for (const [key, value] of Object.entries(params)) {
    const validator = PROVIDER_PARAMETER_VALIDATORS[key];
    if (!validator) {
      return 'provider_params.' + key + ' is not supported by the BYV provider-parameter allowlist.';
    }
    if (!validator(value)) {
      return 'provider_params.' + key + ' has an invalid value.';
    }
  }

  return null;
}

module.exports = {
  PROVIDER_PARAMETER_VALIDATORS,
  validateProviderParams
};
