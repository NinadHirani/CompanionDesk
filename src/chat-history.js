'use strict';

// Conversation history for the ask flow: local-only persistence for the
// questions and answers the user chose to keep in a conversation. Dual-mode:
// require() in Electron/Node, plain <script> in the web/mobile build
// (window.CompanionChatHistory). Nothing here ever leaves the device and
// nothing here is sent to the cloud: the ask flow only pastes the most
// recent turns into the LOCAL model call, and the cloud fallback never
// receives them. Only prompt/answer text is stored; never screenshots,
// raw audio, or credentials. Empty or non-string content is refused
// (bad_request), so history never holds blank turns, and the context cap
// is a ceiling: a caller may only lower it, never raise it, so a bad
// maxTurns can never widen what the local model receives.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CompanionChatHistory = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const MAX_TITLE_CHARS = 80;
  const MAX_MESSAGE_CHARS = 20000;
  const MAX_CONTEXT_TURNS = 10; // turns pasted into the local model call

  const ROLES = ['user', 'assistant'];

  function truncate(text) {
    const s = String(text == null ? '' : text);
    return s.length <= MAX_MESSAGE_CHARS ? s : s.slice(0, MAX_MESSAGE_CHARS) + ' [truncated]';
  }

  function cleanTitle(title) {
    return String(title == null ? '' : title).replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_CHARS);
  }

  function createConversation(db, { title = '', now } = {}) {
    const t = cleanTitle(title);
    const at = String(now || '');
    if (!at) return { ok: false, error: 'bad_request' };
    db.run('INSERT INTO conversations (title, created_at, updated_at) VALUES (?, ?, ?)', [t, at, at]);
    return { ok: true, conversation: { id: db.lastId(), title: t, created_at: at, updated_at: at } };
  }

  function listConversations(db) {
    const rows = db.all(
      `SELECT c.id, c.title, c.created_at, c.updated_at,
              (SELECT COUNT(*) FROM chat_messages m WHERE m.conversation_id = c.id) AS message_count
       FROM conversations c
       ORDER BY c.updated_at DESC, c.id DESC`
    );
    return { ok: true, conversations: rows };
  }

  function getConversation(db, id) {
    if (!Number.isInteger(id)) return null;
    const rows = db.all('SELECT id, title, created_at, updated_at FROM conversations WHERE id = ?', [id]);
    return rows.length ? rows[0] : null;
  }

  // Oldest first, so the renderer and the model see the conversation in the
  // order it happened. A missing conversation is a not_found, not an empty
  // list, so callers can tell the two apart.
  function getMessages(db, id) {
    const conv = getConversation(db, id);
    if (!conv) return { ok: false, error: 'not_found' };
    const messages = db.all(
      'SELECT id, role, content, created_at FROM chat_messages WHERE conversation_id = ? ORDER BY id ASC',
      [id]
    );
    return { ok: true, title: conv.title, updated_at: conv.updated_at, messages };
  }

  function addMessage(db, id, role, content, now) {
    const conv = getConversation(db, id);
    if (!conv) return { ok: false, error: 'not_found' };
    if (!ROLES.includes(role) || !String(now || '')) return { ok: false, error: 'bad_request' };
    if (typeof content !== 'string' || content.trim().length === 0) return { ok: false, error: 'bad_request' };
    const text = truncate(content);
    db.run('INSERT INTO chat_messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)', [id, role, text, now]);
    // First user message names the conversation when it has no title yet.
    let title = conv.title;
    if (!title && role === 'user') {
      title = cleanTitle(text.split('\n')[0]).slice(0, 60);
      if (title) db.run('UPDATE conversations SET title = ? WHERE id = ?', [title, id]);
    }
    db.run('UPDATE conversations SET updated_at = ? WHERE id = ?', [now, id]);
    return { ok: true, id: db.lastId(), title };
  }

  function renameConversation(db, id, title) {
    const conv = getConversation(db, id);
    if (!conv) return { ok: false, error: 'not_found' };
    const t = cleanTitle(title);
    if (!t) return { ok: false, error: 'invalid_title' };
    db.run('UPDATE conversations SET title = ? WHERE id = ?', [t, id]);
    return { ok: true, id, title: t };
  }

  function deleteConversation(db, id) {
    if (!Number.isInteger(id)) return { ok: false, error: 'bad_request' };
    db.run('DELETE FROM chat_messages WHERE conversation_id = ?', [id]);
    db.run('DELETE FROM conversations WHERE id = ?', [id]);
    return { ok: true, deleted: true };
  }

  // The most recent turns, in order, shaped for the model. Local model only.
  // maxTurns is a ceiling the caller may only lower: any value that is not a
  // positive integer (including 0 and NaN, which slice(-0) and slice(NaN)
  // would both silently turn into "everything") falls back to the default
  // cap, and a larger value is clamped to it.
  function contextTurns(messages, maxTurns = MAX_CONTEXT_TURNS) {
    const cap = Number.isInteger(maxTurns) && maxTurns > 0
      ? Math.min(maxTurns, MAX_CONTEXT_TURNS)
      : MAX_CONTEXT_TURNS;
    return (messages || [])
      .slice(-cap)
      .filter((m) => ROLES.includes(m.role) && typeof m.content === 'string' && m.content.trim())
      .map((m) => ({ role: m.role, content: m.content }));
  }

  return {
    MAX_TITLE_CHARS, MAX_MESSAGE_CHARS, MAX_CONTEXT_TURNS,
    createConversation, listConversations, getMessages, addMessage,
    renameConversation, deleteConversation, contextTurns,
  };
});
