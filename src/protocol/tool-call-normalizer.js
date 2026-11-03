'use strict';

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseArguments(value, label) {
  if (value === undefined) return {};
  if (value === null) throw new TypeError((label || 'Tool call') + ' arguments must be a JSON object, not null.');
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch (error) {
      throw new TypeError((label || 'Tool call') + ' arguments contain invalid JSON: ' + error.message);
    }
  }
  if (!isPlainObject(parsed)) {
    throw new TypeError((label || 'Tool call') + ' arguments must be a JSON object.');
  }
  return parsed;
}

/**
 * Normalize Anthropic tool_use blocks, OpenAI-compatible function calls, and
 * the gateway's small canonical shape to { id?, name, arguments }.
 */
function normalizeToolCall(call, index = 0) {
  if (!call || typeof call !== 'object' || Array.isArray(call)) {
    throw new TypeError('Tool call at index ' + index + ' must be an object.');
  }

  let name;
  let rawArguments;
  let id = typeof call.id === 'string' && call.id ? call.id : undefined;

  if (call.type === 'tool_use') {
    name = call.name;
    rawArguments = call.input;
  } else if (call.function && typeof call.function === 'object') {
    name = call.function.name;
    rawArguments = call.function.arguments;
  } else {
    name = call.name;
    rawArguments = Object.prototype.hasOwnProperty.call(call, 'arguments')
      ? call.arguments
      : call.input;
  }

  if (typeof name !== 'string' || !/^[A-Za-z0-9_.:/-]{1,128}$/.test(name)) {
    throw new TypeError('Tool call at index ' + index + ' has an invalid tool name.');
  }

  return {
    ...(id ? { id } : {}),
    name,
    arguments: parseArguments(rawArguments, 'Tool call "' + name + '"')
  };
}

function normalizeToolCalls(calls) {
  if (!Array.isArray(calls)) throw new TypeError('Tool calls must be an array.');
  return calls.map((call, index) => normalizeToolCall(call, index));
}

module.exports = { isPlainObject, parseArguments, normalizeToolCall, normalizeToolCalls };
