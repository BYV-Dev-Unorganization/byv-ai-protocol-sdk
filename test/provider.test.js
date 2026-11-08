'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { completionsUrl } = require('../src/provider/openai-compatible');

test('normalizes OpenAI-compatible provider URLs', () => {
  assert.equal(completionsUrl('https://provider.example/v1'), 'https://provider.example/v1/chat/completions');
  assert.equal(completionsUrl('https://provider.example/v1/'), 'https://provider.example/v1/chat/completions');
  assert.equal(completionsUrl('https://provider.example'), 'https://provider.example/v1/chat/completions');
  assert.equal(completionsUrl('https://provider.example/custom/chat/completions'), 'https://provider.example/custom/chat/completions');
});
test('builds native function tools and maps tool_choice without assuming provider reasoning extensions', () => {
  const script = [
    "const { buildPayload } = require('./src/provider/openai-compatible');",
    "const { payload } = buildPayload([{ role: 'user', content: 'Read README.md' }], {",
    "  max_tokens: 256,",
    "  tools: [{ name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } }],",
    "  tool_choice: { type: 'tool', name: 'Read' }",
    "});",
    "process.stdout.write(JSON.stringify(payload));"
  ].join('\n');
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: require('node:path').resolve(__dirname, '..'),
    env: {
      ...process.env,
      PROVIDER_BASE_URL: 'https://provider.example/v1',
      PROVIDER_MODEL: 'generic-test-model',
      PROVIDER_API_KEY: 'unit-test-secret',
      DSML_TOOL_CALL: 'true'
    },
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.tools, [{
    type: 'function',
    function: {
      name: 'Read',
      description: 'Read a file',
      parameters: {
        type: 'object',
        properties: { file_path: { type: 'string' } },
        required: ['file_path']
      }
    }
  }]);
  assert.deepEqual(payload.tool_choice, {
    type: 'function',
    function: { name: 'Read' }
  });
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'reasoning_effort'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'thinking'), false);
});

test('preserves provider-default reasoning when native tool choice is auto', () => {
  const script = [
    "const { buildPayload } = require('./src/provider/openai-compatible');",
    "const { payload } = buildPayload([{ role: 'user', content: 'Read README.md' }], {",
    "  max_tokens: 256,",
    "  tools: [{ name: 'Read', input_schema: { type: 'object', properties: {} } }],",
    "  tool_choice: 'auto',\n  nativeToolCalling: true",
    "});",
    "process.stdout.write(JSON.stringify(payload));"
  ].join('\n');
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: require('node:path').resolve(__dirname, '..'),
    env: {
      ...process.env,
      PROVIDER_BASE_URL: 'https://provider.example/v1',
      PROVIDER_MODEL: 'generic-test-model',
      PROVIDER_API_KEY: 'unit-test-secret',
      DSML_TOOL_CALL: 'true'
    },
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.tool_choice, 'auto');
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'reasoning_effort'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'thinking'), false);
});

test('disables reasoning for forced native tools only when the generic compatibility flag is enabled', () => {
  const script = [
    "const { buildPayload } = require('./src/provider/openai-compatible');",
    "const { payload } = buildPayload([{ role: 'user', content: 'Call an available tool' }], {",
    "  max_tokens: 256,",
    "  tools: [{ name: 'Read', input_schema: { type: 'object', properties: {} } }],",
    "  tool_choice: { type: 'any' },\n  nativeToolCalling: true",
    "});",
    "process.stdout.write(JSON.stringify(payload));"
  ].join('\n');
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: require('node:path').resolve(__dirname, '..'),
    env: {
      ...process.env,
      PROVIDER_BASE_URL: 'https://provider.example/v1',
      PROVIDER_MODEL: 'generic-test-model',
      PROVIDER_API_KEY: 'unit-test-secret',
      PROVIDER_NATIVE_TOOL_CALLING: 'true',
      PROVIDER_DISABLE_REASONING_FOR_REQUIRED_TOOLS: 'true'
    },
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.tool_choice, 'required');
  assert.equal(payload.reasoning_effort, 'none');
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'thinking'), false);
});

test('omits native tool fields entirely when native calling is disabled', () => {
  const script = [
    "const { buildPayload } = require('./src/provider/openai-compatible');",
    "const { payload } = buildPayload([{ role: 'user', content: 'Read README.md' }], {",
    "  max_tokens: 256,",
    "  tools: [{ name: 'Read', input_schema: { type: 'object' } }],",
    "  tool_choice: 'auto',\n  nativeToolCalling: false",
    "});",
    "process.stdout.write(JSON.stringify(payload));"
  ].join('\n');
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: require('node:path').resolve(__dirname, '..'),
    env: {
      ...process.env,
      PROVIDER_BASE_URL: 'https://provider.example/v1',
      PROVIDER_MODEL: 'test-model',
      PROVIDER_API_KEY: 'unit-test-secret',
      DSML_TOOL_CALL: 'true'
    },
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'tools'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'tool_choice'), false);
});


test('omits provider tool_choice when the gateway has disabled tools for the turn', () => {
  const script = [
    "const { buildPayload } = require('./src/provider/openai-compatible');",
    "const { payload } = buildPayload([{ role: 'user', content: 'Answer without tools.' }], {",
    "  max_tokens: 256,",
    "  tools: [{ name: 'Read', input_schema: { type: 'object', properties: { file_path: { type: 'string' } } } }],",
    "  tool_choice: 'none',\n  nativeToolCalling: true",
    "});",
    "process.stdout.write(JSON.stringify(payload));"
  ].join('\n');
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: require('node:path').resolve(__dirname, '..'),
    env: {
      ...process.env,
      PROVIDER_BASE_URL: 'https://provider.example/v1',
      PROVIDER_MODEL: 'test-model',
      PROVIDER_API_KEY: 'unit-test-secret',
      DSML_TOOL_CALL: 'true'
    },
    encoding: 'utf8'
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'tool_choice'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'tools'), false);
  nativeToolCalling: true
});


test('rejects an upstream SSE stream that closes without the DONE marker', () => {
  const script = [
    "global.fetch = async () => new Response('data: {\"choices\":[{\"delta\":{\"content\":\"partial\"},\"finish_reason\":\"stop\"}]}' + String.fromCharCode(10) + String.fromCharCode(10), {",
    "  status: 200, headers: { 'Content-Type': 'text/event-stream' }",
    "});",
    "const { createStreamingChatCompletion } = require('./src/provider/openai-compatible');",
    "createStreamingChatCompletion([{ role: 'user', content: 'Hello' }], { max_tokens: 32 }, undefined)",
    "  .then(() => { process.stderr.write('partial stream was accepted'); process.exitCode = 1; })",
    "  .catch((error) => {",
    "    if (error.code !== 'PROVIDER_STREAM_INCOMPLETE') { process.stderr.write(error.code || error.message); process.exitCode = 1; }",
    "    else process.stdout.write(error.code);",
    "  });"
  ].join(String.fromCharCode(10));
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: require('node:path').resolve(__dirname, '..'),
    env: {
      ...process.env,
      PROVIDER_BASE_URL: 'https://provider.example/v1',
      PROVIDER_MODEL: 'test-model',
      PROVIDER_API_KEY: 'unit-test-secret',
      PROVIDER_TIMEOUT_MS: '2000'
    },
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout, 'PROVIDER_STREAM_INCOMPLETE');
});

test('classifies upstream context-window rejection separately from transient HTTP errors', () => {
  const script = [
    "global.fetch = async () => new Response(JSON.stringify({ error: { message: 'maximum context length is 131072 tokens' } }), {",
    "  status: 400, headers: { 'Content-Type': 'application/json' }",
    "});",
    "const { createChatCompletion } = require('./src/provider/openai-compatible');",
    "createChatCompletion([{ role: 'user', content: 'Hello' }], { max_tokens: 32 }, undefined)",
    "  .then(() => { process.stderr.write('context rejection was accepted'); process.exitCode = 1; })",
    "  .catch((error) => {",
    "    if (error.code !== 'PROVIDER_CONTEXT_WINDOW_EXCEEDED') { process.stderr.write(error.code || error.message); process.exitCode = 1; }",
    "    else process.stdout.write(error.code);",
    "  });"
  ].join(String.fromCharCode(10));
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: require('node:path').resolve(__dirname, '..'),
    env: {
      ...process.env,
      PROVIDER_BASE_URL: 'https://provider.example/v1',
      PROVIDER_MODEL: 'test-model',
      PROVIDER_API_KEY: 'unit-test-secret',
      PROVIDER_TIMEOUT_MS: '2000'
    },
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout, 'PROVIDER_CONTEXT_WINDOW_EXCEEDED');
});


test('forwards anthropic-version and preserves provider response IDs for Office gateway requests', () => {
  const script = [
    "global.fetch = async (_url, init) => {",
    "  const headers = new Headers(init.headers);",
    "  if (headers.get('anthropic-version') !== '2023-06-01') throw new Error('missing Anthropic version header');",
    "  if (headers.get('authorization') !== 'Bearer unit-test-secret') throw new Error('missing provider authorization');",
    "  return new Response(JSON.stringify({ id: 'chatcmpl-office-123', model: 'test-model', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });",
    "};",
    "const { createChatCompletion } = require('./src/provider/openai-compatible');",
    "createChatCompletion([{ role: 'user', content: 'Hello' }], { max_tokens: 32, anthropicVersion: '2023-06-01' })",
    "  .then((result) => { if (result.id !== 'chatcmpl-office-123') throw new Error('provider response ID was not preserved'); process.stdout.write(result.id); })",
    "  .catch((error) => { process.stderr.write(error.stack || error.message); process.exitCode = 1; });"
  ].join(String.fromCharCode(10));
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: require('node:path').resolve(__dirname, '..'),
    env: { ...process.env, PROVIDER_BASE_URL: 'https://provider.example/v1', PROVIDER_MODEL: 'test-model', PROVIDER_API_KEY: 'unit-test-secret' },
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout, 'chatcmpl-office-123');
});


test('preserves the upstream response ID from streaming provider responses', () => {
  const script = [
    "const event = { id: 'chatcmpl-office-stream-123', choices: [{ delta: { content: 'streamed' }, finish_reason: null }] };",
    "global.fetch = async () => new Response('data: ' + JSON.stringify(event) + String.fromCharCode(10) + String.fromCharCode(10) + 'data: [DONE]' + String.fromCharCode(10) + String.fromCharCode(10), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });",
    "const { createStreamingChatCompletion } = require('./src/provider/openai-compatible');",
    "createStreamingChatCompletion([{ role: 'user', content: 'Hello' }], { max_tokens: 32 })",
    "  .then((result) => { if (result.id !== event.id) throw new Error('stream response ID was not preserved'); process.stdout.write(result.id); })",
    "  .catch((error) => { process.stderr.write(error.stack || error.message); process.exitCode = 1; });"
  ].join(String.fromCharCode(10));
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: require('node:path').resolve(__dirname, '..'),
    env: { ...process.env, PROVIDER_BASE_URL: 'https://provider.example/v1', PROVIDER_MODEL: 'test-model', PROVIDER_API_KEY: 'unit-test-secret' },
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout, 'chatcmpl-office-stream-123');
});
