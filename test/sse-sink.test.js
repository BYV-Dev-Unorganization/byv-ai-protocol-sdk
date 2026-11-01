'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sendAnthropicStream } = require('../src/sse-sink');

test('emits Anthropic SSE message and tool_use block events', () => {
  const chunks = [];
  const response = { destroyed: false, writableEnded: false, write(value) { chunks.push(value); return true; } };
  sendAnthropicStream(response, {
    text: 'Checking.',
    toolCalls: [{ id: 'call_read_1', name: 'Read', input: { file_path: 'README.md' } }],
    stop_reason: 'tool_use',
    usage: { input_tokens: 12, output_tokens: 15 }
  }, 'claude-sonnet-5-5', 12);
  const events = chunks.map((chunk) => {
    const match = chunk.match(/^event: ([^\n]+)\ndata: ([\s\S]*?)\n\n$/);
    assert.ok(match);
    return { event: match[1], data: JSON.parse(match[2]) };
  });
  assert.equal(events[0].event, 'message_start');
  assert.equal(events[events.length - 1].event, 'message_stop');
  assert.ok(events.some((event) => event.data.content_block && event.data.content_block.type === 'tool_use'));
  assert.equal(events.find((event) => event.data.delta && event.data.delta.stop_reason).data.delta.stop_reason, 'tool_use');
});

test('includes provider cache usage in the Anthropic streaming message_start usage', () => {
  const chunks = [];
  const response = { destroyed: false, writableEnded: false, write(value) { chunks.push(value); return true; } };
  sendAnthropicStream(response, {
    text: 'Cached response.',
    toolCalls: [],
    stop_reason: 'end_turn',
    usage: {
      input_tokens: 20,
      output_tokens: 6,
      cache_read_input_tokens: 80,
      cache_creation_input_tokens: 12
    }
  }, 'claude-sonnet-5-5', 20);

  const start = chunks.find((chunk) => chunk.startsWith('event: message_start'));
  const payload = JSON.parse(start.split('data: ')[1]);
  assert.deepEqual(payload.message.usage, {
    input_tokens: 20,
    output_tokens: 0,
    cache_creation_input_tokens: 12,
    cache_read_input_tokens: 80
  });
});
