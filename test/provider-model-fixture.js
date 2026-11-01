'use strict';

const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// Live .env / process environment always wins. CI can omit provider credentials
// because these tests stub fetch; the fallback is only a mock model identifier.
function resolveProviderModel(overrides = {}) {
  const configured = overrides.PROVIDER_MODEL !== undefined
    ? overrides.PROVIDER_MODEL
    : process.env.PROVIDER_MODEL;
  const model = String(configured || '').trim();
  return model || 'byv-regression-test-model';
}

module.exports = { resolveProviderModel };
