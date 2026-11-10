'use strict';

const { maskMarkdownCode } = require('./markdown-code');

const PROTOCOL_MARKER = /<\s*(?:[|｜]{1,2}\s*(?:DSML|BYV)\s*[|｜]{1,2}|\/?\s*TOOL_CALL\b)|\{\s*["'](?:tool_calls|function_call)["']\s*:/i;
const PARTIAL_PROTOCOL_MARKER = /<\s*(?:[|｜]{1,2}\s*(?:DSML|BYV)(?:\s*[|｜]{0,2})?|\/?\s*TOOL_CALL\b)/i;
const POSSIBLE_MARKERS = [
  '<|dsml|',
  '<|byv|',
  '<tool_call',
  '</tool_call',
  '{"tool_calls"',
  '{"function_call"'
];

function normalizeCandidate(value) {
  return String(value || '').toLowerCase().replace(/[|｜]/g, '|').replace(/\s+/g, '');
}

class DsmlStreamGuard {
  constructor() {
    this.source = '';
    this.cursor = 0;
    this.protocolDetected = false;
    this.finished = false;
  }

  push(value) {
    if (this.finished) throw new Error('DSML stream guard is already finished.');
    if (typeof value !== 'string' || value.length === 0 || this.protocolDetected) return [];
    this.source += value;

    const searchable = maskMarkdownCode(this.source);
    const completeMarker = PROTOCOL_MARKER.exec(searchable);
    const partialMarker = PARTIAL_PROTOCOL_MARKER.exec(searchable);
    const marker = !completeMarker ? partialMarker
      : !partialMarker ? completeMarker
        : completeMarker.index <= partialMarker.index ? completeMarker : partialMarker;
    if (marker && marker.index >= this.cursor) {
      const safe = this.source.slice(this.cursor, marker.index);
      this.cursor = marker.index;
      this.protocolDetected = true;
      return safe ? [safe] : [];
    }

    let possibleStart = -1;
    for (let index = this.cursor; index < searchable.length; index++) {
      if (searchable[index] !== '<' && searchable[index] !== '{') continue;
      const candidate = normalizeCandidate(searchable.slice(index));
      if (POSSIBLE_MARKERS.some((prefix) => prefix.startsWith(candidate) && candidate.length > 0)) {
        possibleStart = index;
        break;
      }
    }

    const safeEnd = possibleStart >= 0 ? possibleStart : searchable.length;
    if (safeEnd <= this.cursor) return [];
    const safe = this.source.slice(this.cursor, safeEnd);
    this.cursor = safeEnd;
    return safe ? [safe] : [];
  }

  containsProtocol(value) {
    return PROTOCOL_MARKER.test(maskMarkdownCode(String(value || '')));
  }

  finish() {
    if (this.finished) return [];
    this.finished = true;
    if (this.protocolDetected) return [];

    const searchable = maskMarkdownCode(this.source);
    const remaining = searchable.slice(this.cursor);
    const partial = PARTIAL_PROTOCOL_MARKER.exec(remaining);
    const normalized = normalizeCandidate(remaining);
    const possiblePartial = POSSIBLE_MARKERS.some((prefix) =>
      prefix.startsWith(normalized) && normalized.length > 0
    );
    if (partial || possiblePartial) {
      const index = partial ? partial.index : 0;
      const safe = this.source.slice(this.cursor, this.cursor + index);
      this.cursor = this.source.length;
      this.protocolDetected = true;
      return safe ? [safe] : [];
    }

    const tail = this.source.slice(this.cursor);
    this.cursor = this.source.length;
    return tail ? [tail] : [];
  }
}

module.exports = { DsmlStreamGuard };
