'use strict';

const DSML_TAG_SOURCE = '<\\s*(\\/?)\\s*[｜|]{1,2}\\s*DSML\\s*[｜|]{1,2}\\s*(calls|tool_calls|invoke|parameter)\\b([^>]*)>';

function createTagRegex() {
  return new RegExp(DSML_TAG_SOURCE, 'gi');
}

function parseAttributes(raw) {
  const attributes = Object.create(null);
  const pattern = /([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match;
  let cursor = 0;

  while ((match = pattern.exec(raw)) !== null) {
    if (raw.slice(cursor, match.index).trim()) {
      throw new Error('DSML attributes contain invalid syntax.');
    }
    const name = match[1].toLowerCase();
    if (Object.prototype.hasOwnProperty.call(attributes, name)) {
      throw new Error('DSML attribute is duplicated: ' + name);
    }
    attributes[name] = match[2] !== undefined ? match[2] : match[3];
    cursor = pattern.lastIndex;
  }

  if (raw.slice(cursor).trim()) {
    throw new Error('DSML attributes contain invalid trailing syntax.');
  }
  return attributes;
}

function safeAttribute(value, pattern) {
  const text = typeof value === 'string' ? value.trim() : '';
  return pattern.test(text) ? text : '';
}

function escapeBYVString(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(/<\\/\\|BYV\\|\\s*parameter>/g, (match) => '\\' + match);
}

function escapeBYVJson(value) {
  return JSON.stringify(value).replace(
    /<\\/\\|BYV\\|\\s*parameter>/g,
    (match) => '\\u003c' + match.slice(1)
  );
}

function findClosingParameter(source, fromIndex) {
  const pattern = createTagRegex();
  pattern.lastIndex = fromIndex;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    if (match[1] === '/' && match[2].toLowerCase() === 'parameter') {
      return match;
    }
  }
  return null;
}

function convertParameter(attributesText, rawValue) {
  let attributes;
  try {
    attributes = parseAttributes(attributesText);
  } catch {
    attributes = Object.create(null);
  }

  const name = safeAttribute(attributes.name, /^[A-Za-z_][A-Za-z0-9_-]*$/);
  const stringFlag = String(attributes.string || '').toLowerCase();
  let type = 'invalid';
  let value = rawValue;

  if (stringFlag === 'true') {
    type = 'string';
    value = escapeBYVString(rawValue);
  } else if (stringFlag === 'false') {
    try {
      const parsed = JSON.parse(rawValue.trim());
      if (parsed === null) type = 'null';
      else if (Array.isArray(parsed)) type = 'array';
      else if (typeof parsed === 'object') type = 'object';
      else if (typeof parsed === 'boolean') type = 'boolean';
      else if (typeof parsed === 'number' && Number.isFinite(parsed)) type = 'number';
      else if (typeof parsed === 'string') {
        type = 'string';
        value = escapeBYVString(parsed);
      }
      if (type !== 'string' && type !== 'invalid') value = escapeBYVJson(parsed);
    } catch {
      type = 'invalid';
    }
  }

  return '<|BYV| parameter name="' + name + '" type="' + type + '">' +
    value + '</|BYV| parameter>';
}

/**
 * Convert model-facing DeepSeek DSML text into the gateway's internal BYV
 * Format Block representation. The BYV parser remains the single parser and
 * validator for the converted result.
 */
function convertDsmlToBYV(input) {
  const source = String(input || '');
  const pattern = createTagRegex();
  let output = '';
  let cursor = 0;
  let match;
  let detected = false;
  let invocationIndex = 0;

  while ((match = pattern.exec(source)) !== null) {
    detected = true;
    output += source.slice(cursor, match.index);

    const closing = match[1] === '/';
    const tag = match[2].toLowerCase();

    if (tag === 'calls' || tag === 'tool_calls') {
      output += closing ? '</|BYV| calls>' : '<|BYV| calls>';
      cursor = pattern.lastIndex;
      continue;
    }

    if (tag === 'invoke') {
      if (closing) {
        output += '</|BYV| invoke>';
      } else {
        let attributes;
        try {
          attributes = parseAttributes(match[3]);
        } catch {
          attributes = Object.create(null);
        }
        const name = safeAttribute(attributes.name, /^[A-Za-z_][A-Za-z0-9_.:/-]*$/);
        invocationIndex++;
        output += '<|BYV| invoke name="' + name + '" id="dsml_call_' +
          String(invocationIndex).padStart(3, '0') + '">';
      }
      cursor = pattern.lastIndex;
      continue;
    }

    if (tag === 'parameter') {
      if (closing) {
        output += '</|BYV| parameter>';
        cursor = pattern.lastIndex;
        continue;
      }

      const valueStart = pattern.lastIndex;
      const close = findClosingParameter(source, valueStart);
      if (!close) {
        let attributes;
        try {
          attributes = parseAttributes(match[3]);
        } catch {
          attributes = Object.create(null);
        }
        const name = safeAttribute(attributes.name, /^[A-Za-z_][A-Za-z0-9_-]*$/);
        output += '<|BYV| parameter name="' + name + '" type="invalid">' +
          source.slice(valueStart);
        cursor = source.length;
        break;
      }

      output += convertParameter(match[3], source.slice(valueStart, close.index));
      cursor = close.index + close[0].length;
      pattern.lastIndex = cursor;
    }
  }

  output += source.slice(cursor);
  return { text: output, detected };
}

module.exports = { convertDsmlToBYV, escapeBYVString, escapeBYVJson };
