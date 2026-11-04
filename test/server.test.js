'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../src/server');
const { GATEWAY_API_KEY, PROVIDER_MODEL } = require('../src/config');

async function withServer(t, options) {
  const server = createServer(options);
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
    server.listen(0, '127.0.0.1');
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return 'http://127.0.0.1:' + server.address().port;
}

function authHeaders(extra = {}) {
  return {
    Authorization: 'Bearer ' + GATEWAY_API_KEY,
    'Content-Type': 'application/json',
    ...extra
  };
}

test('answers Claude Code HEAD /api/hello connection probe without authentication', async (t) => {
  const base = await withServer(t);
  const response = await fetch(base + '/api/hello', { method: 'HEAD' });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(await response.text(), '');
});

test('limits authenticated API requests to 30 per rolling minute per IP', async (t) => {
  const base = await withServer(t);

  // Unauthenticated probes and preflight requests do not consume the API quota.
  const probe = await fetch(base + '/api/hello', { method: 'HEAD' });
  assert.equal(probe.status, 204);
  const preflight = await fetch(base + '/v1/messages', { method: 'OPTIONS' });
  assert.equal(preflight.status, 204);
  const unauthorized = await fetch(base + '/health');
  assert.equal(unauthorized.status, 401);

  let lastAllowed;
  for (let i = 0; i < 30; i++) {
    lastAllowed = await fetch(base + '/health', { headers: authHeaders() });
    assert.equal(lastAllowed.status, 200, 'request ' + (i + 1) + ' should be allowed');
  }
  assert.equal(lastAllowed.headers.get('x-ratelimit-limit'), '30');
  assert.equal(lastAllowed.headers.get('x-ratelimit-remaining'), '0');

  const blocked = await fetch(base + '/health', { headers: authHeaders() });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) >= 1);
  assert.equal(blocked.headers.get('x-ratelimit-limit'), '30');
  assert.equal(blocked.headers.get('x-ratelimit-remaining'), '0');
  const body = await blocked.json();
  assert.equal(body.error.code, 'RATE_LIMITED');
});

test('requires gateway authentication and exposes BYV Flash V1 in model discovery', async (t) => {
  const base = await withServer(t);
  const rejected = await fetch(base + '/v1/models');
  assert.equal(rejected.status, 401);

  const accepted = await fetch(base + '/v1/models', { headers: authHeaders() });
  assert.equal(accepted.status, 200);
  const body = await accepted.json();
  assert.equal(body.data.length, 6);
  assert.equal(body.data[0].id, 'byv-flash-v1');
  assert.equal(body.data[0].display_name, 'BYV Flash V1');
});

test('rejects unsupported model profile IDs before invoking the handler', async (t) => {
  let called = false;
  const base = await withServer(t, {
    handleMessages: async () => {
      called = true;
      throw new Error('handler should not run');
    }
  });
  const response = await fetch(base + '/v1/messages', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      model: 'nonexistent-profile',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'Hello' }]
    })
  });
  assert.equal(response.status, 400);
  assert.equal(called, false);
  const result = await response.json();
  assert.equal(result.error.code, 'UNSUPPORTED_MODEL_PROFILE');
});

test('returns an Anthropic Messages envelope from the injected runtime', async (t) => {
  const base = await withServer(t, {
    handleMessages: async (body) => ({
      id: 'msg_test',
      text: 'BYV gateway is ready.',
      content: [{ type: 'text', text: 'BYV gateway is ready.' }],
      toolCalls: [],
      stop_reason: 'end_turn',
      usage: { input_tokens: 9, output_tokens: 6 },
      usage_estimated: false
    })
  });
  const response = await fetch(base + '/v1/messages', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      model: 'claude-sonnet-5-5',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'Hello' }]
    })
  });
  assert.equal(response.status, 200);
  assert.ok(response.headers.get('x-gateway-request-id'));
  const result = await response.json();
  assert.equal(result.type, 'message');
  assert.equal(result.role, 'assistant');
  assert.equal(result.model, 'claude-sonnet-5-5');
  assert.equal(result.stop_reason, 'end_turn');
  assert.deepEqual(result.content, [{ type: 'text', text: 'BYV gateway is ready.' }]);
  assert.deepEqual(result.usage, { input_tokens: 9, output_tokens: 6 });
});

test('passes request-scoped structured tool logging to the handler', async (t) => {
  const events = [];
  const base = await withServer(t, {
    toolCallLogger: (event) => events.push(event),
    handleMessages: async (_body, options) => {
      options.logger({
        level: 'info',
        event: 'tool_call.validated',
        request_id: options.requestId,
        invocation_id: 'call_server_log',
        tool_name: 'Read',
        validation_status: 'valid'
      });
      return {
        id: 'msg_log_test',
        content: [{ type: 'text', text: 'Done.' }],
        toolCalls: [],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
        usage_estimated: false
      };
    }
  });

  const response = await fetch(base + '/v1/messages', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      model: 'claude-sonnet-5-5',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'Hello' }]
    })
  });

  assert.equal(response.status, 200);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'tool_call.validated');
  assert.equal(events[0].request_id, response.headers.get('x-gateway-request-id'));
  assert.equal(events[0].invocation_id, 'call_server_log');
  assert.equal(events[0].tool_name, 'Read');
  assert.equal(events[0].validation_status, 'valid');
});

test('count_tokens accepts the canonical BYV Flash V1 model ID without invoking model runtime', async (t) => {
  let called = false;
  const base = await withServer(t, {
    handleMessages: async () => {
      called = true;
      throw new Error('count_tokens must not invoke model runtime');
    }
  });
  const response = await fetch(base + '/v1/messages/count_tokens', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      model: 'byv-flash-v1',
      messages: [{ role: 'user', content: 'Count these tokens.' }]
    })
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.ok(Number.isInteger(result.input_tokens));
  assert.equal(response.headers.get('x-token-usage-estimated'), 'true');
  assert.equal(called, false);
});

test('exposes provider context and token limits through an authenticated capability endpoint', async (t) => {
  let forceRefresh = false;
  const base = await withServer(t, {
    getProviderCapabilities: async (options) => {
      forceRefresh = options.forceRefresh === true;
      return {
        provider_model: PROVIDER_MODEL || null,
        metadata_status: 'available',
        context_window_tokens: 1000000,
        max_input_tokens: 900000,
        max_output_tokens: 64000,
        supports_prompt_caching: true
      };
    }
  });
  const rejected = await fetch(base + '/v1/provider/capabilities');
  assert.equal(rejected.status, 401);

  const response = await fetch(base + '/v1/provider/capabilities?refresh=1', {
    headers: authHeaders()
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const result = await response.json();
  assert.equal(result.provider_model, PROVIDER_MODEL || null);
  assert.equal(result.context_window_tokens, 1000000);
  assert.equal(result.max_input_tokens, 900000);
  assert.equal(result.max_output_tokens, 64000);
  assert.equal(result.supports_prompt_caching, true);
  assert.equal(forceRefresh, true);
});


test('text-only inference preserves gateway tool_choice while selecting provider text transport', async (t) => {
  let receivedBody;
  let receivedOptions;
  const base = await withServer(t, {
    noToolExperiment: false,
    experimentVariant: 'B',
    handleMessages: async (body, options) => {
      receivedBody = body;
      receivedOptions = options;
      return {
        id: 'msg_text_only',
        content: [{ type: 'text', text: 'Text-only response.' }],
        toolCalls: [],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 2 },
        usage_estimated: false
      };
    }
  });

  const response = await fetch(base + '/v1/messages', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      model: 'byv-flash-v1',
      max_tokens: 64,
      tools: [{ name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: {} } }],
      tool_choice: 'auto',
      messages: [{ role: 'user', content: 'Read README.md and summarize it.' }]
    })
  });

  assert.equal(response.status, 200);
  assert.equal(receivedBody.tool_choice, 'auto');
  assert.equal(receivedOptions.noToolExperiment, true);
  assert.equal(receivedOptions.experimentVariant, 'B');
  const result = await response.json();
  assert.deepEqual(result.content, [{ type: 'text', text: 'Text-only response.' }]);
});


test('starts Anthropic SSE with message_start and keeps it alive with ping before inference completes', async (t) => {
  const base = await withServer(t, {
    streamPingIntervalMs: 10,
    handleMessages: async () => {
      await new Promise((resolve) => setTimeout(resolve, 55));
      return {
        id: 'msg_delayed_stream',
        text: 'Done.',
        content: [{ type: 'text', text: 'Done.' }],
        toolCalls: [],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 2 },
        usage_estimated: false
      };
    }
  });
  const response = await fetch(base + '/v1/messages', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      model: 'claude-sonnet-5-5',
      max_tokens: 64,
      stream: true,
      messages: [{ role: 'user', content: 'Hello' }]
    })
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\\/event-stream/);
  const stream = await response.text();
  const startIndex = stream.indexOf('event: message_start');
  const pingIndex = stream.indexOf('event: ping');
  const deltaIndex = stream.indexOf('event: content_block_delta');
  assert.ok(startIndex >= 0);
  assert.ok(pingIndex > startIndex);
  assert.ok(deltaIndex > pingIndex);
  assert.match(stream, /event: message_stop/);
  assert.equal(response.headers.get('x-token-usage-estimated'), 'true');
});
