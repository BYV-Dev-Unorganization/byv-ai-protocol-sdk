'use strict';

const http = require('node:http');
const {
  PORT, HOST, MAX_PENDING_REQUESTS, GATEWAY_API_KEY_SOURCE, PROVIDER_BASE_URL, PROVIDER_MODEL,
  DSML_TOOL_CALL,
  PROVIDER_SAMPLING_AUTO_PROBE,
  NO_TOOL_EXPERIMENT_VARIANT,
  STREAM_PING_INTERVAL_MS
} = require('./config');
const { listModels, isSupportedModel } = require('./model-profiles');
const { handleMessages, resolveCompactionBudgets } = require('./handler');
const { buildProviderMessages, buildCompactionProviderMessages } = require('./prompts');
const { getModelCapabilities } = require('./provider/capabilities');
const { initializeSamplingAutoProbe } = require('./provider/openai-compatible');
const { validateMessagesRequest, normalizeAnthropicMessagesRequest } = require('./anthropic-contract');
const { estimateProviderInputTokens } = require('./content');
const { writeEventAsync, createAnthropicStreamWriter } = require('./sse-sink');
const { DsmlStreamGuard } = require('./protocol/dsml-stream-guard');
const { isClaudeCodeCompactionRequest, isWordAddinThinkingHighlightRequest } = require('./request-intent');
const { jsonError, readBody, checkAuth, isAllowedHost, isAllowedOrigin } = require('./http-utils');
const { createRateLimiter, clientAddress, setRateLimitHeaders } = require('./rate-limiter');
const { uuid } = require('./config');
const { createDiagnostics } = require('./diagnostics');

const CLAUDE_DESKTOP_PROBE_MAX_TOKENS = 512;
const WORD_ADDIN_THINKING_HIGHLIGHT_MAX_TOKENS = 256;
const WORD_ADDIN_THINKING_HIGHLIGHT_FALLBACK = 'Meninjau langkah berikutnya sebelum melanjutkan';

function isClaudeDesktopConnectionProbe(body) {
  if (!body || body.max_tokens !== 1 || body.stream === true) return false;
  if (!Array.isArray(body.messages) || body.messages.length !== 1) return false;
  if (body.system !== undefined && body.system !== null && body.system !== '') return false;
  if (Array.isArray(body.tools) && body.tools.length > 0) return false;
  if (body.tool_choice !== undefined && body.tool_choice !== null) return false;

  const message = body.messages[0];
  if (!message || message.role !== 'user') return false;

  let content = message.content;
  if (Array.isArray(content)) {
    if (content.length !== 1 || !content[0] || content[0].type !== 'text') return false;
    content = content[0].text;
  }
  return typeof content === 'string' && content.trim() === '.';
}

function createServer(options = {}) {
  const runHandler = options.handleMessages || handleMessages;
  const readProviderCapabilities = options.getProviderCapabilities || getModelCapabilities;
  // DSML_TOOL_CALL is the single transport switch: true keeps the textual
  // DSML protocol, false enables provider-native function calling.
  const noToolExperiment = typeof options.noToolExperiment === 'boolean'
    ? options.noToolExperiment
    : DSML_TOOL_CALL;
  const experimentVariant = options.experimentVariant === 'B' || options.experimentVariant === 'A'
    ? options.experimentVariant
    : NO_TOOL_EXPERIMENT_VARIANT;
  const diagnostics = options.diagnostics || createDiagnostics();
  const recordDiagnostic = typeof diagnostics === 'function'
    ? diagnostics
    : typeof diagnostics.record === 'function'
      ? diagnostics.record.bind(diagnostics)
      : () => {};
  const toolCallLogger = typeof options.toolCallLogger === 'function'
    ? options.toolCallLogger
    : (entry) => {
      console.log(JSON.stringify(entry));
      recordDiagnostic(entry.event, entry);
    };
  const streamPingIntervalMs = Number.isSafeInteger(options.streamPingIntervalMs) && options.streamPingIntervalMs >= 1
    ? options.streamPingIntervalMs
    : STREAM_PING_INTERVAL_MS;
  const rateLimiter = options.rateLimiter || createRateLimiter({
    limit: 30,
    windowMs: 60_000
  });
  let activeRequests = 0;

  return http.createServer(async (req, res) => {
    const requestId = uuid('req');
    const requestUrl = new URL(req.url || '/', 'http://localhost');
    const route = requestUrl.pathname;
    const port = req.socket.localPort;
    const origin = req.headers.origin;

    res.setHeader('X-Gateway-Request-ID', requestId);

    if (!isAllowedHost(req.headers.host, port)) {
      return jsonError(res, 421, 'invalid_request_error', 'Host header is not allowed. Use localhost or configure its exact value in GATEWAY_ALLOWED_HOSTS.');
    }
    if (!isAllowedOrigin(origin, port)) {
      return jsonError(res, 403, 'authentication_error', 'Origin is not allowed.');
    }
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      // The Office task pane uses Anthropic's browser SDK, whose extra x-stainless
      // and browser-safety headers can change between add-in releases. Reflect
      // syntactically valid requested header names because the Origin was already
      // checked against the explicit CORS allowlist above.
      const allowedHeaders = new Set([
        'authorization',
        'content-type',
        'x-api-key',
        'anthropic-version',
        'anthropic-beta'
      ]);
      const requestedHeaders = String(req.headers['access-control-request-headers'] || '');
      for (const header of requestedHeaders.split(',')) {
        const normalized = header.trim().toLowerCase();
        if (/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(normalized)) {
          allowedHeaders.add(normalized);
        }
      }
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET,POST,HEAD,OPTIONS',
        'Access-Control-Allow-Headers': Array.from(allowedHeaders).join(','),
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

    const rateLimit = rateLimiter.consume(clientAddress(req));
    setRateLimitHeaders(res, rateLimit);
    if (!rateLimit.allowed) {
      return jsonError(
        res,
        429,
        'rate_limit_error',
        'Rate limit exceeded. Try again after the Retry-After interval.',
        'RATE_LIMITED'
      );
    }

    if (req.method === 'GET' && route === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        status: 'ok',
        provider_configured: Boolean(PROVIDER_BASE_URL && PROVIDER_MODEL),
        tool_transport: DSML_TOOL_CALL ? 'dsml' : 'provider_native'
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

    if (req.method === 'GET' && route === '/v1/provider/capabilities') {
      const capabilities = await readProviderCapabilities({
        forceRefresh: requestUrl.searchParams.get('refresh') === '1'
      });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(capabilities));
    }

    if (req.method !== 'POST' ||
        (route !== '/v1/messages' && route !== '/v1/messages/' && route !== '/v1/messages/count_tokens')) {
      return jsonError(res, 404, 'not_found_error', 'Unknown endpoint: ' + route);
    }

    let body;
    try {
      body = await readBody(req);
    } catch (error) {
      recordDiagnostic('request.body.rejected', {
        level: 'error',
        request_id: requestId,
        method: req.method,
        route,
        status: error.statusCode || 400,
        error_code: error.code || 'INVALID_REQUEST_BODY',
        message: String(error.message || error).slice(0, 500)
      });
      return jsonError(res, error.statusCode || 400, 'invalid_request_error', error.message);
    }

    const normalized = normalizeAnthropicMessagesRequest(body);
    body = normalized.body;
    const countTokens = route === '/v1/messages/count_tokens';
    const validationError = validateMessagesRequest(body, { countTokens });
    if (validationError) {
      recordDiagnostic('request.validation.rejected', {
        level: 'warn',
        request_id: requestId,
        model_profile: body.model || null,
        error_code: 'INVALID_REQUEST',
        message: validationError.message
      });
      return jsonError(res, 400, validationError.type, validationError.message);
    }
    if (!isSupportedModel(body.model)) {
      recordDiagnostic('request.validation.rejected', {
        level: 'warn',
        request_id: requestId,
        model_profile: body.model,
        error_code: 'UNSUPPORTED_MODEL_PROFILE',
        message: 'Unsupported BYV model profile.'
      });
      return jsonError(res, 400, 'invalid_request_error', 'Unsupported BYV model profile: ' + body.model, 'UNSUPPORTED_MODEL_PROFILE');
    }

    const compactionRequest = isClaudeCodeCompactionRequest(body);
    const desktopConnectionProbe = route === '/v1/messages' && isClaudeDesktopConnectionProbe(body);
    const thinkingHighlightAuxRequest = route === '/v1/messages' && isWordAddinThinkingHighlightRequest(body);
    const requestIntent = compactionRequest
      ? 'claude_code_compaction'
      : desktopConnectionProbe
        ? 'claude_desktop_connection_probe'
        : thinkingHighlightAuxRequest ? 'word_addin_thinking_highlight' : 'normal';
    // Claude Desktop's gateway connection check is a non-streaming one-token
    // request containing a single "." user message. Some reasoning providers
    // spend that entire budget internally and return no visible text, so give
    // this exact health probe a small provider-side output floor. Normal user
    // requests retain their requested max_tokens unchanged.
    const inferenceBody = compactionRequest
      ? { ...body, tool_choice: 'none' }
      : desktopConnectionProbe
        ? { ...body, max_tokens: Math.max(body.max_tokens, CLAUDE_DESKTOP_PROBE_MAX_TOKENS) }
        : thinkingHighlightAuxRequest
          ? { ...body, max_tokens: Math.max(body.max_tokens, WORD_ADDIN_THINKING_HIGHLIGHT_MAX_TOKENS) }
          : body;
    const requestContent = {
      request_id: requestId,
      request_intent: requestIntent,
      is_compaction_request: compactionRequest,
      is_claude_desktop_connection_probe: desktopConnectionProbe,
      is_word_addin_thinking_highlight_request: thinkingHighlightAuxRequest,
      effective_provider_max_tokens: inferenceBody.max_tokens,
      method: req.method,
      route,
      model_profile: body.model,
      stream: body.stream === true,
      max_tokens: Number.isSafeInteger(body.max_tokens) ? body.max_tokens : null,
      message_count: body.messages.length,
      tool_count: Array.isArray(body.tools) ? body.tools.length : 0,
      tool_names: Array.isArray(body.tools) ? body.tools.map((tool) => tool && tool.name).filter(Boolean) : [],
      no_tool_experiment: noToolExperiment,
      text_only_inference: noToolExperiment,
      textual_dsml_tool_calling: !compactionRequest && noToolExperiment && body.tool_choice !== 'none' && Array.isArray(body.tools) && body.tools.length > 0,
      no_tool_experiment_variant: noToolExperiment ? experimentVariant : null,
      callable_tool_count: compactionRequest || body.tool_choice === 'none' || (body.tool_choice && body.tool_choice.type === 'none')
        ? 0
        : (Array.isArray(body.tools) ? body.tools.length : 0),
      provider_native_tool_count: noToolExperiment || body.tool_choice === 'none' || (body.tool_choice && body.tool_choice.type === 'none')
        ? 0
        : (Array.isArray(body.tools) ? body.tools.length : 0),
      provider_tool_choice: noToolExperiment || body.tool_choice === 'none' || (body.tool_choice && body.tool_choice.type === 'none')
        ? 'none'
        : (body.tool_choice || 'auto'),
      body_bytes: Number.isSafeInteger(Number(req.headers['content-length'])) ? Number(req.headers['content-length']) : null,
      normalized_instruction_messages: normalized.normalizedInstructionMessages
    };
    recordDiagnostic('request.received', {
      ...requestContent,
      content: { body }
    });

    // Compaction summary turns are explicitly text-only; normal tool_choice remains intact.
    if (countTokens) {
      let estimated;
      try {
        if (compactionRequest) {
          const capabilities = await readProviderCapabilities();
          const budgets = resolveCompactionBudgets(capabilities, inferenceBody.max_tokens);
          const compactedBody = { ...inferenceBody, max_tokens: budgets.maxOutputTokens };
          estimated = estimateProviderInputTokens(buildCompactionProviderMessages(compactedBody, {
            maxInputTokens: budgets.maxInputTokens
          }));
        } else {
          estimated = estimateProviderInputTokens(buildProviderMessages(inferenceBody, {
            noToolExperiment,
            experimentVariant
          }));
        }
      } catch (error) {
        recordDiagnostic('request.token_estimation.failed', {
          level: 'warn',
          request_id: requestId,
          error_code: error.code || 'TOKEN_ESTIMATION_FAILED',
          status: error.statusCode || 400,
          message: String(error.message || error).slice(0, 500)
        });
        return jsonError(res, error.statusCode || 400, error.type || 'invalid_request_error',
          error.message || 'Could not estimate provider input tokens.', error.code || 'TOKEN_ESTIMATION_FAILED');
      }
      recordDiagnostic('request.token_estimation.completed', {
        request_id: requestId,
        estimated_input_tokens: estimated
      });
      res.setHeader('X-Token-Usage-Estimated', 'true');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ input_tokens: estimated }));
    }

    if (activeRequests >= MAX_PENDING_REQUESTS) {
      recordDiagnostic('request.concurrency.rejected', {
        level: 'warn',
        request_id: requestId,
        error_code: 'GATEWAY_BUSY',
        active_requests: activeRequests,
        max_pending_requests: MAX_PENDING_REQUESTS
      });
      return jsonError(res, 429, 'rate_limit_error', 'Gateway is at its configured request concurrency limit.', 'GATEWAY_BUSY');
    }
    activeRequests++;

    const isStream = body.stream === true;
    const controller = new AbortController();
    const startedAt = Date.now();
    let pingTimer = null;
    let pingPending = false;
    let streamWriter = null;
    let streamGuard = null;
    let streamedText = '';
    const onClose = () => {
      if (!res.writableEnded && !controller.signal.aborted) {
        controller.abort(new Error('Client disconnected.'));
        recordDiagnostic('request.cancelled', {
          level: 'warn',
          event: 'request.cancelled',
          request_id: requestId,
          model_profile: body.model,
          error_code: 'CLIENT_DISCONNECTED',
          status: 499,
          phase: 'client_disconnect',
          duration_ms: Date.now() - startedAt
        });
      }
    };
    res.once('close', onClose);

    try {
      if (isStream) {
        const streamPrompt = buildProviderMessages(inferenceBody, {
          noToolExperiment,
          experimentVariant,
          nativeToolCalling: !noToolExperiment
        });
        const estimatedInputTokens = estimateProviderInputTokens(streamPrompt);
        res.setHeader('X-Token-Usage-Estimated', 'true');
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no'
        });
        if (typeof res.flushHeaders === 'function') res.flushHeaders();
        streamWriter = createAnthropicStreamWriter(res, body.model, estimatedInputTokens, controller.signal);
        streamGuard = new DsmlStreamGuard();
        await streamWriter.start();
        await streamWriter.ping();
        pingTimer = setInterval(() => {
          if (!streamWriter || pingPending || controller.signal.aborted) return;
          pingPending = true;
          streamWriter.ping()
            .catch(() => { if (pingTimer) clearInterval(pingTimer); })
            .finally(() => { pingPending = false; });
        }, streamPingIntervalMs);
        if (typeof pingTimer.unref === 'function') pingTimer.unref();
      }
      let result;
      try {
        result = await runHandler(inferenceBody, {
          signal: controller.signal,
          requestId,
          logger: toolCallLogger,
          diagnostics: recordDiagnostic,
          noToolExperiment,
          nativeToolCalling: !noToolExperiment,
          experimentVariant,
          requestIntent,
          anthropicVersion: req.headers['anthropic-version'],
          provider: options.provider,
          onStreamEvent: isStream ? async (event) => {
            if (!event || event.type !== 'text_delta' || typeof event.text !== 'string') return;
            const safeChunks = streamGuard.push(event.text);
            for (const chunk of safeChunks) {
              await streamWriter.writeTextDelta(chunk);
              streamedText += chunk;
            }
          } : undefined
        });
      } catch (error) {
        if (!thinkingHighlightAuxRequest ||
            error.code !== 'BYV_TEXT_RECOVERY_FAILED' ||
            controller.signal.aborted) {
          throw error;
        }

        let inputTokens = 0;
        try {
          inputTokens = estimateProviderInputTokens(buildProviderMessages(inferenceBody, {
            noToolExperiment,
            experimentVariant
          }));
        } catch {
          // Auxiliary fallback must remain available even if local estimation fails.
        }
        result = {
          id: uuid('msg'),
          text: WORD_ADDIN_THINKING_HIGHLIGHT_FALLBACK,
          content: [{ type: 'text', text: WORD_ADDIN_THINKING_HIGHLIGHT_FALLBACK }],
          toolCalls: [],
          stop_reason: 'end_turn',
          usage: {
            input_tokens: inputTokens,
            output_tokens: Math.max(1, Math.ceil(WORD_ADDIN_THINKING_HIGHLIGHT_FALLBACK.length / 4))
          },
          usage_estimated: true,
          fallback_used: true
        };
        recordDiagnostic('request.auxiliary_fallback', {
          level: 'warn',
          request_id: requestId,
          request_intent: requestIntent,
          model_profile: body.model,
          error_code: error.code,
          fallback_code: 'WORD_ADDIN_THINKING_HIGHLIGHT_FALLBACK'
        });
      }
      if (res.destroyed || res.writableEnded) return;
      if (result.usage_estimated) res.setHeader('X-Token-Usage-Estimated', 'true');
      if (isStream) {
        if (pingTimer) {
          clearInterval(pingTimer);
          pingTimer = null;
        }
        const safeTail = streamGuard.finish();
        for (const chunk of safeTail) {
          await streamWriter.writeTextDelta(chunk);
          streamedText += chunk;
        }
        const finalText = typeof result.text === 'string' ? result.text : '';
        const streamedPrefixes = [
          streamedText,
          streamedText.trimStart(),
          streamedText.trim()
        ].filter(Boolean);
        const matchingPrefix = streamedPrefixes.find((prefix) => finalText.startsWith(prefix));
        const finalRemainder = streamedText.length === 0
          ? finalText
          : matchingPrefix
            ? finalText.slice(matchingPrefix.length)
            : '';
        // A DSML/BYV/legacy tool-call envelope is protocol data, never user-visible text.
        // If recovery changed the already-streamed prefix, do not duplicate or corrupt the stream.
        if (finalRemainder && !streamGuard.containsProtocol(finalRemainder)) {
          await streamWriter.writeTextDelta(finalRemainder);
          streamedText += finalRemainder;
        }
        await streamWriter.writeToolCalls(result.toolCalls || []);
        await streamWriter.finish(result);
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
      const completionLog = {
        level: 'info',
        event: 'request.completed',
        request_id: requestId,
        model_profile: body.model,
        stream: isStream,
        message_count: body.messages.length,
        tool_count: Array.isArray(body.tools) ? body.tools.length : 0,
        tool_calls: result.toolCalls.length,
        ...(result.fallback_used ? { fallback_used: true } : {}),
        stop_reason: result.stop_reason,
        duration_ms: Date.now() - startedAt,
        usage_estimated: result.usage_estimated,
        input_tokens: result.usage.input_tokens,
        output_tokens: result.usage.output_tokens,
        cache_read_input_tokens: result.usage.cache_read_input_tokens ?? null,
        cache_creation_input_tokens: result.usage.cache_creation_input_tokens ?? null
      };
      console.log(JSON.stringify(completionLog));
      recordDiagnostic('request.completed', completionLog);
      recordDiagnostic('gateway.response.completed', {
        request_id: requestId,
        model_profile: body.model,
        stream: isStream,
        stop_reason: result.stop_reason,
        usage: result.usage,
        content: { content: result.content, stop_reason: result.stop_reason, usage: result.usage }
      });
    } catch (error) {
      if (controller.signal.aborted || res.destroyed || res.writableEnded) return;
      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
      }
      const failureLog = {
        level: 'error',
        event: 'request.failed',
        request_id: requestId,
        model_profile: body.model,
        error_code: error.code || 'GATEWAY_ERROR',
        status: error.statusCode || 500,
        message: String(error.message || error).slice(0, 500),
        duration_ms: Date.now() - startedAt
      };
      console.error(JSON.stringify(failureLog));
      recordDiagnostic('request.failed', failureLog);
      if (isStream && res.headersSent) {
        try {
          if (streamWriter) {
            await streamWriter.error(error);
          } else {
            await writeEventAsync(res, 'error', {
              type: 'error',
              error: {
                type: error.type || 'api_error',
                message: error.message || 'Gateway request failed.',
                code: error.code || 'GATEWAY_ERROR'
              }
            }, controller.signal);
          }
        } catch {
          // The client may already be gone; do not turn a disconnected stream into another failure.
        }
        if (!res.destroyed && !res.writableEnded) res.end();
      } else {
        jsonError(res, error.statusCode || 500, error.type || 'api_error',
          error.message || 'Gateway request failed.', error.code || 'GATEWAY_ERROR');
      }
    } finally {
      if (pingTimer) clearInterval(pingTimer);
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
    if (PROVIDER_SAMPLING_AUTO_PROBE) {
      console.log('Provider sampling auto-probe: enabled (checking provider/model parameter support)');
      initializeSamplingAutoProbe().then((sampling) => {
        console.log('Provider sampling auto-probe result: ' + sampling.status +
          '; accepted=[' + sampling.accepted_parameters.join(', ') + ']' +
          '; rejected=[' + sampling.rejected_parameters.join(', ') + ']' +
          '; unknown=[' + sampling.unknown_parameters.join(', ') + ']' +
          '; requests=' + sampling.probe_requests);
      }).catch((error) => {
        console.warn('Provider sampling auto-probe failed; provider/model defaults will be used: ' +
          String(error && error.message || error).slice(0, 500));
      });
    } else {
      console.log('Provider sampling auto-probe: disabled (provider/model sampling defaults will be used)');
    }
    console.log('Tool transport: ' + (DSML_TOOL_CALL
      ? 'DeepSeek DSML text output (provider tool_choice=none; gateway adapter enabled)'
      : 'provider-native function calling'));
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