'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { maskMarkdownCode } = require('../src/protocol/markdown-code');

test('masks BYV and DSML examples in inline Markdown code', () => {
  const tick = String.fromCharCode(96);
  const source = 'Literal markers ' + tick + '<|BYV| calls>' + tick +
    ' and ' + tick + '<｜DSML｜ calls>' + tick + ' are documentation.';
  const masked = maskMarkdownCode(source);
  assert.equal(masked.includes('<|BYV| calls>'), false);
  assert.equal(masked.includes('<｜DSML｜ calls>'), false);
  assert.match(masked, /are documentation/);
});

test('masks protocol blocks inside fenced Markdown code, preserving surrounding prose', () => {
  const fence = String.fromCharCode(96).repeat(3);
  const source = [
    'Example follows:',
    fence + 'text',
    '<|BYV| calls>',
    '<|BYV| invoke name="Read" id="example"></|BYV| invoke>',
    '</|BYV| calls>',
    fence,
    'This is not an invocation.'
  ].join('\n');
  const masked = maskMarkdownCode(source);
  assert.equal(masked.includes('<|BYV| calls>'), false);
  assert.match(masked, /This is not an invocation/);
});

test('does not mask real protocol outside Markdown code', () => {
  const source = '<|BYV| calls><|BYV| invoke name="Read" id="call_1"></|BYV| invoke></|BYV| calls>';
  assert.equal(maskMarkdownCode(source), source);
});
