'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { handleMessages } = require('../src/handler');

function body(options = {}) {
  return {
    model: 'claude-sonnet-5-5',
    max_tokens: 256,
    stream: false,
    messages: [{ role: 'user', content: 'Read README.md.' }],
    tools: [{
      name: 'Read',
      description: 'Read a file',
      input_schema: {
        type: 'object',
        required: ['file_path'],
        properties: { file_path: { type: 'string' } }
      }
    }],
    ...options
  };
}

test('converts valid BYV model output into Anthropic tool_use blocks', async () => {
  const output = '<|BYV| calls><|BYV| invoke name="Read" id="call_abc">' +
    '<|BYV| parameter name="file_path" type="string">README.md</|BYV| parameter>' +
    '</|BYV| invoke></|BYV| calls>';
  const result = await handleMessages(body(), {
    provider: {
      createChatCompletion: async () => ({ text: output, reasoning: '', finish_reason: 'stop', usage: null })
    }
  });
  assert.equal(result.stop_reason, 'tool_use');
  assert.deepEqual(result.content[0], {
    type: 'tool_use',
    id: 'call_abc',
    name: 'Read',
    input: { file_path: 'README.md' }
  });
});

test('performs bounded recovery for schema-invalid tool arguments', async () => {
  let count = 0;
  const result = await handleMessages(body(), {
    provider: {
      createChatCompletion: async () => {
        count++;
        return count === 1
          ? { text: '<|BYV| calls><|BYV| invoke name="Read" id="bad"><|BYV| parameter name="path" type="string">README.md</|BYV| parameter></|BYV| invoke></|BYV| calls>', finish_reason: 'stop' }
          : { text: '<|BYV| calls><|BYV| invoke name="Read" id="good"><|BYV| parameter name="file_path" type="string">README.md</|BYV| parameter></|BYV| invoke></|BYV| calls>', finish_reason: 'stop' };
      }
    }
  });
  assert.equal(count, 2);
  assert.equal(result.toolCalls[0].id, 'good');
});

test('recovers to plain text when tools are disabled but model emits BYV markup', async () => {
  let count = 0;
  const result = await handleMessages(body({ tools: [], tool_choice: 'none' }), {
    provider: {
      createChatCompletion: async () => {
        count++;
        return count === 1
          ? { text: '<|BYV| calls><|BYV| invoke name="Read" id="bad"></|BYV| invoke></|BYV| calls>', finish_reason: 'stop' }
          : { text: 'I cannot access files in this request, but I can explain how to inspect README.md.', finish_reason: 'stop' };
      }
    }
  });
  assert.equal(count, 2);
  assert.equal(result.stop_reason, 'end_turn');
  assert.equal(result.toolCalls.length, 0);
  assert.match(result.text, /cannot access files/);
});

test('fails explicitly when a required tool call cannot be recovered', async () => {
  await assert.rejects(
    handleMessages(body({ tool_choice: 'any' }), {
      provider: {
        createChatCompletion: async () => ({ text: 'Here is a plain text answer.', finish_reason: 'stop' })
      }
    }),
    (error) => error.code === 'BYV_REQUIRED_TOOL_MISSING'
  );
});

test('maps upstream max-token finish reasons to Anthropic max_tokens', async () => {
  const result = await handleMessages(body({ tools: [] }), {
    provider: {
      createChatCompletion: async () => ({
        text: 'A deliberately short answer.',
        finish_reason: 'max_tokens',
        usage: null
      })
    }
  });
  assert.equal(result.stop_reason, 'max_tokens');
});
