'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { convertDsmlToBYV } = require('../../src/protocol/dsml-adapter');
const { parseBYVOutput } = require('../../src/protocol/parser');

for (const wrapper of ['calls', 'tool_calls', 'function_calls']) {
  test('adapter normalizes DSML ' + wrapper + ' wrapper to the internal BYV calls block', () => {
    const input = '<｜DSML｜' + wrapper + '><｜DSML｜invoke name="Bash">' +
      '<｜DSML｜parameter name="command" string="true">pwd</｜DSML｜parameter>' +
      '</｜DSML｜invoke></｜DSML｜' + wrapper + '>';
    const adapted = convertDsmlToBYV(input, { idFactory: () => 'call_' + wrapper });
    const parsed = parseBYVOutput(adapted.text);
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.calls.length, 1);
    assert.equal(parsed.calls[0].name, 'Bash');
    assert.deepEqual(parsed.calls[0].input, { command: 'pwd' });
  });
}

test('adapter restores escaped literal DSML parameter-closing tags in string values', () => {
  const input = '<｜DSML｜tool_calls><｜DSML｜invoke name="Write">' +
    '<｜DSML｜parameter name="content" string="true">before <\\/｜DSML｜parameter> after</｜DSML｜parameter>' +
    '</｜DSML｜invoke></｜DSML｜tool_calls>';
  const adapted = convertDsmlToBYV(input, { idFactory: () => 'call_escape' });
  const parsed = parseBYVOutput(adapted.text);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.calls[0].input.content, 'before </｜DSML｜parameter> after');
});

test('adapter accepts dash-prefixed parameter names', () => {
  const input = '<｜DSML｜calls><｜DSML｜invoke name="Grep">' +
    '<｜DSML｜parameter name="-n" string="false">true</｜DSML｜parameter>' +
    '</｜DSML｜invoke></｜DSML｜calls>';
  const adapted = convertDsmlToBYV(input, { idFactory: () => 'call_dash' });
  const parsed = parseBYVOutput(adapted.text);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.calls[0].input, { '-n': true });
});
