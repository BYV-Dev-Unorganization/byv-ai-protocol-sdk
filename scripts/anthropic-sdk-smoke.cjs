'use strict';

// Live compatibility smoke test against a running BYV gateway.
// Run: npm run test:sdk

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Anthropic = require('@anthropic-ai/sdk');

function normalizeBaseURL(value) {
  const url = new URL(value);
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname.replace(/\/+$/, '');
  if (url.pathname.endsWith('/v1')) url.pathname = url.pathname.slice(0, -3);
  return url.toString().replace(/\/$/, '');
}

const baseURL = normalizeBaseURL(
  process.env.BYV_BASE_URL ||
  process.env.ANTHROPIC_BASE_URL ||
  'http://127.0.0.1:8787'
);

function isLocalGateway(value) {
  try {
    const url = new URL(value);
    return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
      Number(url.port || 80) === 8787 &&
      (url.pathname === '' || url.pathname === '/');
  } catch {
    return false;
  }
}

function readLocalToken() {
  if (!isLocalGateway(baseURL)) return '';
  try {
    return fs.readFileSync(path.join(__dirname, '..', '.byv-gateway-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

const apiKey = process.env.GATEWAY_API_KEY ||
  (isLocalGateway(baseURL) ? readLocalToken() : '') ||
  process.env.ANTHROPIC_AUTH_TOKEN ||
  process.env.ANTHROPIC_API_KEY ||
  '';
const model = process.env.ANTHROPIC_MODEL || process.env.BYV_MODEL || 'byv-flash-v1';
const timeout = Number.parseInt(process.env.ANTHROPIC_SDK_TEST_TIMEOUT_MS || '600000', 10);

const client = new Anthropic({
  apiKey: apiKey || 'missing-byv-gateway-token',
  baseURL,
  maxRetries: 0,
  timeout
});

async function reportLocalGatewayTransport() {
  if (!isLocalGateway(baseURL)) {
    console.log('Gateway tool transport: not introspected (non-local gateway)');
    return;
  }

  const response = await fetch(new URL('/health', baseURL), {
    headers: { Authorization: 'Bearer ' + apiKey },
    signal: AbortSignal.timeout(5000)
  });
  if (!response.ok) {
    throw new Error('Local gateway health preflight returned HTTP ' + response.status + '.');
  }
  const health = await response.json();
  if (!['dsml', 'provider_native'].includes(health.tool_transport)) {
    throw new Error('Gateway does not report a supported tool_transport. Restart npm start from the updated repository.');
  }
  console.log('Gateway tool transport:', health.tool_transport === 'dsml' ? 'DSML text' : 'provider-native');
}

function textFrom(message) {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

function assertMessageShape(message, label) {
  assert.equal(message.type, 'message', label + ': response type must be message');
  assert.equal(message.role, 'assistant', label + ': response role must be assistant');
  assert.ok(Array.isArray(message.content), label + ': content must be an array');
  assert.ok(Number.isInteger(message.usage && message.usage.input_tokens),
    label + ': usage.input_tokens must be an integer');
  assert.ok(Number.isInteger(message.usage && message.usage.output_tokens),
    label + ': usage.output_tokens must be an integer');
}

async function main() {
  console.log('BYV Anthropic SDK integration smoke test');
  console.log('Gateway:', baseURL);
  console.log('Model profile:', model);
  if (!apiKey) {
    throw new Error(isLocalGateway(baseURL)
      ? 'Gateway token not found. Start npm start first so .byv-gateway-token is created, or set GATEWAY_API_KEY.'
      : 'Set ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY for the selected gateway.');
  }

  await reportLocalGatewayTransport();

  console.log('\n[1/5] Non-streaming Messages request ...');
  const normal = await client.messages.create({
    model,
    max_tokens: 128,
    messages: [{ role: 'user', content: 'Reply with the exact text BYV_SDK_SMOKE_OK and nothing else.' }]
  });
  assertMessageShape(normal, 'non-streaming');
  assert.ok(textFrom(normal).trim(), 'non-streaming: response text is empty');
  console.log('PASS non-streaming:', textFrom(normal).trim().slice(0, 160));

  console.log('\n[2/5] count_tokens SDK request ...');
  const counted = await client.messages.countTokens({
    model,
    messages: [{ role: 'user', content: 'Count this BYV SDK compatibility fixture.' }]
  });
  assert.ok(Number.isInteger(counted.input_tokens) && counted.input_tokens > 0,
    'count_tokens: input_tokens must be a positive integer');
  console.log('PASS count_tokens:', counted.input_tokens, '(gateway estimate)');

  console.log('\n[3/5] Streaming text request ...');
  const stream = await client.messages.create({
    model,
    max_tokens: 128,
    stream: true,
    messages: [{ role: 'user', content: 'Reply with a short greeting containing BYV_STREAM_SMOKE_OK.' }]
  });

  let streamedText = '';
  let eventCount = 0;
  let sawMessageStop = false;
  for await (const event of stream) {
    eventCount++;
    if (event.type === 'content_block_delta' && event.delta && event.delta.type === 'text_delta') {
      streamedText += event.delta.text;
    }
    if (event.type === 'message_stop') sawMessageStop = true;
  }
  assert.ok(eventCount > 0, 'streaming: SDK received no events');
  assert.ok(streamedText.trim(), 'streaming: no text_delta was received');
  assert.ok(sawMessageStop, 'streaming: message_stop was not received');
  console.log('PASS streaming text:', streamedText.trim().slice(0, 160));

  const tools = [{
    name: 'Bash',
    description: 'A synthetic compatibility fixture. The command must never be executed.',
    input_schema: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
      additionalProperties: false
    }
  }];
  const toolPrompt = 'Call the Bash tool with command exactly "echo BYV_SDK_TOOL_CALL_OK". Do not answer in plain text.';

  console.log('\n[4/5] Non-streaming tool_use and tool_result round trip ...');
  const toolMessage = await client.messages.create({
    model,
    max_tokens: 256,
    tools,
    tool_choice: { type: 'tool', name: 'Bash' },
    messages: [{ role: 'user', content: toolPrompt }]
  });
  assertMessageShape(toolMessage, 'tool-use');
  assert.equal(toolMessage.stop_reason, 'tool_use');
  const toolUse = toolMessage.content.find((block) => block.type === 'tool_use');
  assert.ok(toolUse, 'tool-use: expected a tool_use block');
  assert.equal(toolUse.name, 'Bash');
  assert.deepEqual(toolUse.input, { command: 'echo BYV_SDK_TOOL_CALL_OK' });

  const finalMessage = await client.messages.create({
    model,
    max_tokens: 128,
    tools,
    tool_choice: { type: 'none' },
    messages: [
      { role: 'user', content: toolPrompt },
      { role: 'assistant', content: toolMessage.content },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: 'BYV_SDK_SYNTHETIC_TOOL_RESULT_OK (no shell command was executed)'
        }]
      },
      {
        role: 'user',
        content: 'The synthetic tool has completed. Do not call any additional tools. Reply in plain text and acknowledge BYV_SDK_SYNTHETIC_TOOL_RESULT_OK.'
      }
    ]
  });
  assertMessageShape(finalMessage, 'tool-result round trip');
  assert.notEqual(finalMessage.stop_reason, 'tool_use',
    'tool-result round trip: tool_choice=none must prevent another tool call');
  assert.ok(textFrom(finalMessage).trim(), 'tool-result round trip: final response is empty');
  console.log('PASS tool_use:', toolUse.name, JSON.stringify(toolUse.input));
  console.log('PASS stateless tool_result round trip:', textFrom(finalMessage).trim().slice(0, 160));

  console.log('\n[5/5] Streaming tool_use ...');
  const toolStream = await client.messages.create({
    model,
    max_tokens: 256,
    stream: true,
    tools,
    tool_choice: { type: 'tool', name: 'Bash' },
    messages: [{
      role: 'user',
      content: 'Call the Bash tool with command exactly "echo BYV_SDK_STREAM_TOOL_OK". Do not answer in plain text.'
    }]
  });

  const blocks = new Map();
  let streamStopReason = null;
  let sawToolMessageStop = false;
  let toolEvents = 0;
  for await (const event of toolStream) {
    toolEvents++;
    if (event.type === 'content_block_start' && event.content_block && event.content_block.type === 'tool_use') {
      blocks.set(event.index, {
        id: event.content_block.id,
        name: event.content_block.name,
        partialJson: ''
      });
    } else if (event.type === 'content_block_delta' && event.delta && event.delta.type === 'input_json_delta') {
      const block = blocks.get(event.index);
      if (block) block.partialJson += event.delta.partial_json;
    } else if (event.type === 'message_delta') {
      streamStopReason = event.delta.stop_reason;
    } else if (event.type === 'message_stop') {
      sawToolMessageStop = true;
    }
  }

  const streamedTools = [...blocks.values()].map((block) => ({
    id: block.id,
    name: block.name,
    input: block.partialJson ? JSON.parse(block.partialJson) : {}
  }));
  assert.ok(toolEvents > 0, 'streaming tool-use: SDK received no events');
  assert.ok(sawToolMessageStop, 'streaming tool-use: message_stop was not received');
  assert.equal(streamStopReason, 'tool_use');
  assert.equal(streamedTools.length, 1);
  assert.equal(streamedTools[0].name, 'Bash');
  assert.deepEqual(streamedTools[0].input, { command: 'echo BYV_SDK_STREAM_TOOL_OK' });
  console.log('PASS streaming tool_use:', JSON.stringify(streamedTools[0]));

  console.log('\nALL BYV ANTHROPIC SDK SMOKE TESTS PASSED');
}

main().catch((error) => {
  console.error('\nBYV ANTHROPIC SDK SMOKE TEST FAILED');
  if (error && error.status) console.error('HTTP status:', error.status);
  console.error(error && error.stack ? error.stack : error);
  console.error('\nEnsure npm start is running, the gateway token matches, and the configured provider is responding.');
  process.exitCode = 1;
});
