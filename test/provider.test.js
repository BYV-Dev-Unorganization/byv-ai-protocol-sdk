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
    "  tool_choice: { type: 'tool', name: 'Read' },\n  nativeToolCalling: true",
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

test('forwards handler-native schemas to the provider and maps returned calls to the Anthropic contract', () => {
  const script = [
    "global.fetch = async (_url, init) => {",
    "  const payload = JSON.parse(init.body);",
    "  if (!Array.isArray(payload.tools) || payload.tools.length !== 1) throw new Error('native tool schema was not forwarded');",
    "  if (payload.tools[0].function.name !== 'mcp__github_search_repositories') throw new Error('wrong native function schema name');",
    "  if (JSON.stringify(payload.tool_choice) !== JSON.stringify({ type: 'function', function: { name: 'mcp__github_search_repositories' } })) throw new Error('native tool_choice was not mapped');",
    "  if (!payload.messages[0] || payload.messages[0].role !== 'system') throw new Error('system prompt was not forwarded');",
    "  if (!payload.messages[0].content.includes('Client system instruction must remain.')) throw new Error('client system instruction was lost');",
    "  if (!payload.messages[0].content.includes('MODEL RESPONSE PROFILE')) throw new Error('model profile was lost');",
    "  if (/DSML|NATIVE TOOL CALL PROTOCOL|### TOOLS|TOOL RULES/i.test(payload.messages[0].content)) throw new Error('native prompt contains DSML/tool protocol instructions');",
    "  return new Response(JSON.stringify({",
    "    id: 'chatcmpl-native-e2e',",
    "    model: 'native-test-model',",
    "    choices: [{ message: { content: '', tool_calls: [{ id: 'call_native_e2e', type: 'function', function: { name: 'mcp__github_search_repositories', arguments: '{\\\"query\\\":\\\"byv sdk\\\"}' } }] }, finish_reason: 'tool_calls' }],",
    "    usage: { prompt_tokens: 20, completion_tokens: 3 }",
    "  }), { status: 200, headers: { 'Content-Type': 'application/json' } });",
    "};",
    "const { handleMessages } = require('./src/handler');",
    "const request = {",
    "  model: 'claude-sonnet-5-5',",
    "  max_tokens: 256,",
    "  system: 'Client system instruction must remain.',",
    "  tools: [{ name: 'mcp__github.search_repositories', description: 'Search GitHub repositories', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }],",
    "  tool_choice: { type: 'tool', name: 'mcp__github.search_repositories' },",
    "  messages: [{ role: 'user', content: 'Read README.md.' }]",
    "};",
    "handleMessages(request, { noToolExperiment: false, provider: { getModelCapabilities: async () => null } })",
    "  .then((result) => {",
    "    if (result.stop_reason !== 'tool_use') throw new Error('Anthropic stop_reason was not tool_use');",
    "    const block = result.content.find((item) => item.type === 'tool_use');",
    "    if (!block || block.id !== 'call_native_e2e' || block.name !== 'mcp__github.search_repositories' || block.input.query !== 'byv sdk') throw new Error('native call was not mapped to Anthropic tool_use');",
    "    process.stdout.write(JSON.stringify({ stop_reason: result.stop_reason, content: result.content }));",
    "  })",
    "  .catch((error) => { process.stderr.write(error.stack || error.message); process.exitCode = 1; });"
  ].join(String.fromCharCode(10));
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: require('node:path').resolve(__dirname, '..'),
    env: {
      ...process.env,
      PROVIDER_BASE_URL: 'https://provider.example/v1',
      PROVIDER_MODEL: 'native-test-model',
      PROVIDER_API_KEY: 'unit-test-secret',
      DSML_TOOL_CALL: 'false'
    },
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.stop_reason, 'tool_use');
  assert.deepEqual(output.content, [{
    type: 'tool_use',
    id: 'call_native_e2e',
    name: 'mcp__github.search_repositories',
    input: { query: 'byv sdk' }
  }]);
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
  assert.equal(payload.tool_choice, 'none');
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
