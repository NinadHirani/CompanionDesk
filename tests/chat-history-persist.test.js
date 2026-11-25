'use strict';

// Chat history is written on every ask, but until now nothing told the store
// to flush: the debounced persist only ran when some other write (a settings
// save) happened to follow, so a fresh ask survived in memory and was lost on
// the next launch. Observed live on the web build: the thread was in the
// picker before a reload and gone after it. These tests prove the writes now
// reach disk through the real dual-mode store.

const test = require('node:test');
const assert = require('node:assert');
const CompanionDb = require('../src/db.js');
const Chat = require('../src/chat-history.js');

// PERSIST_DELAY_MS is 100 in the store; wait comfortably past it.
const FLUSH_WAIT_MS = 350;

test('a thread and its messages survive a reopen', async () => {
  let stored = null;
  const mem = { async load() { return stored; }, async save(b) { stored = b; } };
  const db1 = await CompanionDb.open({ storage: mem });
  const conv = Chat.createConversation(db1, { now: '2026-11-25T10:00:00Z' });
  assert.ok(conv.ok, 'conversation created');
  Chat.addMessage(db1, conv.conversation.id, 'user', 'What should I do on Thursday?', '2026-11-25T10:00:01Z');
  Chat.addMessage(db1, conv.conversation.id, 'assistant', 'Stubbed answer for the persistence pass.', '2026-11-25T10:00:02Z');
  await new Promise((r) => setTimeout(r, FLUSH_WAIT_MS));
  assert.ok(stored && stored.length > 0, 'the debounced flush wrote bytes');

  const db2 = await CompanionDb.open({ storage: mem });
  const list = Chat.listConversations(db2);
  assert.ok(list.ok);
  assert.equal(list.conversations.length, 1, 'the thread is on disk');
  assert.equal(list.conversations[0].title, 'What should I do on Thursday?', 'the first user message still titles the thread');
  const msgs = Chat.getMessages(db2, conv.conversation.id);
  assert.ok(msgs.ok);
  assert.equal(msgs.messages.length, 2);
  assert.equal(msgs.messages[0].role, 'user');
  assert.equal(msgs.messages[1].role, 'assistant');
});

test('a rename and a delete survive a reopen too', async () => {
  let stored = null;
  const mem = { async load() { return stored; }, async save(b) { stored = b; } };
  const db1 = await CompanionDb.open({ storage: mem });
  const conv = Chat.createConversation(db1, { title: 'First title', now: '2026-11-25T10:00:00Z' });
  const id = conv.conversation.id;
  Chat.addMessage(db1, id, 'user', 'Hello there', '2026-11-25T10:00:01Z');
  const renamed = Chat.renameConversation(db1, id, 'Renamed thread');
  assert.ok(renamed.ok);
  await new Promise((r) => setTimeout(r, FLUSH_WAIT_MS));
  const db2 = await CompanionDb.open({ storage: mem });
  const afterRename = Chat.getMessages(db2, id);
  assert.ok(afterRename.ok, 'renamed thread is on disk');
  assert.equal(afterRename.title, 'Renamed thread');
  assert.equal(afterRename.messages.length, 1);

  const del = Chat.deleteConversation(db2, id);
  assert.ok(del.ok);
  await new Promise((r) => setTimeout(r, FLUSH_WAIT_MS));
  const db3 = await CompanionDb.open({ storage: mem });
  assert.equal(Chat.listConversations(db3).conversations.length, 0, 'the delete is on disk');
});
