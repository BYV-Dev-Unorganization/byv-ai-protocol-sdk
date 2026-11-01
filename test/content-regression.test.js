'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  convertAnthropicMessages,
  renderToolResultContent,
  estimateProviderInputTokens
} = require('../src/content');

test('preserves Markdown, code fences, tables, newlines, and Unicode through message conversion', () => {
  const markdown = [
    '# Heading',
    '',
    '| Name | Value |',
    '| --- | --- |',
    '| café | 東京 |',
    '',
    '```js',
    'const greeting = "hello";',
    '```'
  ].join('\n');

  const converted = convertAnthropicMessages([
    { role: 'user', content: [{ type: 'text', text: markdown }] }
  ]);
  assert.equal(converted.length, 1);
  assert.equal(converted[0].role, 'user');
  assert.equal(converted[0].content, markdown);
  assert.ok(estimateProviderInputTokens(converted) > 0);
});

test('preserves textual Markdown returned as a tool result', () => {
  const markdown = '## Result\n\n- first\n- second\n\n`code`';
  assert.equal(renderToolResultContent([{ type: 'text', text: markdown }]), markdown);
});
