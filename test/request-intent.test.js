'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isClaudeCodeCompactionRequest, isWordAddinThinkingHighlightRequest } = require('../src/request-intent');

test('recognizes Claude Code compaction output contract despite a declared tool catalog', () => {
  const body = {
    tools: [{ name: 'Read', input_schema: { type: 'object' } }],
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.' },
        { type: 'text', text: 'Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.' },
        { type: 'text', text: 'Respond with plain text only — an <analysis> block followed by a <summary> block.' },
        { type: 'text', text: 'Summarize the conversation.' }
      ]
    }]
  };
  assert.equal(isClaudeCodeCompactionRequest(body), true);
});

test('does not classify a normal summary request or generic no-tool request as compaction', () => {
  assert.equal(isClaudeCodeCompactionRequest({
    messages: [{ role: 'user', content: 'Summarize README.md.' }]
  }), false);
  assert.equal(isClaudeCodeCompactionRequest({
    messages: [{ role: 'user', content: 'Do not call any tools. Reply with a short status.' }]
  }), false);
});

test('recognizes only the Word Add-in auxiliary thinking-highlight session', () => {
  const body = {
    metadata: {
      user_id: JSON.stringify({
        user: 'word-add-in/unknown',
        session_id: 'aux:thinking-highlight:device-id:2026-11-09'
      })
    }
  };
  assert.equal(isWordAddinThinkingHighlightRequest(body), true);
  assert.equal(isWordAddinThinkingHighlightRequest({
    metadata: { user_id: { session_id: 'aux:thinking-highlight:device-id' } }
  }), true);
  assert.equal(isWordAddinThinkingHighlightRequest({
    metadata: { user_id: JSON.stringify({ session_id: 'normal-session' }) }
  }), false);
  assert.equal(isWordAddinThinkingHighlightRequest({
    metadata: { user_id: 'word-add-in/unknown' }
  }), false);
});
