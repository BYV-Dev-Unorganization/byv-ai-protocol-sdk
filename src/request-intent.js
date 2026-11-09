'use strict';
function latestMessageText(body) {
  const messages = body && Array.isArray(body.messages) ? body.messages : [];
  const last = messages[messages.length - 1];
  if (!last) return '';
  if (typeof last.content === 'string') return last.content;
  if (!Array.isArray(last.content)) return '';
  return last.content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}
function isClaudeCodeCompactionRequest(body) {
  const text = latestMessageText(body);
  if (!text) return false;
  const forbidsTools = /do\s+not\s+call\s+any\s+tools/i.test(text) ||
    /do\s+not\s+use[\s\S]{0,160}any\s+other\s+tool/i.test(text);
  const requiresPlainText = /respond\s+with\s+plain\s+text\s+only/i.test(text) ||
    /output\s+only\s+plain\s+text/i.test(text);
  const requestsSummary = /<\s*analysis\s*>/i.test(text) &&
    /<\s*summary\s*>/i.test(text) &&
    /summar(?:y|ies|ize|ise|ization|isation)|conversation/i.test(text);
  return forbidsTools && requiresPlainText && requestsSummary;
}
function metadataSessionId(body) {
  const userId = body && body.metadata && body.metadata.user_id;
  if (userId && typeof userId === 'object' && !Array.isArray(userId)) {
    return typeof userId.session_id === 'string' ? userId.session_id : '';
  }
  if (typeof userId !== 'string') return '';
  try {
    const metadata = JSON.parse(userId);
    return metadata && typeof metadata.session_id === 'string' ? metadata.session_id : '';
  } catch {
    return '';
  }
}

function isWordAddinThinkingHighlightRequest(body) {
  const sessionId = metadataSessionId(body);
  return /^aux:thinking-highlight(?::|$)/.test(sessionId);
}

module.exports = {
  latestMessageText,
  isClaudeCodeCompactionRequest,
  isWordAddinThinkingHighlightRequest
};
