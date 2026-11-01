'use strict';

const http = require('node:http');
const {
  PORT, HOST, MAX_PENDING_REQUESTS, GATEWAY_API_KEY_SOURCE, PROVIDER_BASE_URL, PROVIDER_MODEL
} = require('./config');
const { listModels, isSupportedModel } = require('./model-profiles');
const { handleMessages } = require('./handler');
const { validateMessagesRequest, normalizeAnthropicMessagesRequest } = require('./anthropic-contract');
const { estimateInputTokens } = require('./content');
const { sendAnthropicStream, sendEvent } = require('./sse-sink');
const { jsonError, readBody, checkAuth, isAllowedHost, isAllowedOrigin } = require('./http-utils');
const { uuid } = require('./config');

function createServer(options = {}) {
  const runHandler = options.handleMessages || handleMessages;
  let activeRequests = 0;

  return http.createServer(async (req, res) => {
    const requestId = uuid('req');
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    const route = requestUrl.pathname;
    const port = req.socket.localPort;
    const origin = req.headers.origin;

    res.setHeader('X-Gateway-Request-ID', requestId);

    if (!isAllowedHost(req.headers.host, port)) {
      return jsonError(res, 421, 'invalid_request_error', 'Host header is not allowed. Use localhost or 127.0.0.1.');
    }
    if (!isAllowedOrigin(origin, port)) {
      return jsonError(res, 403, 'authentication_error', 'Origin is not allowed.');
    }
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET,POST,HEAD,OPTIONS',
        'Access-Control-Allow-Headers': 'authorization,content-type,x-api-key,anthropic-version,anthropic-beta',
        'Cache-Control': 'no-store'
      });
      return res.end();
    }

    // Claude Code sends this unauthenticated connection-warming probe.
    if (req.method === 'HEAD' && route === '/api/hello') {
      res.writeHead(204, {
        'Cache-Control': 'no-store',
        'Content-Length': '0'
      });
      return res.end();
    }

    if (!checkAuth(req)) {
      return jsonError(res, 401, 'authentication_error', 'Invalid gateway API key.');
    }

    if (req.method === 'GET' && route === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        status: 'ok',
        provider_configured: Boolean(PROVIDER_BASE_URL && PROVIDER_MODEL)
      }));
    }

    if (req.method === 'GET' && route === '/v1/models') {
      const models = listModels();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        data: models,
        first_id: models[0] && models[0].id,
        last_id: models[models.length - 1] && models[models.length - 1].id,
        has_more: false
      }));
    }

    if (req.method !== 'POST' ||
        (route !== '/v1/messages' && route !== '/v1/messages/' && route !== '/v1/messages/count_tokens')) {
      return jsonError(res, 404, 'not_found_error', 'Unknown endpoint: ' + route);
    }

    let body;
    try {
      body = await readBody(req);
    } catch (error) {
      return jsonError(res, error.statusCode || 400, 'invalid_request_error', error.message);
    }

    const normalized = normalizeAnthropicMessagesRequest(body);
    body = normalized.body;
    const countTokens = route === '/v1/messages/count_tokens';
    const validationError = validateMessagesRequest(body, { countTokens });
    if (validationError) {
      return jsonError(res, 400, validationError.type, validationError.message);
    }
    if (!isSupportedModel(body.model)) {
      return jsonError(res, 400, 'invalid_request_error', 'Unsupported BYV model profile: ' + body.model, 'UNSUPPORTED_MODEL_PROFILE');
    }

    if (countTokens) {
      const estimated = estimateInputTokens(body);
      res.setHeader('X-Token-Usage-Estimated', 'true');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ input_tokens: estimated }));
    }

    if (activeRequests >= MAX_PENDING_REQUESTS) {
      return jsonError(res, 429, 'rate_limit_error', 'Gateway is at its configured request concurrency limit.', 'GATEWAY_BUSY');
    }
    activeRequests++;

    const isStream = body.stream === true;
    const controller = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) controller.abort(new Error('Client disconnected.'));
    };
    res.once('close', onClose);

    const startedAt = Date.now();
    try {
      const result = await runHandler(body, { signal: controller.signal });
      if (res.destroyed || res.writableEnded) return;
      if (result.usage_estimated) res.setHeader('X-Token-Usage-Estimated', 'true');
      if (isStream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no'
        });
        if (typeof res.flushHeaders === 'function') res.flushHeaders();
        sendAnthropicStream(res, result, body.model, result.usage.input_tokens);
        res.end();
      } else {
        const payload = {
          id: result.id,
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: result.content,
          stop_reason: result.stop_reason,
          stop_sequence: null,
          usage: result.usage
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      }
      console.log(JSON.stringify({
        level: 'info',
        event: 'request.completed',
        request_id: requestId,
        model_profile: body.model,
        stream: isStream,
        message_count: body.messages.length,
        tool_count: Array.isArray(body.tools) ? body.tools.length : 0,
        tool_calls: result.toolCalls.length,
        stop_reason: result.stop_reason,
        duration_ms: Date.now() - startedAt,
        usage_estimated: result.usage_estimated
      }));
    } catch (error) {
      if (res.destroyed || res.writableEnded || controller.signal.aborted) return;
      console.error(JSON.stringify({
        level: 'error',
        event: 'request.failed',
        request_id: requestId,
        model_profile: body.model,
        error_code: error.code || 'GATEWAY_ERROR',
        status: error.statusCode || 500,
        message: String(error.message || error).slice(0, 500),
        duration_ms: Date.now() - startedAt
      }));
      if (isStream && res.headersSent) {
        sendEvent(res, 'error', {
          type: 'error',
          error: {
            type: error.type || 'api_error',
            message: error.message || 'Gateway request failed.',
            code: error.code || 'GATEWAY_ERROR'
          }
        });
        res.end();
      } else {
        jsonError(res, error.statusCode || 500, error.type || 'api_error',
          error.message || 'Gateway request failed.', error.code || 'GATEWAY_ERROR');
      }
    } finally {
      res.removeListener('close', onClose);
      activeRequests = Math.max(0, activeRequests - 1);
    }
  });
}

function start() {
  const server = createServer();
  server.listen(PORT, HOST, () => {
    console.log('BYV AI Protocol SDK gateway listening at http://' + HOST + ':' + PORT);
    console.log('Provider base URL: ' + (PROVIDER_BASE_URL || '[not configured]'));
    console.log('Provider model: ' + (PROVIDER_MODEL || '[not configured]'));
    console.log('Gateway auth source: ' + GATEWAY_API_KEY_SOURCE);
    console.log('Gateway API key: ' + (GATEWAY_API_KEY_SOURCE === 'environment'
      ? 'provided through GATEWAY_API_KEY'
      : 'stored in .byv-gateway-token (keep private)'));
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return server;
}

module.exports = { createServer, start };