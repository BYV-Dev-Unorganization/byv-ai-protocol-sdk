'use strict';

const {
  PROVIDER_BASE_URL,
  PROVIDER_API_KEY,
  PROVIDER_MODEL,
  PROVIDER_SAMPLING_AUTO_PROBE,
  PROVIDER_NATIVE_REASONING_EFFORT,
  PROVIDER_DISABLE_REASONING_FOR_REQUIRED_TOOLS,
  PROVIDER_TIMEOUT_MS,
  PROVIDER_MAX_REQUESTS_PER_MINUTE,
  PROVIDER_MAX_CONCURRENT_REQUESTS
} = require('../config');
const { createProviderRequestLimiter } = require('./request-limiter');
const { validateProviderParams } = require('./request-parameters');
const { initializeProviderSamplingCapabilities } = require('./sampling-capabilities');
const {
  providerToolChoice,
  providerFunctionTools,
  createProviderToolNameMap,
  mergeProviderToolCallDelta,
  finalizeProviderToolCallDeltas
} = require('./tool-calls');

const providerRequestLimiter = createProviderRequestLimiter({
  requestsPerMinute: PROVIDER_MAX_REQUESTS_PER_MINUTE,
  maxConcurrent: PROVIDER_MAX_CONCURRENT_REQUESTS
});

class ProviderError extends Error {
  constructor(message, statusCode, code) {
    super(message);
    this.name = 'ProviderError';
    this.statusCode = statusCode || 502;
    this.code = code || 'PROVIDER_ERROR';
    this.type = 'api_error';
  }
}

function completionsUrl(baseUrl) {
  if (!baseUrl) throw new ProviderError('PROVIDER_BASE_URL is not configured.', 503, 'PROVIDER_NOT_CONFIGURED');
  const url = new URL(baseUrl);
  url.search = '';
  url.hash = '';
  const pathname = url.pathname.replace(/\/+$/, '');
  if (pathname.endsWith('/chat/completions')) {
    url.pathname = pathname;
  } else if (pathname.endsWith('/v1')) {
    url.pathname = pathname + '/chat/completions';
  } else {
    url.pathname = pathname + '/v1/chat/completions';
  }
  return url.toString();
}

function providerConfiguration() {
  if (!PROVIDER_MODEL) {
    throw new ProviderError('PROVIDER_MODEL is not configured.', 503, 'PROVIDER_NOT_CONFIGURED');
  }
  if (!PROVIDER_BASE_URL) {
    throw new ProviderError('PROVIDER_BASE_URL is not configured.', 503, 'PROVIDER_NOT_CONFIGURED');
  }
  return {
    url: completionsUrl(PROVIDER_BASE_URL),
    model: PROVIDER_MODEL,
    apiKey: PROVIDER_API_KEY
  };
}

function requiresNonThinkingToolChoice(choice) {
  if (typeof choice === 'string') return ['any', 'required'].includes(choice);
  return Boolean(choice && typeof choice === 'object' &&
    ['any', 'required', 'tool'].includes(choice.type));
}

function buildPayload(messages, options = {}) {
  const config = providerConfiguration();
  const payload = {
    model: config.model,
    messages,
    max_tokens: options.max_tokens,
    stream: options.stream === true
  };
  const providerParamsError = validateProviderParams(options.provider_params);
  if (providerParamsError) {
    throw new ProviderError(providerParamsError, 400, 'INVALID_PROVIDER_PARAMS');
  }

  // Sampling overrides are opt-in. When auto-probe is disabled, omit all of
  // them so the configured upstream model uses its own defaults. When enabled,
  // only include fields the configured provider/model accepted during probing.
  const acceptedSamplingParameters = PROVIDER_SAMPLING_AUTO_PROBE &&
    options.samplingCapabilities &&
    Array.isArray(options.samplingCapabilities.accepted_parameters)
    ? new Set(options.samplingCapabilities.accepted_parameters)
    : new Set();

  if (acceptedSamplingParameters.has('temperature') && typeof options.temperature === 'number') {
    payload.temperature = options.temperature;
  }
  if (acceptedSamplingParameters.has('top_p') && typeof options.top_p === 'number') {
    payload.top_p = options.top_p;
  }
  if (acceptedSamplingParameters.has('top_k') && options.top_k !== undefined) {
    payload.top_k = options.top_k;
  }
  if (options.provider_params) {
    for (const [name, value] of Object.entries(options.provider_params)) {
      if (acceptedSamplingParameters.has(name)) payload[name] = value;
    }
  }
  if (Array.isArray(options.stop_sequences) && options.stop_sequences.length) {
    payload.stop = options.stop_sequences;
  }
  if (PROVIDER_NATIVE_REASONING_EFFORT &&
      ['low', 'medium', 'high', 'xhigh', 'max'].includes(options.reasoning_effort)) {
    payload.reasoning_effort = options.reasoning_effort;
  }
  // DSML mode deliberately disables provider tool execution and sends
  // tool_choice=none upstream. Native mode sends provider function schemas
  // and the mapped tool_choice instead.
  if (options.nativeToolCalling === true &&
      options.tool_choice !== 'none' &&
      Array.isArray(options.tools) && options.tools.length) {
    try {
      const toolNameMap = options.providerToolNameMap || createProviderToolNameMap(options.tools);
      payload.tools = providerFunctionTools(options.tools, toolNameMap);
      payload.tool_choice = providerToolChoice(options.tool_choice, toolNameMap);
      // Some providers require reasoning to be disabled for forced or named
      // native tool choices. This is an explicit generic compatibility option,
      // never inferred from a provider or model name.
      if (PROVIDER_DISABLE_REASONING_FOR_REQUIRED_TOOLS &&
          requiresNonThinkingToolChoice(options.tool_choice)) {
        payload.reasoning_effort = 'none';
      }
    } catch (error) {
      throw new ProviderError(error.message || 'Provider function-tool configuration is invalid.', 400, 'PROVIDER_TOOL_SCHEMA_UNSUPPORTED');
    }
  }
  if (options.nativeToolCalling !== true) {
    // DSML is a text-only transport. Never leave an upstream provider free
    // to choose or execute native tools, even when the client requested auto.
    payload.tool_choice = 'none';
  }
  return { config, payload };
}

function requestHeaders(apiKey, anthropicVersion, providerUrl) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
  if (typeof anthropicVersion === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(anthropicVersion)) {
    headers['anthropic-version'] = anthropicVersion;
  }
  // Opt in to routing diagnostics only for OpenRouter endpoints. This header
  // does not change the model payload or tool-calling behavior.
  try {
    const hostname = new URL(providerUrl).hostname.toLowerCase();
    if (hostname === 'openrouter.ai' || hostname.endsWith('.openrouter.ai')) {
      headers['X-OpenRouter-Metadata'] = 'enabled';
    }
  } catch {}
  return headers;
}

async function acquireProviderRequestSlot(signal) {
  try {
    return await providerRequestLimiter.acquire(signal);
  } catch (error) {
    if (signal && signal.aborted) {
      throw new ProviderError(
        'Provider request was cancelled while waiting for an available quota slot.',
        499,
        'CLIENT_DISCONNECTED'
      );
    }
    throw error;
  }
}

async function fetchWithTimeout(url, init, signal) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('Provider request timed out.')), PROVIDER_TIMEOUT_MS);
  const abort = () => controller.abort(signal.reason || new Error('Client disconnected.'));
  if (signal) {
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  }
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ProviderError(
        signal && signal.aborted ? 'Provider request was cancelled because the client disconnected.' : 'Provider request timed out.',
        signal && signal.aborted ? 499 : 504,
        signal && signal.aborted ? 'CLIENT_DISCONNECTED' : 'PROVIDER_TIMEOUT'
      );
    }
    throw new ProviderError('Could not reach the configured OpenAI-compatible provider: ' + error.message, 502, 'PROVIDER_CONNECTION_FAILED');
  } finally {
    clearTimeout(timeout);
    if (signal) signal.removeEventListener('abort', abort);
  }
}

function sanitizeProviderErrorDetail(value, maxLength = 900) {
  if (typeof value !== 'string') {
    try { value = JSON.stringify(value); } catch { value = String(value); }
  }
  return String(value)
    .replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi, '[IMAGE DATA REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|rk|pk|sk-or-v1)-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
    .replace(/(api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/\b[A-Za-z0-9+/]{160,}={0,2}\b/g, '[LONG DATA REDACTED]')
    .slice(0, maxLength);
}
async function readProviderError(response) {
  const body = await response.text().catch(() => '');
  let detail = sanitizeProviderErrorDetail(body, 1200);
  let parsed = null;
  try {
    parsed = JSON.parse(body);
  } catch {}

  const upstreamError = parsed && parsed.error && typeof parsed.error === 'object'
    ? parsed.error
    : null;
  if (upstreamError) {
    const parts = [];
    const message = upstreamError.message || upstreamError.code;
    if (message) parts.push(sanitizeProviderErrorDetail(message, 500));

    const metadata = upstreamError.metadata && typeof upstreamError.metadata === 'object'
      ? upstreamError.metadata
      : {};
    if (metadata.provider_name) {
      parts.push('provider=' + sanitizeProviderErrorDetail(metadata.provider_name, 100));
    }
    if (metadata.error_type) {
      parts.push('error_type=' + sanitizeProviderErrorDetail(metadata.error_type, 100));
    }
    if (metadata.provider_code !== undefined && metadata.provider_code !== null) {
      parts.push('provider_code=' + sanitizeProviderErrorDetail(metadata.provider_code, 160));
    }
    if (typeof metadata.is_byok === 'boolean') {
      parts.push('is_byok=' + metadata.is_byok);
    }
    if (metadata.raw) {
      let raw = metadata.raw;
      try {
        const rawJson = typeof raw === 'string' ? JSON.parse(raw) : raw;
        const nestedMessage = rawJson && rawJson.error &&
          (rawJson.error.message || rawJson.error.code);
        if (nestedMessage) raw = nestedMessage;
      } catch {}
      parts.push('provider_raw=' + sanitizeProviderErrorDetail(raw, 900));
    }
    if (parts.length) detail = parts.join('; ');
  }

  const routingMetadata = parsed && parsed.openrouter_metadata &&
    typeof parsed.openrouter_metadata === 'object'
    ? parsed.openrouter_metadata
    : (upstreamError && upstreamError.metadata &&
       upstreamError.metadata.openrouter_metadata &&
       typeof upstreamError.metadata.openrouter_metadata === 'object'
      ? upstreamError.metadata.openrouter_metadata
      : null);
  if (routingMetadata) {
    detail += (detail ? '; ' : '') +
      'openrouter_metadata=' + sanitizeProviderErrorDetail(routingMetadata, 1200);
  }

  const contextOverflow = /context_length_exceeded|maximum context length|context window.{0,40}(?:exceed|limit|token)|(?:prompt|input).{0,40}(?:too long|too many tokens|exceed.{0,20}context)/i.test(detail);
  const requestId = response.headers && (
    response.headers.get('x-request-id') ||
    response.headers.get('x-openrouter-request-id')
  );
  const responseRequestId = requestId ||
    (parsed && (parsed.id || parsed.generation_id || parsed.request_id));
  if (responseRequestId) {
    detail += '; upstream_request_id=' + sanitizeProviderErrorDetail(responseRequestId, 120);
  }

  return new ProviderError(
    'OpenAI-compatible provider returned HTTP ' + response.status + (detail ? ': ' + detail : ''),
    contextOverflow ? 400 : 502,
    contextOverflow ? 'PROVIDER_CONTEXT_WINDOW_EXCEEDED' : 'UPSTREAM_HTTP_' + response.status
  );
}

function normalizeMessageContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('');
  }
  return '';
}

async function probeSamplingParameterSet(parameters) {
  let release = null;
  try {
    const config = providerConfiguration();
    const payload = {
      model: config.model,
      messages: [{ role: 'user', content: 'Reply with OK.' }],
      max_tokens: 1,
      stream: false,
      ...parameters
    };
    release = await acquireProviderRequestSlot();
    const response = await fetchWithTimeout(config.url, {
      method: 'POST',
      headers: requestHeaders(config.apiKey, null, config.url),
      body: JSON.stringify(payload)
    });

    const raw = await response.text().catch(() => '');
    return {
      ok: response.ok,
      status: response.status,
      error: response.ok ? null : sanitizeProviderErrorDetail(raw, 700)
    };
  } catch (error) {
    return {
      ok: false,
      status: Number.isInteger(error && error.statusCode) ? error.statusCode : 0,
      error: sanitizeProviderErrorDetail(error && error.message || error, 700)
    };
  } finally {
    if (release) release();
  }
}

function initializeSamplingAutoProbe() {
  return initializeProviderSamplingCapabilities({
    enabled: PROVIDER_SAMPLING_AUTO_PROBE,
    probe: probeSamplingParameterSet
  });
}

async function createChatCompletion(messages, options = {}, signal) {
  const samplingCapabilities = await initializeSamplingAutoProbe();
  const { config, payload } = buildPayload(messages, {
    ...options,
    samplingCapabilities,
    stream: false
  });
  const release = await acquireProviderRequestSlot(signal);
  try {
    const response = await fetchWithTimeout(config.url, {
      method: 'POST',
      headers: requestHeaders(config.apiKey, options.anthropicVersion, config.url),
      body: JSON.stringify(payload)
    }, signal);
    if (!response.ok) throw await readProviderError(response);

    let data;
    try {
      data = await response.json();
    } catch (error) {
      throw new ProviderError('Provider returned invalid JSON: ' + error.message, 502, 'PROVIDER_INVALID_JSON');
    }
    const choice = data.choices && data.choices[0];
    if (!choice || !choice.message) {
      throw new ProviderError('Provider response did not contain choices[0].message.', 502, 'PROVIDER_INVALID_RESPONSE');
    }
    return {
      id: typeof data.id === 'string' && data.id ? data.id : null,
      text: normalizeMessageContent(choice.message.content),
      tool_calls: Array.isArray(choice.message.tool_calls) ? choice.message.tool_calls : [],
      reasoning: typeof choice.message.reasoning_content === 'string' ? choice.message.reasoning_content : '',
      finish_reason: choice.finish_reason || 'stop',
      usage: data.usage || null,
      provider_model: data.model || config.model
    };
  } finally {
    release();
  }
}

async function* streamChatCompletionEvents(messages, options = {}, signal) {
  const samplingCapabilities = await initializeSamplingAutoProbe();
  const { config, payload } = buildPayload(messages, {
    ...options,
    samplingCapabilities,
    stream: true
  });
  const release = await acquireProviderRequestSlot(signal);
  try {
    const response = await fetchWithTimeout(config.url, {
      method: 'POST',
      headers: { ...requestHeaders(config.apiKey, options.anthropicVersion, config.url), Accept: 'text/event-stream' },
      body: JSON.stringify(payload)
    }, signal);
    if (!response.ok) throw await readProviderError(response);
    if (!response.body || typeof response.body.getReader !== 'function') {
      throw new ProviderError('Provider did not return a readable streaming body.', 502, 'PROVIDER_STREAM_UNSUPPORTED');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let reasoning = '';
    let finishReason = 'stop';
    let usage = null;
    let responseId = null;
    let providerModel = config.model;
    const toolCallDeltas = new Map();
    let done = false;
    let timedOut = false;
    const streamTimer = setTimeout(() => {
      timedOut = true;
      reader.cancel().catch(() => {});
    }, PROVIDER_TIMEOUT_MS);
    const abortStream = () => reader.cancel().catch(() => {});
    if (signal) {
      if (signal.aborted) abortStream();
      else signal.addEventListener('abort', abortStream, { once: true });
    }

    function processEvent(eventText) {
      const dataLines = eventText.split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^\s/, ''));
      if (!dataLines.length) return [];
      const dataText = dataLines.join('\n');
      if (dataText === '[DONE]') {
        done = true;
        return [];
      }
      let data;
      try {
        data = JSON.parse(dataText);
      } catch {
        throw new ProviderError('Provider emitted malformed SSE JSON.', 502, 'PROVIDER_INVALID_STREAM');
      }
      if (data.error) {
        throw new ProviderError(
          data.error.message || 'Provider stream returned an error.',
          502,
          data.error.code || 'PROVIDER_STREAM_ERROR'
        );
      }

      const events = [];
      if (data.usage) {
        usage = data.usage;
        events.push({ type: 'usage', usage });
      }
      if (!responseId && typeof data.id === 'string' && data.id) responseId = data.id;
      if (typeof data.model === 'string' && data.model) providerModel = data.model;
      const choice = data.choices && data.choices[0];
      if (!choice) return events;

      const delta = choice.delta || {};
      let textDelta = '';
      if (typeof delta.content === 'string') textDelta = delta.content;
      else if (Array.isArray(delta.content)) textDelta = normalizeMessageContent(delta.content);
      if (textDelta) {
        text += textDelta;
        events.push({ type: 'text_delta', text: textDelta });
      }
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
        reasoning += delta.reasoning_content;
        events.push({ type: 'reasoning_delta', text: delta.reasoning_content });
      }
      if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) {
        mergeProviderToolCallDelta(toolCallDeltas, delta.tool_calls);
        events.push({ type: 'tool_call_delta', deltas: delta.tool_calls });
      }
      if (choice.finish_reason) {
        finishReason = choice.finish_reason;
        events.push({ type: 'finish', reason: finishReason });
      }
      return events;
    }

    try {
      while (!done) {
        const result = await reader.read();
        if (result.done) {
          buffer += decoder.decode();
          break;
        }
        buffer += decoder.decode(result.value, { stream: true });
        let boundary;
        while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
          const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/)[0];
          const eventText = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + separator.length);
          for (const event of processEvent(eventText)) yield event;
          if (done) break;
        }
      }
      if (buffer.trim()) {
        for (const event of processEvent(buffer)) yield event;
      }
    } catch (error) {
      try { await reader.cancel(error); } catch {}
      if (error instanceof ProviderError) throw error;
      if (signal && signal.aborted) {
        throw new ProviderError('Provider streaming response was cancelled because the client disconnected.', 499, 'CLIENT_DISCONNECTED');
      }
      if (timedOut) throw new ProviderError('Provider streaming response timed out.', 504, 'PROVIDER_TIMEOUT');
      throw new ProviderError('Provider streaming response ended unexpectedly: ' + (error.message || String(error)), 502, 'PROVIDER_STREAM_INCOMPLETE');
    } finally {
      clearTimeout(streamTimer);
      if (signal) signal.removeEventListener('abort', abortStream);
      try { reader.releaseLock(); } catch {}
    }

    if (timedOut) {
      throw new ProviderError('Provider streaming response timed out.', 504, 'PROVIDER_TIMEOUT');
    }
    if (signal && signal.aborted) {
      throw new ProviderError('Provider streaming response was cancelled because the client disconnected.', 499, 'CLIENT_DISCONNECTED');
    }
    if (!done) {
      throw new ProviderError('Provider stream ended before the [DONE] marker; partial output was discarded.', 502, 'PROVIDER_STREAM_INCOMPLETE');
    }

    yield {
      type: 'completion',
      completion: {
        id: responseId,
        text,
        tool_calls: finalizeProviderToolCallDeltas(toolCallDeltas),
        reasoning,
        finish_reason: finishReason,
        usage,
        provider_model: providerModel
      }
    };
  } finally {
    release();
  }
}

async function createStreamingChatCompletion(messages, options = {}, signal) {
  let completion = null;
  for await (const event of streamChatCompletionEvents(messages, options, signal)) {
    if (event.type === 'completion') completion = event.completion;
  }
  if (!completion) {
    throw new ProviderError('Provider stream did not produce a completion.', 502, 'PROVIDER_STREAM_INCOMPLETE');
  }
  return completion;
}

module.exports = {
  ProviderError,
  completionsUrl,
  buildPayload,
  sanitizeProviderErrorDetail,
  initializeSamplingAutoProbe,
  createChatCompletion,
  createStreamingChatCompletion,
  streamChatCompletionEvents
};
