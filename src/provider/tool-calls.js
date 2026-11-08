'use strict';

const PROVIDER_TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function createProviderToolNameMap(tools) {
  const list = Array.isArray(tools) ? tools : [];
  const originalNames = new Set();
  const reservedProviderNames = new Set();

  for (const tool of list) {
    if (!tool || typeof tool.name !== 'string' || !tool.name.trim()) {
      throw new TypeError('Every provider tool must have a non-empty name.');
    }
    if (originalNames.has(tool.name)) {
      throw new TypeError('Duplicate tool name: ' + tool.name);
    }
    originalNames.add(tool.name);
    if (PROVIDER_TOOL_NAME_PATTERN.test(tool.name)) reservedProviderNames.add(tool.name);
  }

  const originalToProvider = new Map();
  const providerToOriginal = new Map();
  for (const tool of list) {
    const originalName = tool.name;
    let providerName = originalName;

    if (!PROVIDER_TOOL_NAME_PATTERN.test(originalName)) {
      const base = originalName.replace(/[^A-Za-z0-9_-]/g, '_').replace(/_+/g, '_') || 'tool';
      providerName = base.slice(0, 64);
      let suffixIndex = 2;
      while (reservedProviderNames.has(providerName) || providerToOriginal.has(providerName)) {
        const suffix = '_' + suffixIndex++;
        const available = 64 - suffix.length;
        if (available < 1) {
          throw new TypeError('Unable to create a unique provider-safe name for tool ' + originalName + '.');
        }
        providerName = base.slice(0, available) + suffix;
      }
    }

    originalToProvider.set(originalName, providerName);
    providerToOriginal.set(providerName, originalName);
  }

  return { originalToProvider, providerToOriginal };
}

function restoreProviderToolCallNames(toolCalls, nameMap) {
  if (!Array.isArray(toolCalls) || !nameMap || !(nameMap.providerToOriginal instanceof Map)) {
    return toolCalls;
  }
  return toolCalls.map((call) => {
    if (!call || typeof call.name !== 'string') return call;
    const originalName = nameMap.providerToOriginal.get(call.name);
    return originalName ? { ...call, name: originalName } : call;
  });
}

function providerToolChoice(choice, nameMap) {
  if (!choice) return 'auto';
  const mode = typeof choice === 'string' ? choice : choice.type;
  if (mode === 'none' || mode === 'auto' || mode === 'required') return mode;
  if (mode === 'any') return 'required';
  if (mode === 'tool' && choice && typeof choice.name === 'string' && choice.name.trim()) {
    const providerName = nameMap && nameMap.originalToProvider instanceof Map
      ? nameMap.originalToProvider.get(choice.name)
      : choice.name;
    if (!providerName) throw new TypeError('tool_choice references an undeclared tool: ' + choice.name);
    return { type: 'function', function: { name: providerName } };
  }
  throw new TypeError('Unsupported Anthropic tool_choice value for the OpenAI-compatible provider.');
}

function providerFunctionTools(tools, nameMap = createProviderToolNameMap(tools)) {
  if (!Array.isArray(tools) || tools.length === 0) return [];
  return tools.map((tool) => {
    if (!tool || typeof tool.name !== 'string' || !nameMap.originalToProvider.has(tool.name)) {
      throw new TypeError('Provider tool-name mapping is missing a declared tool.');
    }
    const providerName = nameMap.originalToProvider.get(tool.name);
    if (!PROVIDER_TOOL_NAME_PATTERN.test(providerName)) {
      throw new TypeError('Mapped provider tool names must match [A-Za-z0-9_-] and be at most 64 characters.');
    }
    const schema = tool.input_schema && typeof tool.input_schema === 'object'
      ? tool.input_schema
      : { type: 'object', properties: {} };
    return {
      type: 'function',
      function: {
        name: providerName,
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
  createProviderToolNameMap,
  restoreProviderToolCallNames,
  normalizeProviderToolCalls,
  mergeProviderToolCallDelta,
  finalizeProviderToolCallDeltas
};
