'use strict';

const { uuid } = require('./config');
const { estimateOutputTokens } = require('./content');

function sendEvent(res, event, data) {
  if (res.destroyed || res.writableEnded) return false;
  return res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
}

function sendAnthropicMessageStart(res, model, inputTokens) {
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
      usage: { input_tokens: inputTokens, output_tokens: 0 }
    }
  });
  return messageId;
}

function sendAnthropicStream(res, result, model, inputTokens, options = {}) {
  if (!options.messageStarted) sendAnthropicMessageStart(res, model, inputTokens);

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

module.exports = { sendEvent, sendAnthropicMessageStart, sendAnthropicStream };