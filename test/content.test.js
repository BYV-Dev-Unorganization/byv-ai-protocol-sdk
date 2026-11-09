'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { convertAnthropicMessages, estimateProviderInputTokens } = require('../src/content');

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

test('rejects duplicate tool_result blocks for the same invocation', () => {
  assert.throws(() => convertAnthropicMessages([
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_once', name: 'Read', input: {} }] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'call_once', content: 'first' },
      { type: 'tool_result', tool_use_id: 'call_once', content: 'second' }
    ] }
  ]), /Duplicate tool_result/);
});


test('estimates the provider-shaped payload including UTF-8 content and message overhead', () => {
  const estimate = estimateProviderInputTokens([
    { role: 'system', content: 'BYV system prompt' },
    { role: 'user', content: 'Halo 世界 👋' }
  ]);
  assert.ok(Number.isInteger(estimate));
  assert.ok(estimate > 1);
});


test('DSML mode converts historical tool_use into DSML and tool_result into structured user content', () => {
  const messages = convertAnthropicMessages([
    { role: 'user', content: 'Run the command and summarize the result.' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'I will inspect the repository.' },
        { type: 'tool_use', id: 'toolu_bash_1', name: 'Bash', input: { command: 'git status --short' } }
      ]
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_bash_1', content: ' M src/handler.js' }]
    }
  ], { nativeToolCalling: false });

  assert.equal(messages.length, 3);
  assert.equal(messages[1].role, 'assistant');
  assert.match(messages[1].content, /HISTORICAL TOOL INVOCATIONS/);
  assert.match(messages[1].content, /<｜DSML｜tool_calls>/);
  assert.match(messages[1].content, /parameter name="command" string="true">git status --short/);
  assert.equal(Object.prototype.hasOwnProperty.call(messages[1], 'tool_calls'), false);
  assert.equal(messages[2].role, 'user');
  assert.match(messages[2].content, /HISTORICAL TOOL RESULTS/);
  assert.match(messages[2].content, /"tool_use_id": "toolu_bash_1"/);
  assert.match(messages[2].content, /"tool_name": "Bash"/);
  assert.match(messages[2].content, /M src\/handler\.js/);
  assert.equal(messages.some((message) => message.role === 'tool'), false);
});

test('DSML history preserves multiple calls and associates each result with its tool name', () => {
  const messages = convertAnthropicMessages([
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: 'README.md' } },
        { type: 'tool_use', id: 'toolu_grep', name: 'Grep', input: { pattern: 'TODO', path: '.' } }
      ]
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_read', content: 'read result' },
        { type: 'tool_result', tool_use_id: 'toolu_grep', content: 'grep result', is_error: true }
      ]
    }
  ], { nativeToolCalling: false });

  assert.equal((messages[0].content.match(/<｜DSML｜invoke /g) || []).length, 2);
  assert.match(messages[1].content, /"tool_name": "Read"/);
  assert.match(messages[1].content, /"tool_name": "Grep"/);
  assert.match(messages[1].content, /"is_error": true/);
});

test('DSML history rejects orphaned and duplicate tool results', () => {
  assert.throws(() => convertAnthropicMessages([
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'missing', content: 'x' }] }
  ], { nativeToolCalling: false }), /unknown tool_use_id/);

  assert.throws(() => convertAnthropicMessages([
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_once', name: 'Read', input: {} }] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'toolu_once', content: 'first' },
      { type: 'tool_result', tool_use_id: 'toolu_once', content: 'second' }
    ] }
  ], { nativeToolCalling: false }), /Duplicate tool_result/);
});


test('text-only history preserves prior results without serializing callable tool syntax', () => {
  const messages = convertAnthropicMessages([
    { role: 'user', content: 'Read README.md, then summarize it.' },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_previous', name: 'Read', input: { file_path: 'README.md' } }]
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_previous', content: 'Historical README output' }]
    }
  ], { nativeToolCalling: true, textOnly: true });

  assert.equal(messages.some((message) => message.role === 'tool'), false);
  assert.equal(messages.some((message) => Array.isArray(message.tool_calls)), false);
  assert.match(messages[1].content, /HISTORICAL TOOL INVOCATIONS \(context only; not callable/);
  assert.match(messages[2].content, /HISTORICAL TOOL RESULTS/);
  assert.match(messages[2].content, /Historical README output/);
  assert.doesNotMatch(messages[1].content, /<｜DSML｜|<\|BYV\|/);
  assert.ok(messages[1].content.includes('\n'));
});


test('forwards base64 and HTTP(S) Anthropic images as OpenAI-compatible image_url parts', () => {
  const messages = convertAnthropicMessages([{
    role: 'user',
    content: [
      { type: 'text', text: 'Compare these images.' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
      { type: 'image', source: { type: 'url', url: 'https://images.example.test/photo.webp' } }
    ]
  }]);

  assert.deepEqual(messages, [{
    role: 'user',
    content: [
      { type: 'text', text: 'Compare these images.' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } },
      { type: 'image_url', image_url: { url: 'https://images.example.test/photo.webp' } }
    ]
  }]);
  assert.equal(JSON.stringify(messages).includes('"type":"file"'), false);
});

test('preserves image content returned by tools as a separate provider user message', () => {
  const messages = convertAnthropicMessages([
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call_image', name: 'Screenshot', input: {} }]
    },
    {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'call_image',
        content: [
          { type: 'text', text: 'Screenshot captured.' },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: '/9j/4A==' } }
        ]
      }]
    }
  ]);

  assert.equal(messages[1].role, 'tool');
  assert.equal(messages[1].content, 'Screenshot captured.');
  assert.deepEqual(messages[2], {
    role: 'user',
    content: [
      { type: 'text', text: '[Image content returned by tool call_image]' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/4A==' } }
    ]
  });
});

test('preserves tool-result images in DSML history without turning them into file parts', () => {
  const messages = convertAnthropicMessages([
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call_image_dsml', name: 'Screenshot', input: {} }]
    },
    {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'call_image_dsml',
        content: [
          { type: 'text', text: 'Screenshot captured.' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } }
        ]
      }]
    }
  ], { nativeToolCalling: false });

  assert.equal(messages[1].role, 'user');
  assert.ok(Array.isArray(messages[1].content));
  assert.match(messages[1].content[0].text, /HISTORICAL TOOL RESULTS/);
  assert.deepEqual(messages[1].content[1], {
    type: 'image_url',
    image_url: { url: 'data:image/png;base64,aGVsbG8=' }
  });
  assert.equal(JSON.stringify(messages).includes('"type":"file"'), false);
});

test('estimates embedded images independently of base64 payload length', () => {
  const small = [{
    role: 'user',
    content: [{
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,AAAA' }
    }]
  }];
  const large = [{
    role: 'user',
    content: [{
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,' + 'A'.repeat(200000) }
    }]
  }];
  assert.equal(estimateProviderInputTokens(small), estimateProviderInputTokens(large));
});
