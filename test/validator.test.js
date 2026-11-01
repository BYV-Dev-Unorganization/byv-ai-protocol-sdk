'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateToolCalls } = require('../src/tools/validator');

const tools = [{
  name: 'Read',
  input_schema: {
    type: 'object',
    required: ['file_path'],
    properties: {
      file_path: { type: 'string', minLength: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 100 }
    },
    additionalProperties: false
  }
}];

test('validates a schema-conforming invocation', () => {
  assert.deepEqual(validateToolCalls([{
    id: 'call_1',
    name: 'Read',
    input: { file_path: 'README.md', limit: 20 }
  }], tools), { valid: true, error: null });
});

test('rejects undeclared tools, missing required values, and invalid types', () => {
  assert.match(validateToolCalls([{ id: 'a', name: 'Write', input: {} }], tools).error, /not declared/);
  assert.match(validateToolCalls([{ id: 'b', name: 'Read', input: {} }], tools).error, /required/);
  assert.match(validateToolCalls([{ id: 'c', name: 'Read', input: { file_path: 7 } }], tools).error, /must be string/);
});

test('rejects additional properties and duplicate invocation IDs', () => {
  assert.match(validateToolCalls([{
    id: 'x', name: 'Read', input: { file_path: 'a', extra: true }
  }], tools).error, /must NOT have additional properties/);
  assert.match(validateToolCalls([
    { id: 'duplicate', name: 'Read', input: { file_path: 'a' } },
    { id: 'duplicate', name: 'Read', input: { file_path: 'b' } }
  ], tools).error, /Duplicate invocation id/);
});

test('limits the number of calls in a batch', () => {
  const calls = Array.from({ length: 3 }, (_, i) => ({
    id: 'call_' + i, name: 'Read', input: { file_path: 'a' }
  }));
  assert.match(validateToolCalls(calls, tools, { maxCalls: 2 }).error, /maximum of 2/);
});