'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { jsonToDsml, normalizeToolCall } = (() => {
  const serializer = require('../../src/protocol/json-to-dsml');
  const normalizer = require('../../src/protocol/tool-call-normalizer');
  return { ...serializer, normalizeToolCall: normalizer.normalizeToolCall };
})();
const { convertDsmlToBYV } = require('../../src/protocol/dsml-adapter');
const { parseBYVOutput } = require('../../src/protocol/parser');

test('serializes Anthropic tool_use blocks with raw strings and JSON non-string values', () => {
  const output = jsonToDsml({
    type: 'tool_use',
    id: 'toolu_1',
    name: 'mcp__github__create_issue',
    input: {
      title: 'Bug report',
      labels: ['bug', 'urgent'],
      options: { retries: 2, enabled: true },
      dry_run: false,
      payload: null
    }
  });
  assert.match(output, /<｜DSML｜tool_calls>/);
  assert.match(output, /parameter name="title" string="true">Bug report/);
  assert.match(output, /parameter name="labels" string="false">\["bug","urgent"\]/);
  assert.match(output, /parameter name="options" string="false">{"retries":2,"enabled":true}/);
  assert.match(output, /parameter name="dry_run" string="false">false/);
  assert.match(output, /parameter name="payload" string="false">null/);
});

test('normalizes OpenAI-compatible function calls with JSON-string arguments', () => {
  const normalized = normalizeToolCall({
    id: 'call_1',
    type: 'function',
    function: {
      name: 'Bash',
      arguments: '{"command":"npm test","timeout":60000}'
    }
  });
  assert.deepEqual(normalized, {
    id: 'call_1',
    name: 'Bash',
    arguments: { command: 'npm test', timeout: 60000 }
  });
  assert.match(jsonToDsml({
    name: normalized.name,
    arguments: normalized.arguments
  }), /parameter name="timeout" string="false">60000/);
});

test('serializes multiple calls in a single wrapper and supports function_calls alias', () => {
  const output = jsonToDsml([
    { name: 'Bash', arguments: { command: 'git status' } },
    { name: 'Read', arguments: { file_path: 'README.md' } }
  ], { wrapper: 'function_calls' });
  assert.match(output, /^<｜DSML｜function_calls>/);
  assert.equal((output.match(/<｜DSML｜invoke /g) || []).length, 2);
  assert.match(output, /<\/｜DSML｜function_calls>$/);
});

test('serializes dash-prefixed parameter names used by MCP-style tools', () => {
  const output = jsonToDsml({
    name: 'Grep',
    arguments: { '-n': true, '-i': false }
  });
  assert.match(output, /parameter name="-n" string="false">true/);
  assert.match(output, /parameter name="-i" string="false">false/);
});

test('escapes a literal DSML closing tag and round-trips it through the adapter and parser', () => {
  const literal = 'before </｜DSML｜parameter> after';
  const output = jsonToDsml({
    name: 'Write',
    arguments: { content: literal }
  });
  assert.match(output, /before <\\\/｜DSML｜parameter> after/);

  const converted = convertDsmlToBYV(output, { idFactory: () => 'call_1' });
  const parsed = parseBYVOutput(converted.text);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.calls[0].input.content, literal);
});

test('round-trips a reserved DSML delimiter inside nested JSON strings', () => {
  const literal = '</｜DSML｜parameter>';
  const output = jsonToDsml({
    name: 'MCP',
    arguments: { options: { marker: literal }, values: [literal] }
  });
  const converted = convertDsmlToBYV(output, { idFactory: () => 'call_2' });
  const parsed = parseBYVOutput(converted.text);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.calls[0].input, {
    options: { marker: literal },
    values: [literal]
  });
});

test('rejects malformed JSON arguments and invalid tool or parameter names', () => {
  assert.throws(() => jsonToDsml({
    name: 'Bash',
    arguments: '{"command":'
  }), /invalid JSON/);
  assert.throws(() => jsonToDsml({
    name: 'bad tool name',
    arguments: {}
  }), /invalid tool name/i);
  assert.throws(() => jsonToDsml({
    name: 'Bash',
    arguments: { 'invalid name': 'x' }
  }), /Invalid DSML parameter name/);
});

test('rejects non-JSON values instead of silently serializing them as null', () => {
  assert.throws(() => jsonToDsml({
    name: 'Bash',
    arguments: { timeout: Number.POSITIVE_INFINITY }
  }), /non-finite number/);
  assert.throws(() => jsonToDsml({
    name: 'Bash',
    arguments: { command: undefined }
  }), /not a JSON-compatible value/);
});

test('rejects circular objects and empty call batches', () => {
  const input = {};
  input.self = input;
  assert.throws(() => jsonToDsml({ name: 'MCP', arguments: input }), /circular reference/);
  assert.throws(() => jsonToDsml([]), /At least one tool call/);
});
