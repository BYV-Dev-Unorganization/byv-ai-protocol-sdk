'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateToolCalls } = require('../src/tools/validator');

const tools = [{
  name: 'Configure',
  input_schema: {
    type: 'object',
    required: ['mode', 'options'],
    properties: {
      mode: { type: 'string', enum: ['safe', 'fast'] },
      options: {
        type: 'object',
        required: ['retries', 'flags'],
        properties: {
          retries: { type: 'integer', minimum: 0, maximum: 5 },
          flags: {
            type: 'array',
            minItems: 1,
            items: { type: 'boolean' }
          }
        },
        additionalProperties: false
      }
    },
    additionalProperties: false
  }
}];

function call(input) {
  return [{ id: 'configure-1', name: 'Configure', input }];
}

test('validates nested objects, arrays, enums, and numeric bounds', () => {
  const valid = validateToolCalls(call({
    mode: 'safe',
    options: { retries: 3, flags: [true, false] }
  }), tools);
  assert.deepEqual(valid, { valid: true, error: null });

  const badEnum = validateToolCalls(call({
    mode: 'dangerous',
    options: { retries: 3, flags: [true] }
  }), tools);
  assert.match(badEnum.error, /must be equal to one of the allowed values/);

  const badNestedType = validateToolCalls(call({
    mode: 'fast',
    options: { retries: 6, flags: [true, 'yes'] }
  }), tools);
  assert.match(badNestedType.error, /must be <= 5|must be boolean/);
});

test('rejects undeclared properties at nested schema boundaries', () => {
  const result = validateToolCalls(call({
    mode: 'safe',
    unexpected: true,
    options: { retries: 1, flags: [true], extra: 'no' }
  }), tools);
  assert.match(result.error, /additional properties/);
});
