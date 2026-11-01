'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { compileJsonSchema } = require('../src/tools/json-schema');
const { validateMessagesRequest } = require('../src/anthropic-contract');
const { validateToolCalls } = require('../src/tools/validator');

const DIALECTS = [
  ['Draft-07 (default)', null],
  ['Draft 2020-12', 'https://json-schema.org/draft/2020-12/schema']
];

function uriSchema(dialect) {
  return {
    ...(dialect ? { $schema: dialect } : {}),
    type: 'object',
    required: ['url'],
    properties: {
      url: { type: 'string', format: 'uri' }
    },
    additionalProperties: false
  };
}

test('registers URI format on both JSON Schema validators and rejects malformed values', () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));

  try {
    for (const [label, dialect] of DIALECTS) {
      const schema = uriSchema(dialect);
      const validate = compileJsonSchema(schema);

      assert.equal(
        validate({ url: 'https://example.com/path?query=value#section' }),
        true,
        label + ' should accept a valid absolute URI'
      );

      assert.equal(
        validate({ url: 'not a valid URI' }),
        false,
        label + ' should reject a malformed URI'
      );
      assert.ok(
        (validate.errors || []).some((error) => error.keyword === 'format' && error.params.format === 'uri'),
        label + ' should report a URI format validation error'
      );

      assert.equal(
        validateMessagesRequest({
          model: 'byv-flash-v1',
          max_tokens: 64,
          messages: [{ role: 'user', content: 'Open this URL' }],
          tools: [{ name: 'OpenURL', input_schema: schema }]
        }),
        null,
        label + ' declaration should pass Messages contract validation'
      );

      const validCall = validateToolCalls([{
        id: 'uri-valid-' + label,
        name: 'OpenURL',
        input: { url: 'https://example.com/path' }
      }], [{ name: 'OpenURL', input_schema: schema }]);
      assert.deepEqual(validCall, { valid: true, error: null });

      const invalidCall = validateToolCalls([{
        id: 'uri-invalid-' + label,
        name: 'OpenURL',
        input: { url: 'not a valid URI' }
      }], [{ name: 'OpenURL', input_schema: schema }]);
      assert.match(invalidCall.error, /format "uri"/);
    }
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(
    warnings,
    [],
    'known JSON Schema formats must not emit Ajv unknown-format warnings'
  );
});
