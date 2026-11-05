'use strict';

const { normalizeToolCall, normalizeToolCalls, isPlainObject } = require('./tool-call-normalizer');

const DSML_TOKEN = '｜DSML｜';
const ALLOWED_WRAPPERS = new Set(['calls', 'tool_calls', 'function_calls']);
const PARAMETER_NAME = /^[A-Za-z0-9_-][A-Za-z0-9_.:-]{0,127}$/;

/**
 * Prevent a literal DSML parameter-closing tag inside a value from terminating
 * the surrounding parameter. The adapter reverses this escape for string
 * parameters; JSON.parse reverses the escaped slash in JSON values.
 */
function escapeDsmlClosingTags(value) {
  return String(value).replace(
    /<(\/\s*[｜|]{1,2}\s*DSML\s*[｜|]{1,2}\s*parameter\s*)>/gi,
    (_match, closing) => '<\\' + closing + '>'
  );
}

function assertJsonValue(value, path = '$', ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(path + ' contains a non-finite number.');
    return;
  }
  if (typeof value !== 'object') {
    throw new TypeError(path + ' is not a JSON-compatible value.');
  }
  if (ancestors.has(value)) throw new TypeError(path + ' contains a circular reference.');

  if (!Array.isArray(value) && !isPlainObject(value)) {
    throw new TypeError(path + ' must contain only plain objects and arrays.');
  }

  ancestors.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      if (!(index in value)) throw new TypeError(path + '[' + index + '] is an empty array slot.');
      assertJsonValue(value[index], path + '[' + index + ']', ancestors);
    }
  } else {
    for (const key of Object.keys(value)) {
      assertJsonValue(value[key], path + '.' + key, ancestors);
    }
  }
  ancestors.delete(value);
}

function serializeParameter(name, value) {
  if (typeof name !== 'string' || !PARAMETER_NAME.test(name)) {
    throw new TypeError('Invalid DSML parameter name: ' + String(name));
  }
  assertJsonValue(value, '$.' + name);

  const isString = typeof value === 'string';
  const serialized = isString
    ? escapeDsmlClosingTags(value)
    : escapeDsmlClosingTags(JSON.stringify(value));

  return '<' + DSML_TOKEN + 'parameter name="' + name + '" string="' +
    (isString ? 'true' : 'false') + '">' +
    serialized +
    '</' + DSML_TOKEN + 'parameter>';
}

function toolCallToDsml(call, index = 0) {
  const normalized = normalizeToolCall(call, index);
  const parameters = Object.entries(normalized.arguments)
    .map(([name, value]) => serializeParameter(name, value));
  return [
    '<' + DSML_TOKEN + 'invoke name="' + normalized.name + '">',
    ...parameters,
    '</' + DSML_TOKEN + 'invoke>'
  ].join('\n');
}

function jsonToDsml(input, options = {}) {
  const wrapper = options.wrapper || 'tool_calls';
  if (!ALLOWED_WRAPPERS.has(wrapper)) {
    throw new TypeError('Unsupported DSML wrapper: ' + wrapper);
  }

  const calls = Array.isArray(input) ? input : [input];
  if (calls.length === 0) throw new TypeError('At least one tool call is required.');

  const normalized = normalizeToolCalls(calls);
  const invokes = normalized.map((call, index) => toolCallToDsml(call, index));
  return [
    '<' + DSML_TOKEN + wrapper + '>',
    invokes.join('\n'),
    '</' + DSML_TOKEN + wrapper + '>'
  ].join('\n');
}

module.exports = {
  DSML_TOKEN,
  ALLOWED_WRAPPERS,
  escapeDsmlClosingTags,
  assertJsonValue,
  serializeParameter,
  toolCallToDsml,
  jsonToDsml
};
