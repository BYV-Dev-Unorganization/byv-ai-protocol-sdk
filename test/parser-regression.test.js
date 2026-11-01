'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseBYVOutput } = require('../src/protocol/parser');

test('does not promote legacy TOOL_CALL JSON wrappers into BYV invocations', () => {
  const legacy = '<TOOL_CALL>{"name":"Bash","arguments":{"command":"pwd"}}</TOOL_CALL>';
  const parsed = parseBYVOutput(legacy);
  assert.deepEqual(parsed.calls, []);
  assert.equal(parsed.text, legacy);
});
