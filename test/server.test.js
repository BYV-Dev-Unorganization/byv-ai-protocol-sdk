'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../src/server');
const { GATEWAY_API_KEY, PROVIDER_MODEL, DSML_TOOL_CALL } = require('../src/config');

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

test('reports the active tool transport in gateway health', async (t) => {
  const base = await withServer(t);
  const response = await fetch(base + '/health', { headers: authHeaders() });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.tool_transport, DSML_TOOL_CALL ? 'dsml' : 'provider_native');
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

test('adapts Claude Desktop one-token connection probes without changing normal requests', async (t) => {
  const received = [];
  const base = await withServer(t, {
    handleMessages: async (body, options) => {
      received.push({
        max_tokens: body.max_tokens,
        requestIntent: options.requestIntent
      });
      return {
        id: 'msg_connection_probe',
        content: [{ type: 'text', text: 'OK' }],
        toolCalls: [],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
        usage_estimated: false
      };
    }
  });

  const probe = await fetch(base + '/v1/messages', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      model: 'claude-haiku-5-5',
      max_tokens: 1,
      messages: [{ role: 'user', content: '.' }]
    })
  });
  assert.equal(probe.status, 200);
  assert.deepEqual(received[0], {
    max_tokens: 512,
    requestIntent: 'claude_desktop_connection_probe'
  });

  const normal = await fetch(base + '/v1/messages', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      model: 'byv-flash-v1',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'Reply with one character.' }]
    })
  });
  assert.equal(normal.status, 200);
  assert.deepEqual(received[1], {
    max_tokens: 1,
    requestIntent: 'normal'
  });
});


test('isolates Word Add-in thinking-highlight empty-output failures from the main request path', async (t) => {
  let receivedBody;
  let receivedOptions;
  const events = [];
  const base = await withServer(t, {
    noToolExperiment: false,
    diagnostics: (event, fields) => events.push({ event, ...fields }),
    handleMessages: async (body, options) => {
      receivedBody = body;
      receivedOptions = options;
      throw Object.assign(new Error('Model could not produce a non-empty plain-text response.'), {
        statusCode: 502,
        type: 'api_error',
        code: 'BYV_TEXT_RECOVERY_FAILED'
      });
    }
  });

  const response = await fetch(base + '/v1/messages', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      model: 'claude-haiku-5-5',
      max_tokens: 64,
      metadata: {
        user_id: JSON.stringify({
          user: 'word-add-in/unknown',
          session_id: 'aux:thinking-highlight:device-id:2026-11-09'
        })
      },
      messages: [{ role: 'user', content: 'Lanjutkan' }]
    })
  });

  assert.equal(response.status, 200);
  assert.equal(receivedBody.max_tokens, 256);
  assert.equal(receivedOptions.requestIntent, 'word_addin_thinking_highlight');
  assert.equal(receivedOptions.noToolExperiment, false);
  assert.equal(receivedOptions.nativeToolCalling, true);
  const result = await response.json();
  assert.equal(result.stop_reason, 'end_turn');
  assert.deepEqual(result.content, [{ type: 'text', text: 'Meninjau langkah berikutnya sebelum melanjutkan' }]);
  assert.ok(events.some((entry) =>
    entry.event === 'request.auxiliary_fallback' &&
    entry.fallback_code === 'WORD_ADDIN_THINKING_HIGHLIGHT_FALLBACK'
  ));
  assert.ok(events.some((entry) =>
    entry.event === 'request.completed' && entry.fallback_used === true
  ));
});

test('does not hide empty-output recovery failures on normal native requests', async (t) => {
  const base = await withServer(t, {
    noToolExperiment: false,
    handleMessages: async () => {
      throw Object.assign(new Error('Model could not produce a non-empty plain-text response.'), {
        statusCode: 502,
        type: 'api_error',
        code: 'BYV_TEXT_RECOVERY_FAILED'
      });
    }
  });

  const response = await fetch(base + '/v1/messages', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      model: 'claude-haiku-5-5',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'Continue the document task.' }]
    })
  });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, 'BYV_TEXT_RECOVERY_FAILED');
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


test('DSML mode preserves gateway tool_choice while selecting provider text transport', async (t) => {
  let receivedBody;
  let receivedOptions;
  const base = await withServer(t, {
    noToolExperiment: true,
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
  assert.equal(receivedOptions.nativeToolCalling, false);
  assert.equal(receivedOptions.experimentVariant, 'B');
  const result = await response.json();
  assert.deepEqual(result.content, [{ type: 'text', text: 'Text-only response.' }]);
});


test('native mode forwards provider-native tool transport selection', async (t) => {
  let receivedOptions;
  const base = await withServer(t, {
    noToolExperiment: false,
    handleMessages: async (_body, options) => {
      receivedOptions = options;
      return {
        id: 'msg_native',
        content: [{ type: 'text', text: 'Native response.' }],
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
  assert.equal(receivedOptions.noToolExperiment, false);
  assert.equal(receivedOptions.nativeToolCalling, true);
  const result = await response.json();
  assert.deepEqual(result.content, [{ type: 'text', text: 'Native response.' }]);
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
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const stream = await response.text();
  const startIndex = stream.indexOf('event: message_start');
  const pingIndex = stream.indexOf('event: ping');
  const deltaIndex = stream.indexOf('event: content_block_delta');
  assert.ok(startIndex >= 0);
  assert.ok(pingIndex > startIndex);
  assert.ok(deltaIndex > pingIndex);
  assert.ok((stream.match(/event: ping/g) || []).length >= 2,
    'the gateway should keep sending periodic pings during slow inference');
  assert.match(stream, /event: message_stop/);
  assert.equal(response.headers.get('x-token-usage-estimated'), 'true');
});


test('supports Claude for Office CORS preflight and forwards anthropic-version', async (t) => {
  const previous = process.env.CORS_ALLOWED_ORIGINS;
  process.env.CORS_ALLOWED_ORIGINS = 'https://pivot.claude.ai';
  t.after(() => {
    if (previous === undefined) delete process.env.CORS_ALLOWED_ORIGINS;
    else process.env.CORS_ALLOWED_ORIGINS = previous;
  });
  let receivedAnthropicVersion;
  const base = await withServer(t, {
    handleMessages: async (_body, options) => {
      receivedAnthropicVersion = options.anthropicVersion;
      return {
        id: 'chatcmpl-office-test',
        content: [{ type: 'text', text: 'Office response.' }],
        toolCalls: [],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
        usage_estimated: false
      };
    }
  });
  const origin = 'https://pivot.claude.ai';
  const preflight = await fetch(base + '/v1/messages', {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'x-api-key,content-type,anthropic-version'
    }
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
  assert.match(preflight.headers.get('access-control-allow-headers'), /x-api-key/i);
  assert.match(preflight.headers.get('access-control-allow-headers'), /anthropic-version/i);
  assert.match(preflight.headers.get('access-control-allow-headers'), /authorization/i);

  const sdkPreflight = await fetch(base + '/v1/messages', {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': [
        'x-api-key',
        'content-type',
        'anthropic-version',
        'anthropic-dangerous-direct-browser-access',
        'x-stainless-lang',
        'x-stainless-package-version'
      ].join(',')
    }
  });
  assert.equal(sdkPreflight.status, 204);
  const sdkAllowedHeaders = sdkPreflight.headers.get('access-control-allow-headers');
  assert.match(sdkAllowedHeaders, /anthropic-dangerous-direct-browser-access/i);
  assert.match(sdkAllowedHeaders, /x-stainless-lang/i);
  assert.match(sdkAllowedHeaders, /x-stainless-package-version/i);

  const rejected = await fetch(base + '/v1/models', { headers: { Origin: origin } });
  assert.equal(rejected.status, 401);
  assert.equal(rejected.headers.get('access-control-allow-origin'), origin);

  const response = await fetch(base + '/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': GATEWAY_API_KEY, 'Content-Type': 'application/json', Origin: origin, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-5-5', max_tokens: 64, messages: [{ role: 'user', content: 'Hello' }] })
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), origin);
  assert.equal(receivedAnthropicVersion, '2023-06-01');
  assert.equal((await response.json()).id, 'chatcmpl-office-test');
});


test('keeps raw file handling on the Claude client and rejects gateway file attachments', async (t) => {
  let handlerCalled = false;
  const base = await withServer(t, {
    handleMessages: async () => {
      handlerCalled = true;
      throw new Error('unsupported file attachments must be rejected before inference');
    }
  });

  const filesApi = await fetch(base + '/v1/files', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ filename: 'report.pdf' })
  });
  assert.equal(filesApi.status, 404);

  const response = await fetch(base + '/v1/messages', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      model: 'byv-flash-v1',
      max_tokens: 64,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Summarize this report.' },
          {
            type: 'document',
            title: 'report.pdf',
            source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERiQ=' }
          }
        ]
      }]
    })
  });
  assert.equal(response.status, 400);
  assert.equal(handlerCalled, false);
  const result = await response.json();
  assert.match(result.error.message, /Claude client-side skill or tool/);
});