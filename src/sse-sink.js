'use strict';

const { uuid } = require('./config');
const { estimateOutputTokens } = require('./content');

function sendEvent(res, event, data) {
  if (res.destroyed || res.writableEnded) return false;
  return res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
}

function sendAnthropicMessageStart(res, model, inputTokens, usage = {}) {
  const messageId = uuid('msg');
  sendEvent(res, 'message_start', {
    type: 'message_start',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: inputTokens,
        output_tokens: 0,
        ...(Number.isInteger(usage.cache_creation_input_tokens)
          ? { cache_creation_input_tokens: usage.cache_creation_input_tokens } : {}),
        ...(Number.isInteger(usage.cache_read_input_tokens)
          ? { cache_read_input_tokens: usage.cache_read_input_tokens } : {})
      }
    }
  });
  return messageId;
}

function sendAnthropicStream(res, result, model, inputTokens, options = {}) {
  if (!options.messageStarted) sendAnthropicMessageStart(res, model, inputTokens, result.usage || {});

  let index = 0;
  if (result.text) {
    sendEvent(res, 'content_block_start', {
      type: 'content_block_start',
      index,
      content_block: { type: 'text', text: '' }
    });
    for (let offset = 0; offset < result.text.length; offset += 2048) {
      sendEvent(res, 'content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text: result.text.slice(offset, offset + 2048) }
      });
    }
    sendEvent(res, 'content_block_stop', { type: 'content_block_stop', index });
    index++;
  }

  for (const call of result.toolCalls || []) {
    sendEvent(res, 'content_block_start', {
      type: 'content_block_start',
      index,
      content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} }
    });
    const json = JSON.stringify(call.input || {});
    for (let offset = 0; offset < json.length; offset += 1024) {
      sendEvent(res, 'content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: json.slice(offset, offset + 1024) }
      });
    }
    sendEvent(res, 'content_block_stop', { type: 'content_block_stop', index });
    index++;
  }

  const outputTokens = result.usage && Number.isInteger(result.usage.output_tokens)
    ? result.usage.output_tokens
    : estimateOutputTokens(result);
  sendEvent(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: result.stop_reason, stop_sequence: null },
    usage: { output_tokens: outputTokens }
  });
  sendEvent(res, 'message_stop', { type: 'message_stop' });
}


function clientDisconnectedError() {
  return Object.assign(new Error('The client disconnected while the stream was writing.'), {
    statusCode: 499,
    type: 'api_error',
    code: 'CLIENT_DISCONNECTED'
  });
}

function waitForDrain(res, signal) {
  if (signal && signal.aborted) return Promise.reject(clientDisconnectedError());
  if (res.destroyed) return Promise.reject(clientDisconnectedError());
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      res.removeListener('drain', onDrain);
      res.removeListener('close', onClose);
      res.removeListener('error', onError);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); reject(clientDisconnectedError()); };
    const onError = (error) => { cleanup(); reject(error); };
    const onAbort = () => { cleanup(); reject(clientDisconnectedError()); };
    res.once('drain', onDrain);
    res.once('close', onClose);
    res.once('error', onError);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    if (signal && signal.aborted) onAbort();
  });
}

async function writeEventAsync(res, event, data, signal) {
  if (res.destroyed || res.writableEnded || (signal && signal.aborted)) {
    throw clientDisconnectedError();
  }
  const accepted = res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
  if (accepted === false) await waitForDrain(res, signal);
  return true;
}

function createAnthropicStreamWriter(res, model, inputTokens, signal) {
  let messageStarted = false;
  let textBlockOpen = false;
  let textBlockIndex = 0;
  let nextBlockIndex = 0;
  let stopped = false;

  let writeChain = Promise.resolve();
  const emit = (event, data) => {
    const pending = writeChain.then(() => writeEventAsync(res, event, data, signal));
    writeChain = pending.catch(() => {});
    return pending;
  };

  async function closeTextBlock() {
    if (!textBlockOpen) return;
    await emit('content_block_stop', { type: 'content_block_stop', index: textBlockIndex });
    textBlockOpen = false;
  }

  return {
    async start() {
      if (messageStarted) return;
      const messageId = uuid('msg');
      await emit('message_start', {
        type: 'message_start',
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: inputTokens, output_tokens: 0 }
        }
      });
      messageStarted = true;
      return messageId;
    },

    async ping() {
      if (stopped) return false;
      return emit('ping', { type: 'ping' });
    },

    async writeTextDelta(value) {
      if (stopped || typeof value !== 'string' || value.length === 0) return;
      if (!messageStarted) await this.start();
      if (!textBlockOpen) {
        textBlockIndex = nextBlockIndex++;
        await emit('content_block_start', {
          type: 'content_block_start',
          index: textBlockIndex,
          content_block: { type: 'text', text: '' }
        });
        textBlockOpen = true;
      }
      await emit('content_block_delta', {
        type: 'content_block_delta',
        index: textBlockIndex,
        delta: { type: 'text_delta', text: value }
      });
    },

    async writeToolCalls(calls) {
      await closeTextBlock();
      for (const call of Array.isArray(calls) ? calls : []) {
        if (stopped) return;
        const index = nextBlockIndex++;
        await emit('content_block_start', {
          type: 'content_block_start',
          index,
          content_block: {
            type: 'tool_use',
            id: call.id,
            name: call.name,
            input: {}
          }
        });
        const json = JSON.stringify(call.input || {});
        for (let offset = 0; offset < json.length; offset += 1024) {
          await emit('content_block_delta', {
            type: 'content_block_delta',
            index,
            delta: { type: 'input_json_delta', partial_json: json.slice(offset, offset + 1024) }
          });
        }
        await emit('content_block_stop', { type: 'content_block_stop', index });
      }
    },

    async finish(result) {
      if (stopped) return;
      if (!messageStarted) await this.start();
      await closeTextBlock();
      const outputTokens = result.usage && Number.isInteger(result.usage.output_tokens)
        ? result.usage.output_tokens
        : estimateOutputTokens(result);
      await emit('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: result.stop_reason, stop_sequence: null },
        usage: { output_tokens: outputTokens }
      });
      await emit('message_stop', { type: 'message_stop' });
      stopped = true;
    },

    async error(error) {
      if (stopped) return;
      await closeTextBlock();
      await emit('error', {
        type: 'error',
        error: {
          type: error.type || 'api_error',
          message: error.message || 'Gateway request failed.',
          code: error.code || 'GATEWAY_ERROR'
        }
      });
      stopped = true;
    }
  };
}

module.exports = { sendEvent, sendAnthropicMessageStart, sendAnthropicStream, writeEventAsync, createAnthropicStreamWriter };