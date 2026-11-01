'use strict';

const {
  PROVIDER_BASE_URL,
  PROVIDER_API_KEY,
  PROVIDER_MODEL,
  PROVIDER_TIMEOUT_MS,
  PROVIDER_MAX_REQUESTS_PER_MINUTE,
  PROVIDER_MAX_CONCURRENT_REQUESTS
} = require('../config');
const { createProviderRequestLimiter } = require('./request-limiter');

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

function buildPayload(messages, options = {}) {
  const config = providerConfiguration();
  const payload = {
    model: config.model,
    messages,
    max_tokens: options.max_tokens,
    stream: options.stream === true
  };
  if (typeof options.temperature === 'number') payload.temperature = options.temperature;
  if (typeof options.top_p === 'number') payload.top_p = options.top_p;
  if (Array.isArray(options.stop_sequences) && options.stop_sequences.length) {
    payload.stop = options.stop_sequences;
  }
  return { config, payload };
}

function requestHeaders(apiKey) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
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

async function readProviderError(response) {
  const body = await response.text().catch(() => '');
  let detail = body.slice(0, 1200);
  try {
    const parsed = JSON.parse(body);
    detail = parsed.error && (parsed.error.message || parsed.error.code)
      ? String(parsed.error.message || parsed.error.code)
      : detail;
  } catch {}
  return new ProviderError(
    'OpenAI-compatible provider returned HTTP ' + response.status + (detail ? ': ' + detail : ''),
    502,
    'UPSTREAM_HTTP_' + response.status
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

async function createChatCompletion(messages, options = {}, signal) {
  const { config, payload } = buildPayload(messages, { ...options, stream: false });
  const release = await acquireProviderRequestSlot(signal);
  try {
    const response = await fetchWithTimeout(config.url, {
      method: 'POST',
      headers: requestHeaders(config.apiKey),
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
      text: normalizeMessageContent(choice.message.content),
      reasoning: typeof choice.message.reasoning_content === 'string' ? choice.message.reasoning_content : '',
      finish_reason: choice.finish_reason || 'stop',
      usage: data.usage || null,
      provider_model: data.model || config.model
    };
  } finally {
    release();
  }
}

async function createStreamingChatCompletion(messages, options = {}, signal) {
  const { config, payload } = buildPayload(messages, { ...options, stream: true });
  const release = await acquireProviderRequestSlot(signal);
  try {
    const response = await fetchWithTimeout(config.url, {
      method: 'POST',
      headers: { ...requestHeaders(config.apiKey), Accept: 'text/event-stream' },
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
        .map((line) => line.slice(5).trim());
      if (!dataLines.length) return;
      const dataText = dataLines.join('\n');
      if (dataText === '[DONE]') {
        done = true;
        return;
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
      if (data.usage) usage = data.usage;
      const choice = data.choices && data.choices[0];
      if (!choice) return;
      const delta = choice.delta || {};
      if (typeof delta.content === 'string') text += delta.content;
      else if (Array.isArray(delta.content)) text += normalizeMessageContent(delta.content);
      if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }

    try {
      while (!done) {
        const result = await reader.read();
        if (result.done) break;
        buffer += decoder.decode(result.value, { stream: true });
        let boundary;
        while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
          const eventText = buffer.slice(0, boundary);
          const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/)[0];
          buffer = buffer.slice(boundary + separator.length);
          processEvent(eventText);
          if (done) break;
        }
      }
      if (buffer.trim()) processEvent(buffer);
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

    return {
      text,
      reasoning,
      finish_reason: finishReason,
      usage,
      provider_model: config.model
    };
  } finally {
    release();
  }
}

module.exports = {
  ProviderError,
  completionsUrl,
  buildPayload,
  createChatCompletion,
  createStreamingChatCompletion
};
