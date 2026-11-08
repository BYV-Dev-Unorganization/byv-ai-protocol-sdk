'use strict';

const { isPlainObject } = require('../anthropic-contract');
const { compileJsonSchema } = require('./json-schema');
const compiledSchemas = new WeakMap();

function compileSchema(schema) {
  if (!isPlainObject(schema)) throw new Error('Tool input_schema must be a JSON Schema object.');
  if (compiledSchemas.has(schema)) return compiledSchemas.get(schema);
  const validate = compileJsonSchema(schema);
  compiledSchemas.set(schema, validate);
  return validate;
}

function validateToolCalls(toolCalls, tools, options = {}) {
  const specs = new Map((Array.isArray(tools) ? tools : []).map((tool) => [tool.name, tool]));
  const ids = new Set();
  const maxCalls = Number.isInteger(options.maxCalls) ? options.maxCalls : 32;
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    return { valid: false, error: 'No BYV invocation was produced.' };
  }
  if (toolCalls.length > maxCalls) {
    return { valid: false, error: 'Tool-call batch exceeds the maximum of ' + maxCalls + ' invocations.' };
  }

  for (const call of toolCalls) {
    if (!call || typeof call.id !== 'string' || !call.id.trim()) {
      return { valid: false, error: 'Invocation is missing a valid id.' };
    }
    if (ids.has(call.id)) return { valid: false, error: 'Duplicate invocation id: ' + call.id };
    ids.add(call.id);
    if (typeof call.name !== 'string' || !call.name.trim()) {
      return { valid: false, error: 'Invocation is missing a valid tool name.' };
    }
    const spec = specs.get(call.name);
    if (!spec) return { valid: false, error: 'Tool ' + call.name + ' was not declared in this request.' };
    if (!isPlainObject(call.input)) {
      return { valid: false, error: 'Arguments for tool ' + call.name + ' must be a JSON object.' };
    }
    let validate;
    try {
      validate = compileSchema(spec.input_schema);
    } catch (error) {
      return { valid: false, error: 'The declared schema for tool ' + call.name + ' is invalid: ' + error.message };
    }
    if (!validate(call.input)) {
      const detail = (validate.errors || [])
        .slice(0, 6)
        .map((item) => item.instancePath + ' ' + item.message)
        .join('; ');
      return { valid: false, error: 'Arguments for tool ' + call.name + ' failed schema validation: ' + detail };
    }
  }
  return { valid: true, error: null };
}

module.exports = { validateToolCalls, compileSchema };