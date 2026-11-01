'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { convertAnthropicMessages } = require('../src/content');

test('converts Anthropic tool_use and tool_result blocks to OpenAI-compatible messages', () => {
  const messages = convertAnthropicMessages([
    { role: 'user', content: 'Read a file.' },
    { role: 'assistant', content: [
      { type: 'text', text: 'I will read it.' },
      { type: 'tool_use', id: 'call_read_1', name: 'Read', input: { file_path: 'README.md' } }
    ] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'call_read_1', content: 'FILE_CONTENTS' }
    ] }
  ]);
  assert.deepEqual(messages, [
    { role: 'user', content: 'Read a file.' },
    {
      role: 'assistant',
      content: 'I will read it.',
      tool_calls: [{
        id: 'call_read_1',
        type: 'function',
        function: { name: 'Read', arguments: '{"file_path":"README.md"}' }
      }]
    },
    { role: 'tool', tool_call_id: 'call_read_1', content: 'FILE_CONTENTS' }
  ]);
});

test('rejects orphan tool results and duplicate tool-use IDs', () => {
  assert.throws(() => convertAnthropicMessages([
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'missing', content: 'x' }] }
  ]), /unknown tool_use_id/);
  assert.throws(() => convertAnthropicMessages([
    { role: 'assistant', content: [{ type: 'tool_use', id: 'same', name: 'Read', input: {} }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'same', name: 'Read', input: {} }] }
  ]), /Duplicate or missing/);
});