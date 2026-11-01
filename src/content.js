'use strict';

const { isPlainObject } = require('./anthropic-contract');

function blocksOf(content) {
  if (content === null || content === undefined) return [];
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content : [];
}

function flattenText(content) {
  return blocksOf(content)
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

function renderToolResultContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return flattenText(content);
  if (content === null || content === undefined) return '';
  return JSON.stringify(content);
}

function convertAnthropicMessages(messages) {
  const output = [];
  const knownToolUseIds = new Set();

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    const blocks = blocksOf(message.content);

    if (message.role === 'assistant') {
      const text = flattenText(blocks);
      const toolUses = blocks.filter((block) => block && block.type === 'tool_use');
      const toolCalls = toolUses.map((block) => {
        if (!block.id || knownToolUseIds.has(block.id)) {
          throw Object.assign(new Error('Duplicate or missing tool_use id in conversation: ' + String(block.id || '')), { statusCode: 400, type: 'invalid_request_error' });
        }
        knownToolUseIds.add(block.id);
        return {
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input || {})
          }
        };
      });
      if (text || toolCalls.length) {
        const converted = { role: 'assistant', content: text || null };
        if (toolCalls.length) converted.tool_calls = toolCalls;
        output.push(converted);
      }
      continue;
    }

    const toolResults = blocks.filter((block) => block && block.type === 'tool_result');
    const textBlocks = blocks.filter((block) => block && block.type === 'text');
    const text = flattenText(textBlocks);
    if (text) output.push({ role: 'user', content: text });

    for (const result of toolResults) {
      if (!knownToolUseIds.has(result.tool_use_id)) {
        throw Object.assign(new Error('tool_result references an unknown tool_use_id: ' + result.tool_use_id), { statusCode: 400, type: 'invalid_request_error' });
      }
      output.push({
        role: 'tool',
        tool_call_id: result.tool_use_id,
        content: renderToolResultContent(result.content)
      });
    }
  }

  return output;
}

function estimateInputTokens(body) {
  const source = JSON.stringify({
    system: body.system || null,
    messages: body.messages || [],
    tools: body.tools || [],
    tool_choice: body.tool_choice || null
  });
  return Math.max(1, Math.ceil(source.length / 4));
}

function estimateOutputTokens(result) {
  const value = JSON.stringify({
    text: result.text || '',
    tool_calls: result.toolCalls || []
  });
  return Math.max(1, Math.ceil(value.length / 4));
}

function truncateMessages(messages, maxChars) {
  const list = messages.slice();
  let total = list.reduce((sum, message) => sum + JSON.stringify(message).length, 0);
  while (total > maxChars && list.length > 2) {
    const removed = list.splice(1, 1)[0];
    total -= JSON.stringify(removed).length;
  }
  return { messages: list, truncated: total > maxChars };
}

module.exports = {
  blocksOf,
  flattenText,
  renderToolResultContent,
  convertAnthropicMessages,
  estimateInputTokens,
  estimateOutputTokens,
  truncateMessages
};