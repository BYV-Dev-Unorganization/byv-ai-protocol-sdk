'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createChatStore } = require('../src/chat-store');

test('chat sessions and messages persist with summaries and per-session settings', (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'byv-chat-'));
  const store = createChatStore({ rootDir });
  t.after(() => {
    store.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  const created = store.createSession({ model: 'byv-flash-v1', effort: 'high' });
  assert.match(created.id, /^sess_[a-f0-9]{32}$/);
  assert.equal(created.messages.length, 0);
  assert.equal(created.effort, 'high');

  const user = store.addMessage(created.id, {
    role: 'user',
    content: 'Help me review this implementation.'
  });
  const assistant = store.addMessage(created.id, {
    role: 'assistant',
    content: 'I will inspect the implementation.'
  });
  assert.equal(user.role, 'user');
  assert.equal(assistant.role, 'assistant');
  assert.equal(store.getSession(created.id).title, 'Help me review this implementation.');

  const compacted = store.saveSummary(created.id, 'The user is reviewing an implementation.', user.id);
  assert.equal(compacted.summary, 'The user is reviewing an implementation.');
  assert.equal(compacted.compacted_through_message_id, user.id);

  const updated = store.updateSession(created.id, { model: 'claude-sonnet-5-5', effort: 'medium' });
  assert.equal(updated.model, 'claude-sonnet-5-5');
  assert.equal(updated.effort, 'medium');
  assert.equal(store.listSessions().length, 1);

  const stat = fs.statSync(store.filename);
  assert.equal(stat.mode & 0o777, 0o600);
  assert.equal(store.deleteSession(created.id), true);
  assert.equal(store.getSession(created.id), null);
});
