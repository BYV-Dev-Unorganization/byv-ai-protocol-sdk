'use strict';

function providerToolChoice(choice) {
  if (!choice) return 'auto';
  const mode = typeof choice === 'string' ? choice : choice.type;
  if (mode === 'none' || mode === 'auto' || mode === 'required') return mode;
  if (mode === 'any') return 'required';
  if (mode === 'tool' && choice && typeof choice.name === 'string' && choice.name.trim()) {
    return { type: 'function', function: { name: choice.name } };
  }
  throw new TypeError('Unsupported Anthropic tool_choice value for the OpenAI-compatible provider.');
}

function providerFunctionTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return [];
  return tools.map((tool) => {
    if (!tool || typeof tool.name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(tool.name)) {
      throw new TypeError('Tool names sent to the provider must match [A-Za-z0-9_-] and be at most 64 characters.');
    }
    const schema = tool.input_schema && typeof tool.input_schema === 'object'
      ? tool.input_schema
      : { type: 'object', properties: {} };
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: typeof tool.description === 'string' ? tool.description : '',
        parameters: schema
      }
    };
  });
}

function normalizeProviderToolCalls(toolCalls, makeId) {
  if (toolCalls === undefined || toolCalls === null) return { calls: [], error: null };
  if (!Array.isArray(toolCalls)) {
    return { calls: [], error: 'Provider tool_calls must be an array.' };
  }

  const calls = [];
  const ids = new Set();
  for (let index = 0; index < toolCalls.length; index++) {
    const item = toolCalls[index];
    const name = item && item.function && item.function.name;
    if (item && item.type && item.type !== 'function') {
      return { calls: [], error: 'Provider returned an unsupported tool-call type at index ' + index + '.' };
    }
    if (typeof name !== 'string' || !name.trim()) {
      return { calls: [], error: 'Provider tool call at index ' + index + ' is missing a function name.' };
    }

    const rawArguments = item.function.arguments;
    let input;
    if (rawArguments === undefined || rawArguments === null || rawArguments === '') {
      input = {};
    } else if (typeof rawArguments === 'string') {
      try {
        input = JSON.parse(rawArguments);
      } catch (error) {
        return {
          calls: [],
          error: 'Provider tool call "' + name + '" returned invalid JSON arguments: ' + error.message
        };
      }
    } else {
      input = rawArguments;
    }

    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      return { calls: [], error: 'Provider tool call "' + name + '" arguments must be a JSON object.' };
    }

    let id = item.id;
    if (typeof id !== 'string' || !id.trim()) {
      id = typeof makeId === 'function' ? makeId() : 'call_' + (index + 1);
    }
    if (ids.has(id)) {
      return { calls: [], error: 'Provider returned duplicate tool-call ID "' + id + '".' };
    }
    ids.add(id);
    calls.push({ id, name, input });
  }
  return { calls, error: null };
}

function mergeProviderToolCallDelta(target, deltas) {
  if (!Array.isArray(deltas)) return target;
  for (const delta of deltas) {
    if (!delta || typeof delta !== 'object') continue;
    const index = Number.isInteger(delta.index) && delta.index >= 0 ? delta.index : target.size;
    const current = target.get(index) || {
      id: '',
      type: 'function',
      function: { name: '', arguments: '' }
    };
    if (typeof delta.id === 'string') current.id = delta.id;
    if (delta.type) current.type = delta.type;
    if (delta.function && typeof delta.function === 'object') {
      if (typeof delta.function.name === 'string') current.function.name += delta.function.name;
      if (typeof delta.function.arguments === 'string') current.function.arguments += delta.function.arguments;
    }
    target.set(index, current);
  }
  return target;
}

function finalizeProviderToolCallDeltas(target) {
  return [...target.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, value]) => value);
}

module.exports = {
  providerToolChoice,
  providerFunctionTools,
  normalizeProviderToolCalls,
  mergeProviderToolCallDelta,
  finalizeProviderToolCallDeltas
};
