'use strict';
const BACKTICK = String.fromCharCode(96);
function isEscaped(source, index) {
  let count = 0;
  for (let i = index - 1; i >= 0 && source[i] === '\\'; i--) count++;
  return count % 2 === 1;
}
function findMarkdownCodeRanges(value) {
  const source = String(value || '');
  const ranges = [];
  let lineStart = 0;
  while (lineStart < source.length) {
    const lineEnd = source.indexOf('\n', lineStart);
    const end = lineEnd < 0 ? source.length : lineEnd;
    const line = source.slice(lineStart, end).replace(/\r$/, '');
    const opening = new RegExp('^ {0,3}(' + BACKTICK + '{3,})').exec(line) || /^ {0,3}(~{3,})/.exec(line);
    if (!opening) {
      lineStart = lineEnd < 0 ? source.length : lineEnd + 1;
      continue;
    }
    const marker = opening[1];
    const closing = new RegExp('^ {0,3}' + marker[0] + '{' + marker.length + ',}\\s*$');
    let scan = lineEnd < 0 ? source.length : lineEnd + 1;
    let rangeEnd = source.length;
    while (scan < source.length) {
      const nextEnd = source.indexOf('\n', scan);
      const nextLineEnd = nextEnd < 0 ? source.length : nextEnd;
      const nextLine = source.slice(scan, nextLineEnd).replace(/\r$/, '');
      if (closing.test(nextLine)) {
        rangeEnd = nextEnd < 0 ? source.length : nextEnd + 1;
        break;
      }
      scan = nextEnd < 0 ? source.length : nextEnd + 1;
    }
    ranges.push([lineStart, rangeEnd]);
    lineStart = rangeEnd;
  }
  let cursor = 0;
  while (cursor < source.length) {
    const fenced = ranges.find((range) => cursor >= range[0] && cursor < range[1]);
    if (fenced) {
      cursor = fenced[1];
      continue;
    }
    if (source[cursor] !== BACKTICK || isEscaped(source, cursor)) {
      cursor++;
      continue;
    }
    let runEnd = cursor + 1;
    while (source[runEnd] === BACKTICK) runEnd++;
    const runLength = runEnd - cursor;
    let search = runEnd;
    let closingEnd = -1;
    while (search < source.length) {
      const found = source.indexOf(BACKTICK, search);
      if (found < 0) break;
      const inFence = ranges.find((range) => found >= range[0] && found < range[1]);
      if (inFence) {
        search = inFence[1];
        continue;
      }
      if (isEscaped(source, found)) {
        search = found + 1;
        continue;
      }
      let candidateEnd = found + 1;
      while (source[candidateEnd] === BACKTICK) candidateEnd++;
      if (candidateEnd - found === runLength) {
        closingEnd = candidateEnd;
        ranges.push([cursor, closingEnd]);
        break;
      }
      search = candidateEnd;
    }
    cursor = closingEnd >= 0 ? closingEnd : runEnd;
  }
  ranges.sort((a, b) => a[0] - b[0]);
  return ranges;
}
function isInMarkdownCode(ranges, index) {
  for (const [start, end] of ranges || []) {
    if (index < start) return false;
    if (index < end) return true;
  }
  return false;
}
function maskMarkdownCode(value, ranges) {
  const source = String(value || '');
  const codeRanges = ranges || findMarkdownCodeRanges(source);
  if (!codeRanges.length) return source;
  const output = source.split('');
  for (const [start, end] of codeRanges) {
    for (let i = start; i < end; i++) {
      if (output[i] !== '\n' && output[i] !== '\r') output[i] = ' ';
    }
  }
  return output.join('');
}
module.exports = { findMarkdownCodeRanges, isInMarkdownCode, maskMarkdownCode };
