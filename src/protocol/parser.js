'use strict';

const OPEN_CALLS = '<|BYV| calls>';
const CLOSE_CALLS = '</|BYV| calls>';
const OPEN_INVOKE = '<|BYV| invoke';
const CLOSE_INVOKE = '</|BYV| invoke>';
const OPEN_PARAMETER = '<|BYV| parameter';
const CLOSE_PARAMETER = '</|BYV| parameter>';
const { maskMarkdownCode } = require('./markdown-code');

function findUnescaped(source, token, fromIndex) {
  let index = fromIndex || 0;
  while (index < source.length) {
    const found = source.indexOf(token, index);
    if (found < 0) return -1;
    let slashCount = 0;
    for (let cursor = found - 1; cursor >= 0 && source[cursor] === '\\'; cursor--) slashCount++;
    if (slashCount % 2 === 0) return found;
    index = found + token.length;
  }
  return -1;
}

function parseOrderedAttributes(raw, expectedNames, context) {
  const attributes = [];
  const pattern = /([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*"([^"]*)"/g;
  let match;
  let cursor = 0;
  while ((match = pattern.exec(raw)) !== null) {
    if (raw.slice(cursor, match.index).trim()) {
      throw new Error(context + ' contains invalid attribute syntax.');
    }
    attributes.push([match[1], match[2]]);
    cursor = pattern.lastIndex;
  }
  if (raw.slice(cursor).trim()) throw new Error(context + ' contains invalid trailing attribute syntax.');
  if (attributes.length !== expectedNames.length) {
    throw new Error(context + ' must declare exactly ' + expectedNames.join(' then ') + '.');
  }
  for (let i = 0; i < expectedNames.length; i++) {
    if (attributes[i][0] !== expectedNames[i]) {
      throw new Error(context + ' attributes must appear in order: ' + expectedNames.join(', ') + '.');
    }
  }
  return Object.fromEntries(attributes);
}

function decodeBYVString(raw) {
  let output = '';
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (char !== '\\') {
      output += char;
      continue;
    }
    if (raw.startsWith('\\</|BYV| parameter>', i)) {
      output += CLOSE_PARAMETER;
      i += '\\</|BYV| parameter>'.length - 1;
      continue;
    }
    const next = raw[i + 1];
    if (next === '\\') output += '\\';
    else if (next === 'n') output += '\n';
    else if (next === 'r') output += '\r';
    else if (next === 't') output += '\t';
    else throw new Error('String parameter contains an unsupported or incomplete BYV escape at offset ' + i + '.');
    i++;
  }
  return output;
}

function typeMatches(value, type) {
  if (type === 'string') return typeof value === 'string';
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  return false;
}

function decodeParameter(raw, type, name) {
  if (type === 'string') return decodeBYVString(raw);
  let value;
  try {
    value = JSON.parse(raw.trim());
  } catch (error) {
    throw new Error('Parameter ' + name + ' contains invalid JSON: ' + error.message);
  }
  if (!typeMatches(value, type)) {
    throw new Error('Parameter ' + name + ' declares type ' + type + ' but its JSON value has a different type.');
  }
  return value;
}

function parseInvocationBlock(raw) {
  const masked = maskMarkdownCode(raw);
  const calls = [];
  let cursor = 0;
  while (cursor < raw.length) {
    while (/\s/.test(masked[cursor] || '') && cursor < raw.length) cursor++;
    if (cursor >= raw.length) break;

    if (!masked.startsWith(OPEN_INVOKE, cursor)) {
      throw new Error('Unexpected content inside BYV calls block; expected invoke.');
    }
    const headerEnd = masked.indexOf('>', cursor);
    if (headerEnd < 0) throw new Error('BYV invoke header is incomplete.');
    const header = raw.slice(cursor + OPEN_INVOKE.length, headerEnd);
    const attrs = parseOrderedAttributes(header, ['name', 'id'], 'BYV invoke');
    if (!attrs.name.trim() || !attrs.id.trim()) throw new Error('BYV invoke name and id must be non-empty.');
    const input = Object.create(null);
    cursor = headerEnd + 1;
    let invokeClosed = false;

    while (cursor < raw.length) {
      while (/\s/.test(raw[cursor] || '') && cursor < raw.length) cursor++;
      if (masked.startsWith(CLOSE_INVOKE, cursor)) {
        cursor += CLOSE_INVOKE.length;
        invokeClosed = true;
        break;
      }
      if (!masked.startsWith(OPEN_PARAMETER, cursor)) {
        throw new Error('Unexpected content inside invoke ' + attrs.id + '; expected parameter or invoke close.');
      }
      const parameterHeaderEnd = masked.indexOf('>', cursor);
      if (parameterHeaderEnd < 0) throw new Error('BYV parameter header is incomplete.');
      const parameterHeader = raw.slice(cursor + OPEN_PARAMETER.length, parameterHeaderEnd);
      const parameterAttrs = parseOrderedAttributes(parameterHeader, ['name', 'type'], 'BYV parameter');
      const name = parameterAttrs.name;
      const type = parameterAttrs.type;
      if (!name.trim()) throw new Error('BYV parameter name must be non-empty.');
      if (!['string', 'number', 'boolean', 'null', 'array', 'object'].includes(type)) {
        throw new Error('Unsupported BYV parameter type: ' + type);
      }
      if (Object.prototype.hasOwnProperty.call(input, name)) {
        throw new Error('Duplicate BYV parameter: ' + name);
      }
      const valueStart = parameterHeaderEnd + 1;
      const parameterClose = findUnescaped(masked, CLOSE_PARAMETER, valueStart);
      if (parameterClose < 0) throw new Error('BYV parameter ' + name + ' is not closed.');
      const rawValue = raw.slice(valueStart, parameterClose);
      input[name] = decodeParameter(rawValue, type, name);
      cursor = parameterClose + CLOSE_PARAMETER.length;
    }

    if (!invokeClosed) throw new Error('BYV invoke ' + attrs.id + ' is not closed.');
    calls.push({ id: attrs.id, name: attrs.name, input: Object.fromEntries(Object.entries(input)) });
  }

  if (!calls.length) throw new Error('BYV calls block contains no invoke.');
  const ids = new Set();
  for (const call of calls) {
    if (ids.has(call.id)) throw new Error('Duplicate BYV invocation id: ' + call.id);
    ids.add(call.id);
  }
  return calls;
}


function findOuterCallsClose(source, fromIndex, maskedSource = maskMarkdownCode(source)) {
  let cursor = fromIndex;
  while (cursor < source.length) {
    if (maskedSource.startsWith(OPEN_PARAMETER, cursor)) {
      const headerEnd = maskedSource.indexOf('>', cursor);
      if (headerEnd < 0) return -1;
      const parameterClose = findUnescaped(maskedSource, CLOSE_PARAMETER, headerEnd + 1);
      if (parameterClose < 0) return -1;
      cursor = parameterClose + CLOSE_PARAMETER.length;
      continue;
    }
    if (maskedSource.startsWith(CLOSE_CALLS, cursor)) return cursor;
    cursor++;
  }
  return -1;
}

function parseBYVOutput(text) {
  const source = String(text || '');
  const maskedSource = maskMarkdownCode(source);
  const openCount = maskedSource.split(OPEN_CALLS).length - 1;
  if (openCount > 1) {
    return { text: source, calls: [], errors: ['Only one outer BYV calls block is allowed.'], hasProtocol: true };
  }

  const start = maskedSource.indexOf(OPEN_CALLS);
  const anyBYV = /<\s*\/?\s*\|\s*BYV\s*\|/i.test(maskedSource);
  if (start < 0) {
    return {
      text: source.trim(),
      calls: [],
      errors: anyBYV ? ['BYV markup was present without a complete calls block.'] : [],
      hasProtocol: anyBYV
    };
  }

  const end = findOuterCallsClose(source, start + OPEN_CALLS.length, maskedSource);
  if (end < 0) {
    return { text: source.slice(0, start).trim(), calls: [], errors: ['BYV calls block is incomplete.'], hasProtocol: true };
  }
  const after = source.slice(end + CLOSE_CALLS.length);
  const maskedAfter = maskedSource.slice(end + CLOSE_CALLS.length);
  if (maskedAfter.includes(OPEN_CALLS) || maskedAfter.includes(CLOSE_CALLS)) {
    return { text: source.slice(0, start).trim(), calls: [], errors: ['Unexpected additional BYV calls wrapper.'], hasProtocol: true };
  }

  try {
    const calls = parseInvocationBlock(source.slice(start + OPEN_CALLS.length, end));
    return {
      text: (source.slice(0, start) + after).trim(),
      calls,
      errors: [],
      hasProtocol: true
    };
  } catch (error) {
    return {
      text: (source.slice(0, start) + after).trim(),
      calls: [],
      errors: [error.message || String(error)],
      hasProtocol: true
    };
  }
}

class BYVStreamParser {
  constructor(options = {}) {
    this.maxChars = options.maxChars || 2 * 1024 * 1024;
    this.chunks = [];
    this.length = 0;
    this.finished = false;
    this.result = null;
  }

  feed(chunk) {
    if (this.finished) throw new Error('Cannot feed a finished BYV parser.');
    const value = String(chunk || '');
    this.length += value.length;
    if (this.length > this.maxChars) throw new Error('BYV output exceeded the configured maximum size.');
    this.chunks.push(value);
  }

  finish() {
    if (this.finished) return this.result;
    this.finished = true;
    this.result = parseBYVOutput(this.chunks.join(''));
    this.chunks = [];
    return this.result;
  }
}

module.exports = {
  OPEN_CALLS,
  CLOSE_CALLS,
  decodeBYVString,
  parseInvocationBlock,
  parseBYVOutput,
  BYVStreamParser
};