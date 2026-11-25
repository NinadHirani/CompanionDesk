'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const CH = require('../src/chat-history');
const LocalDb = require('../src/db');
const { createAi } = require('../src/ai');
const P = require('../src/personal');

const NOW = '2026-11-23T10:00:00.000Z';

// ---- persistence, isolation, ordering ---------------------------------------

test('create, list, and re-read a conversation', async () => {
  const db = await LocalDb.open();
  const a = CH.createConversation(db, { now: NOW });
  assert.equal(a.ok, true);
  CH.addMessage(db, a.conversation.id, 'user', 'What is due this week?', NOW);
  CH.addMessage(db, a.conversation.id, 'assistant', 'Two assignments.', NOW);
  const list = CH.listConversations(db);
  assert.equal(list.ok, true);
  assert.equal(list.conversations.length, 1);
  assert.equal(list.conversations[0].title, 'What is due this week?');
  assert.equal(list.conversations[0].message_count, 2);
  const got = CH.getMessages(db, a.conversation.id);
  assert.equal(got.ok, true);
  assert.deepEqual(got.messages.map((m) => m.role), ['user', 'assistant']);
  assert.deepEqual(got.messages.map((m) => m.content), ['What is due this week?', 'Two assignments.']);
});

test('conversations are isolated: messages never cross', async () => {
  const db = await LocalDb.open();
  const a = CH.createConversation(db, { now: NOW }).conversation;
  const b = CH.createConversation(db, { title: 'Other', now: NOW }).conversation;
  CH.addMessage(db, a.id, 'user', 'question for a', NOW);
  CH.addMessage(db, b.id, 'user', 'question for b', NOW);
  const ga = CH.getMessages(db, a.id);
  const gb = CH.getMessages(db, b.id);
  assert.deepEqual(ga.messages.map((m) => m.content), ['question for a']);
  assert.deepEqual(gb.messages.map((m) => m.content), ['question for b']);
  assert.notEqual(ga.messages[0].conversation_id, b.id);
});

test('list orders by most recently updated first', async () => {
  const db = await LocalDb.open();
  const a = CH.createConversation(db, { now: NOW }).conversation;
  const b = CH.createConversation(db, { now: NOW }).conversation;
  assert.deepEqual(CH.listConversations(db).conversations.map((c) => c.id), [b.id, a.id]);
  CH.addMessage(db, a.id, 'user', 'newer activity', '2026-11-23T11:00:00.000Z');
  assert.deepEqual(CH.listConversations(db).conversations.map((c) => c.id), [a.id, b.id]);
});

test('messages come back in insertion order regardless of clock', async () => {
  const db = await LocalDb.open();
  const c = CH.createConversation(db, { now: NOW }).conversation;
  CH.addMessage(db, c.id, 'user', 'first', '2026-11-23T12:00:00.000Z');
  CH.addMessage(db, c.id, 'assistant', 'second', '2026-11-23T11:00:00.000Z');
  assert.deepEqual(CH.getMessages(db, c.id).messages.map((m) => m.content), ['first', 'second']);
});

// ---- empty states, missing records, validation ------------------------------

test('empty states: no conversations and a missing conversation are distinct', async () => {
  const db = await LocalDb.open();
  assert.deepEqual(CH.listConversations(db).conversations, []);
  assert.deepEqual(CH.getMessages(db, 999), { ok: false, error: 'not_found' });
  assert.deepEqual(CH.addMessage(db, 999, 'user', 'x', NOW), { ok: false, error: 'not_found' });
  assert.deepEqual(CH.renameConversation(db, 999, 'x'), { ok: false, error: 'not_found' });
  assert.deepEqual(CH.deleteConversation(db, 999), { ok: true, deleted: true });
});

test('roles, timestamps and titles are validated; over-long content is truncated', async () => {
  const db = await LocalDb.open();
  const c = CH.createConversation(db, { now: NOW }).conversation;
  assert.equal(CH.addMessage(db, c.id, 'system', 'x', NOW).ok, false);
  assert.equal(CH.addMessage(db, c.id, 'user', 'x', '').ok, false);
  const long = 'x'.repeat(CH.MAX_MESSAGE_CHARS + 10);
  const added = CH.addMessage(db, c.id, 'user', long, NOW);
  assert.equal(added.ok, true);
  const stored = CH.getMessages(db, c.id).messages[0].content;
  assert.equal(stored.length, CH.MAX_MESSAGE_CHARS + ' [truncated]'.length);
  assert.equal(stored.endsWith(' [truncated]'), true);
});

test('rename requires a non-empty title and updates the list', async () => {
  const db = await LocalDb.open();
  const c = CH.createConversation(db, { now: NOW }).conversation;
  assert.deepEqual(CH.renameConversation(db, c.id, '   '), { ok: false, error: 'invalid_title' });
  const r = CH.renameConversation(db, c.id, 'Exam prep');
  assert.deepEqual(r, { ok: true, id: c.id, title: 'Exam prep' });
  assert.equal(CH.listConversations(db).conversations[0].title, 'Exam prep');
});

test('delete removes the conversation and its messages', async () => {
  const db = await LocalDb.open();
  const a = CH.createConversation(db, { now: NOW }).conversation;
  const b = CH.createConversation(db, { now: NOW }).conversation;
  CH.addMessage(db, a.id, 'user', 'mine', NOW);
  CH.addMessage(db, b.id, 'user', 'not mine', NOW);
  assert.deepEqual(CH.deleteConversation(db, a.id), { ok: true, deleted: true });
  assert.deepEqual(CH.getMessages(db, a.id), { ok: false, error: 'not_found' });
  assert.equal(CH.listConversations(db).conversations.length, 1);
  assert.equal(CH.getMessages(db, b.id).messages[0].content, 'not mine');
});

// ---- persistence across a reopen (the migration path) ------------------------

test('history survives a reopen', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-chat-'));
  const file = path.join(dir, 'companiondesk.db');
  const first = await LocalDb.open({ file });
  const c = CH.createConversation(first, { now: NOW }).conversation;
  CH.addMessage(first, c.id, 'user', 'persisted question', NOW);
  first.flush();
  const reopened = await LocalDb.open({ file });
  const list = CH.listConversations(reopened);
  assert.equal(list.conversations.length, 1);
  assert.equal(CH.getMessages(reopened, c.id).messages[0].content, 'persisted question');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an old database file without the chat tables gains them on open, keeping its data', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-chat-'));
  const file = path.join(dir, 'companiondesk.db');
  const first = await LocalDb.open({ file });
  first.upsertCourse({ name: 'Quantum Computing', term: 'Fall 2026' });
  first.flush();
  // What an existing user's file looks like to this feature: no chat tables.
  first.run('DROP TABLE chat_messages');
  first.run('DROP TABLE conversations');
  first.flush();
  const reopened = await LocalDb.open({ file });
  assert.equal(CH.listConversations(reopened).ok, true);
  assert.deepEqual(CH.listConversations(reopened).conversations, []);
  assert.equal(reopened.counts().courses, 1);
  const fresh = CH.createConversation(reopened, { now: NOW });
  assert.equal(fresh.ok, true);
  assert.equal(CH.getMessages(reopened, fresh.conversation.id).messages.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- context turns -----------------------------------------------------------

test('contextTurns keeps the most recent turns, user/assistant only, in order', async () => {
  const db = await LocalDb.open();
  const c = CH.createConversation(db, { now: NOW }).conversation;
  for (let i = 0; i < 14; i++) CH.addMessage(db, c.id, i % 2 ? 'assistant' : 'user', `turn ${i}`, NOW);
  const turns = CH.contextTurns(CH.getMessages(db, c.id).messages);
  assert.equal(turns.length, CH.MAX_CONTEXT_TURNS);
  assert.deepEqual(turns[0], { role: 'user', content: 'turn 4' });
  assert.deepEqual(turns[turns.length - 1], { role: 'assistant', content: 'turn 13' });
  assert.deepEqual(CH.contextTurns([]), []);
});

test('contextTurns cap is a ceiling: invalid maxTurns never widens it', async () => {
  const db = await LocalDb.open();
  const c = CH.createConversation(db, { now: NOW }).conversation;
  for (let i = 0; i < 14; i++) CH.addMessage(db, c.id, i % 2 ? 'assistant' : 'user', `turn ${i}`, NOW);
  const msgs = CH.getMessages(db, c.id).messages;
  // slice(-0) and slice(NaN) both mean "everything"; the cap must catch them.
  for (const bad of [0, -3, NaN, undefined === 0 ? 0 : '5', null]) {
    const got = CH.contextTurns(msgs, bad);
    assert.equal(got.length, CH.MAX_CONTEXT_TURNS, `maxTurns=${String(bad)} falls back to the default cap`);
  }
  assert.equal(CH.contextTurns(msgs, 99).length, CH.MAX_CONTEXT_TURNS, 'a larger value is clamped');
  assert.deepEqual(CH.contextTurns(msgs, 2).map((m) => m.content), ['turn 12', 'turn 13'], 'a caller may only lower the cap');
});

test('blank or non-string content is refused, nothing stored', async () => {
  const db = await LocalDb.open();
  const c = CH.createConversation(db, { now: NOW }).conversation;
  for (const bad of ['', '   ', '\n\t', 42, null, {}, ['hi']]) {
    assert.deepEqual(CH.addMessage(db, c.id, 'user', bad, NOW), { ok: false, error: 'bad_request' });
  }
  assert.equal(CH.getMessages(db, c.id).messages.length, 0, 'no blank turn was stored');
  assert.equal(CH.addMessage(db, c.id, 'user', '  real question  ', NOW).ok, true, 'padded real content is kept');
  assert.equal(CH.getMessages(db, c.id).messages[0].content, '  real question  ');
});

// ---- ask-flow integration: history goes local, never to the cloud ------------

function mockFetch(routes) {
  return async (url, opts) => {
    for (const [match, handler] of routes) {
      const hit = typeof match === 'string' ? url.includes(match) : match(url, opts);
      if (hit) return handler(opts || {});
    }
    throw new Error('unrouted: ' + url);
  };
}

const fakeAskDb = () => LocalDb.open();

test('P.ask persists the exchange and sends prior turns to the local model', async () => {
  const db = await fakeAskDb();
  let seen = null;
  const ai = {
    completeRouted: async (args) => { seen = args; return 'the answer'; },
    listModels: async () => null,
    modelCapabilities: async () => null,
    localModel: 'llama3.2:latest',
  };
  const c = CH.createConversation(db, { now: NOW }).conversation;
  CH.addMessage(db, c.id, 'user', 'earlier question', NOW);
  CH.addMessage(db, c.id, 'assistant', 'earlier answer', NOW);

  const out = await P.ask({ db, ai, meFile: '/nonexistent' }, { prompt: 'new question', conversation_id: c.id }, '2026-11-23', { model: 'llama3.2:latest' });
  assert.deepEqual(out, { ok: true, answer: 'the answer', conversation_id: c.id });
  assert.equal(seen.history.length, 2);
  assert.deepEqual(seen.history[0], { role: 'user', content: 'earlier question' });
  assert.deepEqual(seen.history[1], { role: 'assistant', content: 'earlier answer' });
  const msgs = CH.getMessages(db, c.id).messages;
  assert.deepEqual(msgs.map((m) => m.content), ['earlier question', 'earlier answer', 'new question', 'the answer']);
});

test('P.ask without a conversation id keeps the single-shot behavior', async () => {
  const db = await fakeAskDb();
  const ai = { completeRouted: async () => 'ok' };
  const out = await P.ask({ db, ai, meFile: '/nonexistent' }, { prompt: 'hello' }, '2026-11-23');
  assert.deepEqual(out, { ok: true, answer: 'ok' });
  assert.equal(CH.listConversations(db).conversations.length, 0);
});

test('P.ask with a missing conversation id fails cleanly and stores nothing', async () => {
  const db = await fakeAskDb();
  const ai = { completeRouted: async () => 'should not run' };
  const out = await P.ask({ db, ai, meFile: '/nonexistent' }, { prompt: 'hello', conversation_id: 4242 }, '2026-11-23');
  assert.deepEqual(out, { ok: false, error: 'not_found' });
});

test('a failed ask still records the question but no answer', async () => {
  const db = await fakeAskDb();
  const ai = { completeRouted: async () => { throw new Error('ollama_http_404'); } };
  const c = CH.createConversation(db, { now: NOW }).conversation;
  const out = await P.ask({ db, ai, meFile: '/nonexistent' }, { prompt: 'will fail', conversation_id: c.id }, '2026-11-23');
  assert.equal(out.ok, false);
  const msgs = CH.getMessages(db, c.id).messages;
  assert.deepEqual(msgs.map((m) => m.role), ['user']);
  assert.equal(msgs[0].content, 'will fail');
});

test('the routed cloud path strips history and the local model name', async () => {
  let localBody = null;
  let cloudBody = null;
  const ai = createAi({
    geminiKey: 'k',
    cloudEnabled: true,
    registryOverride: require('./fixtures/registry-fixtures').makeTestRegistry(),
    fetchImpl: mockFetch([
      ['/api/tags', () => ({ ok: true, json: async () => ({ models: [{ name: 'llama3.2:latest' }] }) })],
      ['/api/chat', (opts) => { localBody = JSON.parse(opts.body); return { ok: false, status: 500 }; }],
      [(url, opts) => { if (String(url).includes('generativelanguage')) { cloudBody = opts.body; return true; } return false; },
       (opts) => {
         if (String((opts && opts.url) || '').endsWith('/models')) return { ok: true, json: async () => ({ models: [] }) };
         return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'cloud ok' }] } }] }) };
       }],
    ]),
  });
  const out = await ai.completeRouted({
    prompt: 'new question',
    model: 'llama3.2:latest',
    history: [{ role: 'user', content: 'secret earlier question' }],
    task: 'chat', privacyMode: 'standard', cloudEnabled: true, cloudConsent: true,
  });
  assert.equal(out, 'cloud ok');
  assert.equal(localBody.messages.length, 2); // history + current prompt go to the LOCAL model only
  assert.equal(cloudBody.includes('secret earlier question'), false);
  assert.equal(cloudBody.includes('llama3.2'), false);
});

test('the ollama chat body carries history before the current prompt', async () => {
  let body = null;
  const ai = createAi({
    fetchImpl: mockFetch([['/api/chat', (opts) => { body = JSON.parse(opts.body); return { ok: true, text: async () => JSON.stringify({ message: { content: 'ok' } }) + '\n' }; }]]),
  });
  await ai.chat({ prompt: 'current', history: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] });
  assert.deepEqual(body.messages.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.equal(body.messages[body.messages.length - 1].content, 'current');
});
