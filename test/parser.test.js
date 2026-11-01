'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseBYVOutput, BYVStreamParser, decodeBYVString } = require('../src/protocol/parser');

test('parses multiple invocations, typed JSON values, and preserves BYV invocation IDs', () => {
  const source = [
    'I will inspect the project.',
    '<|BYV| calls>',
    '<|BYV| invoke name="Read" id="call_read_1">',
    '<|BYV| parameter name="file_path" type="string">README.md</|BYV| parameter>',
    '<|BYV| parameter name="options" type="object">{"start":1,"enabled":true}</|BYV| parameter>',
    '</|BYV| invoke>',
    '<|BYV| invoke name="Bash" id="call_bash_2">',
    '<|BYV| parameter name="timeout" type="number">15</|BYV| parameter>',
    '<|BYV| parameter name="dry_run" type="boolean">true</|BYV| parameter>',
    '</|BYV| invoke>',
    '</|BYV| calls>',
    'The tools will return the requested data.'
  ].join('\n');
  const parsed = parseBYVOutput(source);
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.text, 'I will inspect the project.\n\nThe tools will return the requested data.');
  assert.deepEqual(parsed.calls, [
    { id: 'call_read_1', name: 'Read', input: { file_path: 'README.md', options: { start: 1, enabled: true } } },
    { id: 'call_bash_2', name: 'Bash', input: { timeout: 15, dry_run: true } }
  ]);
});

test('decodes BYV string escapes exactly', () => {
  assert.equal(decodeBYVString('one\\\\two\\nthree\\r\\tfour'), 'one\\two\nthree\r\tfour');
  assert.equal(decodeBYVString('literal \\</|BYV| parameter> marker'), 'literal </|BYV| parameter> marker');
});

test('a literal calls-close marker inside a string parameter does not terminate the envelope', () => {
  const source = '<|BYV| calls><|BYV| invoke name="Write" id="write_1">' +
    '<|BYV| parameter name="content" type="string">HTML text </|BYV| calls> still payload</|BYV| parameter>' +
    '</|BYV| invoke></|BYV| calls>';
  const parsed = parseBYVOutput(source);
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.calls[0].input.content, 'HTML text </|BYV| calls> still payload');
});

test('rejects duplicate invocation IDs and duplicate parameters', () => {
  const duplicateId = '<|BYV| calls>' +
    '<|BYV| invoke name="Read" id="same"></|BYV| invoke>' +
    '<|BYV| invoke name="Write" id="same"></|BYV| invoke>' +
    '</|BYV| calls>';
  assert.match(parseBYVOutput(duplicateId).errors[0], /Duplicate BYV invocation id/);

  const duplicateParameter = '<|BYV| calls><|BYV| invoke name="Read" id="one">' +
    '<|BYV| parameter name="path" type="string">a</|BYV| parameter>' +
    '<|BYV| parameter name="path" type="string">b</|BYV| parameter>' +
    '</|BYV| invoke></|BYV| calls>';
  assert.match(parseBYVOutput(duplicateParameter).errors[0], /Duplicate BYV parameter/);
});

test('rejects invalid typed JSON rather than coercing values', () => {
  const source = '<|BYV| calls><|BYV| invoke name="Bash" id="call_1">' +
    '<|BYV| parameter name="timeout" type="number">ten</|BYV| parameter>' +
    '</|BYV| invoke></|BYV| calls>';
  assert.match(parseBYVOutput(source).errors[0], /invalid JSON/);
});

test('stream parser handles every possible chunk boundary', () => {
  const source = '<|BYV| calls><|BYV| invoke name="Read" id="call_1">' +
    '<|BYV| parameter name="file_path" type="string">src/index.js</|BYV| parameter>' +
    '</|BYV| invoke></|BYV| calls>';
  const parser = new BYVStreamParser();
  for (let i = 0; i < source.length; i++) parser.feed(source[i]);
  const result = parser.finish();
  assert.equal(result.errors.length, 0);
  assert.deepEqual(result.calls, [{ id: 'call_1', name: 'Read', input: { file_path: 'src/index.js' } }]);
});

test('rejects multiple outer calls blocks and incomplete protocol markup', () => {
  const twice = '<|BYV| calls><|BYV| invoke name="Read" id="a"></|BYV| invoke></|BYV| calls>' +
    '<|BYV| calls><|BYV| invoke name="Read" id="b"></|BYV| invoke></|BYV| calls>';
  assert.match(parseBYVOutput(twice).errors[0], /Only one outer/);
  assert.match(parseBYVOutput('<|BYV| calls>').errors[0], /incomplete/);
});
test('accepts valid BYV header attributes regardless of order', () => {
  const source = '<|BYV| calls><|BYV| invoke id="call_1" name="Read">' +
    '<|BYV| parameter type="string" name="file_path">README.md</|BYV| parameter>' +
    '</|BYV| invoke></|BYV| calls>';
  const parsed = parseBYVOutput(source);
  assert.equal(parsed.errors.length, 0);
  assert.deepEqual(parsed.calls, [
    { id: 'call_1', name: 'Read', input: { file_path: 'README.md' } }
  ]);
});
