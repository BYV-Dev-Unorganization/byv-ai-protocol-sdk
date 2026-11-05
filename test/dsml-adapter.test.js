'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { convertDsmlToBYV } = require('../src/protocol/dsml-adapter');
const { parseBYVOutput } = require('../src/protocol/parser');

test('converts a standard DeepSeek DSML calls block into the existing BYV parser contract', () => {
  const source = [
    'Before the call.',
    '<｜DSML｜ calls>',
    '<｜DSML｜ invoke name="Read">',
    '<｜DSML｜ parameter name="file_path" string="true">README.md</｜DSML｜ parameter>',
    '</｜DSML｜ invoke>',
    '</｜DSML｜ calls>',
    'After the call.'
  ].join('\n');

  const adapted = convertDsmlToBYV(source, { idFactory: (index) => 'dsml_call_' + String(index).padStart(3, '0') });
  assert.equal(adapted.detected, true);
  assert.match(adapted.text, /<\|BYV\| invoke name="Read" id="dsml_call_001">/);

  const parsed = parseBYVOutput(adapted.text);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.text, 'Before the call.\n\nAfter the call.');
  assert.deepEqual(parsed.calls, [{
    id: 'dsml_call_001',
    name: 'Read',
    input: { file_path: 'README.md' }
  }]);
});

test('generates different invocation IDs across separate DSML responses', () => {
  const source = '<|DSML| calls><|DSML| invoke name="Read"></|DSML| invoke></|DSML| calls>';
  const first = parseBYVOutput(convertDsmlToBYV(source).text);
  const second = parseBYVOutput(convertDsmlToBYV(source).text);
  assert.notEqual(first.calls[0].id, second.calls[0].id);
});

test('converts DSML string flags into the matching BYV JSON value types', () => {
  const source = [
    '<|DSML|tool_calls>',
    '<|DSML|invoke name="Write">',
    '<|DSML|parameter name="content" string="true">line one\nline two\\tail</|DSML|parameter>',
    '<|DSML|parameter name="enabled" string="false">true</|DSML|parameter>',
    '<|DSML|parameter name="count" string="false">12</|DSML|parameter>',
    '<|DSML|parameter name="nothing" string="false">null</|DSML|parameter>',
    '<|DSML|parameter name="items" string="false">["a","b"]</|DSML|parameter>',
    '<|DSML|parameter name="metadata" string="false">{"mode":"safe"}</|DSML|parameter>',
    '<|DSML|parameter name="quoted" string="false">"literal </|BYV| parameter> marker"</|DSML|parameter>',
    '</|DSML|invoke>',
    '</|DSML|tool_calls>'
  ].join('');

  const adapted = convertDsmlToBYV(source);
  const parsed = parseBYVOutput(adapted.text);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.calls[0].input, {
    content: 'line one\nline two\\tail',
    enabled: true,
    count: 12,
    nothing: null,
    items: ['a', 'b'],
    metadata: { mode: 'safe' },
    quoted: 'literal </|BYV| parameter> marker'
  });
});

test('supports ASCII DSML pipe delimiters and single-quoted attributes', () => {
  const source = "<|DSML| calls><|DSML| invoke name='Read'>" +
    "<|DSML| parameter name='file_path' string='true'>README.md</|DSML| parameter>" +
    '</|DSML| invoke></|DSML| calls>';
  const parsed = parseBYVOutput(convertDsmlToBYV(source).text);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.calls[0].name, 'Read');
  assert.deepEqual(parsed.calls[0].input, { file_path: 'README.md' });
});

test('leaves ordinary text unchanged when no DSML markup is present', () => {
  const source = 'This is ordinary assistant text.';
  assert.deepEqual(convertDsmlToBYV(source), { text: source, detected: false });
});

test('malformed DSML is converted into malformed BYV for the unchanged parser to reject', () => {
  const source = '<|DSML| calls><|DSML| invoke name="Read">' +
    '<|DSML| parameter name="file_path">README.md</|DSML| parameter>' +
    '</|DSML| invoke></|DSML| calls>';
  const adapted = convertDsmlToBYV(source);
  const parsed = parseBYVOutput(adapted.text);
  assert.equal(adapted.detected, true);
  assert.match(parsed.errors[0], /Unsupported BYV parameter type: invalid/);
});


test('does not convert DSML examples inside inline or fenced Markdown code', () => {
  const tick = String.fromCharCode(96);
  const fence = tick.repeat(3);
  const source = [
    'The syntax ' + tick + '<｜DSML｜ calls>' + tick + ' is documentation.',
    fence + 'text',
    '<｜DSML｜ calls>',
    '<｜DSML｜ invoke name="Read">',
    '<｜DSML｜ parameter name="file_path" string="true">README.md</｜DSML｜ parameter>',
    '</｜DSML｜ invoke>',
    '</｜DSML｜ calls>',
    fence,
    'No tool should execute.'
  ].join('\n');
  const result = convertDsmlToBYV(source);
  assert.equal(result.detected, false);
  assert.equal(result.text, source);
});
