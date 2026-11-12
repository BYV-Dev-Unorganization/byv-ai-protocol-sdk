'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function createChatStore(options = {}) {
  const Database = require('better-sqlite3');
  const rootDir = path.resolve(options.rootDir || path.join(__dirname, '..'));
  const dataDir = path.join(rootDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dataDir, 0o700); } catch {}
  const filename = path.join(dataDir, 'chat-sessions.sqlite');
  const db = new Database(filename);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(
    'CREATE TABLE IF NOT EXISTS chat_sessions (' +
    'id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT \'New conversation\', ' +
    'model TEXT NOT NULL, effort TEXT, summary TEXT NOT NULL DEFAULT \'\', ' +
    'compacted_through_message_id INTEGER NOT NULL DEFAULT 0, ' +
    'created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)' +
    '; CREATE TABLE IF NOT EXISTS chat_messages (' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, ' +
    'role TEXT NOT NULL CHECK(role IN (\'user\',\'assistant\')), content TEXT NOT NULL, ' +
    'model TEXT, input_tokens INTEGER, output_tokens INTEGER, created_at INTEGER NOT NULL, ' +
    'FOREIGN KEY(session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE)' +
    '; CREATE INDEX IF NOT EXISTS idx_chat_messages_session_id ON chat_messages(session_id, id);' +
    '; CREATE INDEX IF NOT EXISTS idx_chat_sessions_updated_at ON chat_sessions(updated_at DESC);'
  );
  try { fs.chmodSync(filename, 0o600); } catch {}

  const selectSession = db.prepare(
    'SELECT id, title, model, effort, summary, compacted_through_message_id, created_at, updated_at ' +
    'FROM chat_sessions WHERE id = ?'
  );
  const selectMessages = db.prepare(
    'SELECT id, role, content, model, input_tokens, output_tokens, created_at ' +
    'FROM chat_messages WHERE session_id = ? ORDER BY id ASC'
  );
  const selectMessage = db.prepare(
    'SELECT id, role, content, model, input_tokens, output_tokens, created_at ' +
    'FROM chat_messages WHERE id = ?'
  );
  const list = db.prepare(
    'SELECT s.id, s.title, s.model, s.effort, s.created_at, s.updated_at, ' +
    '(SELECT content FROM chat_messages m WHERE m.session_id=s.id ORDER BY m.id DESC LIMIT 1) AS preview ' +
    'FROM chat_sessions s ORDER BY s.updated_at DESC LIMIT 100'
  );
  const insertSession = db.prepare(
    'INSERT INTO chat_sessions(id,title,model,effort,created_at,updated_at) VALUES(?,?,?,?,?,?)'
  );
  const insertMessage = db.prepare(
    'INSERT INTO chat_messages(session_id,role,content,model,input_tokens,output_tokens,created_at) ' +
    'VALUES(?,?,?,?,?,?,?)'
  );
  const touchSession = db.prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?');
  const updateSummary = db.prepare(
    'UPDATE chat_sessions SET summary = ?, compacted_through_message_id = ?, updated_at = ? WHERE id = ?'
  );

  function createSession(input = {}) {
    const id = 'sess_' + crypto.randomBytes(16).toString('hex');
    const now = Date.now();
    const model = typeof input.model === 'string' && input.model.trim()
      ? input.model.trim().slice(0, 256) : 'byv-flash-v1';
    const effort = ['low', 'medium', 'high', 'xhigh', 'max'].includes(input.effort)
      ? input.effort : null;
    insertSession.run(id, 'New conversation', model, effort, now, now);
    return getSession(id);
  }

  function getSession(id) {
    const session = selectSession.get(id);
    if (!session) return null;
    return { ...session, messages: selectMessages.all(id) };
  }

  function addMessage(id, input = {}) {
    const session = selectSession.get(id);
    if (!session) return null;
    const role = input.role;
    const content = typeof input.content === 'string' ? input.content : '';
    if (!['user', 'assistant'].includes(role)) throw new Error('Message role must be user or assistant.');
    if (!content.trim() || content.length > 200000) throw new Error('Message content must contain 1 to 200000 characters.');
    const now = Date.now();
    const model = typeof input.model === 'string' ? input.model.slice(0, 256) : session.model;
    const inputTokens = Number.isSafeInteger(input.input_tokens) && input.input_tokens >= 0 ? input.input_tokens : null;
    const outputTokens = Number.isSafeInteger(input.output_tokens) && input.output_tokens >= 0 ? input.output_tokens : null;
    const result = insertMessage.run(id, role, content, model, inputTokens, outputTokens, now);
    if (role === 'user' && session.title === 'New conversation') {
      const title = content.replace(/\s+/g, ' ').trim().slice(0, 64) || 'New conversation';
      db.prepare('UPDATE chat_sessions SET title = ?, updated_at = ? WHERE id = ?').run(title, now, id);
    } else {
      touchSession.run(now, id);
    }
    return selectMessage.get(result.lastInsertRowid);
  }

  function saveSummary(id, summary, throughMessageId) {
    const session = selectSession.get(id);
    if (!session) return null;
    if (typeof summary !== 'string' || !summary.trim() || summary.length > 100000) {
      throw new Error('Summary must contain 1 to 100000 characters.');
    }
    const maxMessage = db.prepare(
      'SELECT COALESCE(MAX(id),0) AS id FROM chat_messages WHERE session_id = ?'
    ).get(id).id;
    const through = Number.isSafeInteger(throughMessageId) && throughMessageId >= 0
      ? Math.min(throughMessageId, maxMessage) : 0;
    updateSummary.run(summary.trim(), through, Date.now(), id);
    return getSession(id);
  }

  function updateSession(id, input = {}) {
    const session = selectSession.get(id);
    if (!session) return null;
    const model = typeof input.model === 'string' && input.model.trim()
      ? input.model.trim().slice(0, 256) : session.model;
    const effort = input.effort === null ? null
      : ['low', 'medium', 'high', 'xhigh', 'max'].includes(input.effort) ? input.effort : session.effort;
    db.prepare('UPDATE chat_sessions SET model = ?, effort = ?, updated_at = ? WHERE id = ?')
      .run(model, effort, Date.now(), id);
    return getSession(id);
  }

  function deleteSession(id) {
    return db.prepare('DELETE FROM chat_sessions WHERE id = ?').run(id).changes > 0;
  }

  return {
    listSessions: () => list.all(),
    createSession,
    getSession,
    addMessage,
    saveSummary,
    updateSession,
    deleteSession,
    close: () => db.close(),
    filename
  };
}

module.exports = { createChatStore };
