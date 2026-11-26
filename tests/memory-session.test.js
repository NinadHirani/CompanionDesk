'use strict';

// M4 store-contract wiring slice: tests for src/memory-session.js, the
// session view layer in front of the canonical About-me file. Pins:
// legacy shapes unchanged, file writes stay single-bullet, sync-on-demand
// freshness, session-only sensitive marks with fail-closed persistence.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const memory = require('../src/memory');
const sessionMod = require('../src/memory-session');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-session-'));
  return path.join(dir, '_about-me.md');
}

const SECTIONS = ['Facts', 'Goals', 'Routines', 'Preferences', 'Constraints'];

// Canonical-format seed with explicit sections: TEMPLATE ends at
// Constraints, so test bullets must be placed under their own headings.
function seed(file, sections = {}) {
  let text = '# About me\n\n';
  for (const sec of SECTIONS) {
    text += `## ${sec}\n\n`;
    for (const b of sections[sec] || []) text += `- ${b}\n`;
    text += '\n';
  }
  memory.writeText(file, text);
}

test('list matches the legacy shape exactly: [{section,text}]', () => {
  sessionMod._resetForTests();
  const file = tmpFile();
  seed(file, { Facts: ['First fact'] });
  const s = sessionMod.get(file);
  assert.deepEqual(s.list(), [{ section: 'Facts', text: 'First fact' }]);
  assert.deepEqual(s.list(), memory.listMemories(file));
});

test('add writes ONE bullet line and manual comments survive', () => {
  sessionMod._resetForTests();
  const file = tmpFile();
  seed(file, { Facts: ['hand written fact'] });
  fs.appendFileSync(file, '# my own note\n');
  const s = sessionMod.get(file);
  const r = s.add('Goals', 'Aim for a 9');
  assert.deepEqual(r, { ok: true, text: 'Aim for a 9' });
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes('# my own note'), 'manual comment survives');
  assert.ok(text.includes('- hand written fact'), 'manual bullet survives');
  assert.ok(text.includes('- Aim for a 9'));
  assert.equal(s.count(), 2);
});

test('add errors mirror memory.addMemory: unknown_section, empty, duplicate', () => {
  sessionMod._resetForTests();
  const file = tmpFile();
  seed(file);
  const s = sessionMod.get(file);
  assert.deepEqual(s.add('Nope', 'x'), { ok: false, error: 'unknown_section' });
  assert.deepEqual(s.add('Goals', '   '), { ok: false, error: 'empty' });
  assert.equal(s.add('Goals', 'study nightly').ok, true);
  assert.deepEqual(s.add('Goals', 'Study  NIGHTLY.'), { ok: false, error: 'duplicate' });
});

test('forget removes one line from file and view; unknown -> not_found', () => {
  sessionMod._resetForTests();
  const file = tmpFile();
  seed(file, { Facts: ['keep me', 'drop me'] });
  const s = sessionMod.get(file);
  assert.deepEqual(s.forget('Facts', 'drop me'), { ok: true });
  assert.deepEqual(s.list(), [{ section: 'Facts', text: 'keep me' }]);
  assert.equal(fs.readFileSync(file, 'utf8').includes('drop me'), false);
  assert.deepEqual(s.forget('Facts', 'drop me'), { ok: false, error: 'not_found' });
});

test('sync-on-demand: hand edits to the file show up on the next operation', () => {
  sessionMod._resetForTests();
  const file = tmpFile();
  seed(file);
  const s = sessionMod.get(file);
  assert.deepEqual(s.list(), []);
  // external edit (the user in an editor)
  fs.appendFileSync(file, '## Facts\n\n- appeared by hand\n');
  // force a fresh stat signature
  const before = s.list();
  assert.deepEqual(before, [{ section: 'Facts', text: 'appeared by hand' }]);
  // external deletion
  memory.writeText(file, memory.TEMPLATE);
  assert.deepEqual(s.list(), []);
});

test('marks: hidden from retrieval by default, listed as file content, visible on includeSensitive', () => {
  sessionMod._resetForTests();
  const file = tmpFile();
  seed(file, { Facts: ['my home address is 12 Privet Drive', 'I like tea'] });
  const s = sessionMod.get(file);
  const id = s.items().find((b) => b.text.includes('Privet')).id;
  assert.equal(s.markSensitive(id, true).ok, true);
  assert.equal(s.search('home address', { k: 5 }).some((r) => r.text.includes('Privet')), false);
  assert.equal(s.search('home address', { k: 5, includeSensitive: true }).some((r) => r.text.includes('Privet')), true);
  // still the user's own file content: list keeps it
  assert.ok(s.list().some((m) => m.text.includes('Privet')));
  // the file is untouched by marking
  assert.ok(fs.readFileSync(file, 'utf8').includes('Privet'));
  // unmark restores retrieval
  assert.equal(s.markSensitive(id, false).ok, true);
  assert.equal(s.search('home address', { k: 5 }).some((r) => r.text.includes('Privet')), true);
});

test('a mark survives an external file edit and rebuild (never silently dropped)', () => {
  sessionMod._resetForTests();
  const file = tmpFile();
  seed(file, { Facts: ['secret note'] });
  const s = sessionMod.get(file);
  const id = s.items()[0].id;
  s.markSensitive(id, true);
  fs.appendFileSync(file, '- another fact\n');
  assert.equal(s.search('secret', { k: 5 }).length, 0, 'mark survives rebuild');
  assert.equal(s.items().find((b) => b.text === 'secret note').sensitive, true);
});

test('persistSensitive is fail-closed for marks and a no-op for plain bullets', () => {
  sessionMod._resetForTests();
  const file = tmpFile();
  seed(file, { Facts: ['secret note', 'plain note'] });
  const s = sessionMod.get(file);
  const ids = s.items();
  const secretId = ids[0].id;
  const plainId = ids[1].id;
  s.markSensitive(secretId, true);
  assert.deepEqual(s.persistSensitive(secretId), {
    ok: false,
    error: 'sensitive_storage_blocked',
    detail: 'no on-disk format preserves the sensitive mark yet; the entry stays session-only',
  });
  assert.deepEqual(s.persistSensitive(plainId), { ok: true, persisted: true });
});

test('sensitive add: persisted:false, session view only, never on disk, survives refresh via the sidecar', () => {
  sessionMod._resetForTests();
  const file = tmpFile();
  seed(file);
  const s = sessionMod.get(file);
  const r = s.add('Facts', 'bank pin is 1234', { sensitive: true });
  assert.equal(r.ok, true);
  assert.equal(r.persisted, false);
  assert.ok(s.items().some((b) => b.text === 'bank pin is 1234'));
  assert.equal(fs.readFileSync(file, 'utf8').includes('bank pin'), false, 'never written');
  assert.equal(s.search('bank pin', { k: 5 }).length, 0, 'consent gate hides it');
  // the sidecar holds it for the session: a refresh re-injects it, the
  // file still never sees it (no on-disk format, per the 26 Nov decision)
  fs.appendFileSync(file, '- unrelated\n');
  assert.ok(s.items().some((b) => b.text === 'bank pin is 1234' && b.sensitive === true), 'survives refresh');
  assert.equal(fs.readFileSync(file, 'utf8').includes('bank pin'), false, 'still never written');
});

test('forget of a session-only sensitive entry works and leaves the file untouched', () => {
  sessionMod._resetForTests();
  const file = tmpFile();
  seed(file, { Facts: ['kept fact'] });
  const s = sessionMod.get(file);
  s.add('Facts', 'bank pin is 1234', { sensitive: true });
  const before = fs.readFileSync(file, 'utf8');
  const r = s.forget('Facts', 'bank pin is 1234');
  assert.equal(r.ok, true);
  assert.equal(s.items().some((b) => b.text === 'bank pin is 1234'), false);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'file unchanged');
  assert.ok(s.items().some((b) => b.text === 'kept fact'));
});

test('a manual duplicate write collapses the sidecar entry into the file bullet', () => {
  sessionMod._resetForTests();
  const file = tmpFile();
  seed(file);
  const s = sessionMod.get(file);
  s.add('Facts', 'bank pin is 1234', { sensitive: true });
  const cur = fs.readFileSync(file, 'utf8');
  const res = memory.addBullet(cur, 'Facts', 'bank pin is 1234');
  assert.equal(res.added, true);
  fs.writeFileSync(file, res.text);
  const rows = s.items().filter((b) => b.text === 'bank pin is 1234');
  assert.equal(rows.length, 1, 'no duplicate row');
  assert.equal(rows[0].sensitive, undefined, 'the file bullet stays the user\'s own unmarked line');
});

test('the sidecar is bounded: a full sidecar refuses the add and rolls the view back', () => {
  sessionMod._resetForTests();
  const file = tmpFile();
  seed(file);
  const s = sessionMod.get(file);
  for (let i = 0; i < 50; i++) {
    const r = s.add('Facts', `entry number ${i} stays session-only`, { sensitive: true });
    assert.equal(r.ok, true);
  }
  const r = s.add('Facts', 'one entry too many stays session-only', { sensitive: true });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'sidecar_full');
  assert.equal(s.items().some((b) => b.text === 'one entry too many stays session-only'), false, 'rolled back');
  assert.equal(s.count(), 50);
});

test('the sidecar is bounded for marks too: a full sidecar rolls the mark back', () => {
  sessionMod._resetForTests();
  const file = tmpFile();
  seed(file, { Facts: Array.from({ length: 101 }, (_, i) => `fact ${i}`) });
  const s = sessionMod.get(file);
  const ids = s.items().map((b) => b.id);
  for (let i = 0; i < 100; i++) assert.equal(s.markSensitive(ids[i], true).ok, true);
  const r = s.markSensitive(ids[100], true);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'sidecar_full');
  assert.equal(s.items().find((b) => b.id === ids[100]).sensitive, undefined, 'rolled back');
});

test('ids are stable within a sync epoch and reassigned after a rebuild', () => {
  sessionMod._resetForTests();
  const file = tmpFile();
  seed(file, { Facts: ['one', 'two', 'three'] });
  const s = sessionMod.get(file);
  const ids1 = s.items().map((b) => b.id);
  assert.deepEqual(ids1, ['m1', 'm2', 'm3']);
  const idsAgain = s.items().map((b) => b.id);
  assert.deepEqual(ids1, idsAgain, 'stable within epoch');
  s.forget('Facts', 'two');
  const ids2 = s.items().map((b) => b.id);
  assert.deepEqual(ids2, ['m1', 'm2'], 'reassigned by position after sync');
});

test('sessions are isolated per file path', () => {
  sessionMod._resetForTests();
  const a = tmpFile();
  const b = tmpFile();
  seed(a, { Facts: ['in a'] });
  seed(b, { Facts: ['in b'] });
  const sa = sessionMod.get(a);
  const sb = sessionMod.get(b);
  assert.deepEqual(sa.list(), [{ section: 'Facts', text: 'in a' }]);
  assert.deepEqual(sb.list(), [{ section: 'Facts', text: 'in b' }]);
  sa.add('Goals', 'only a');
  assert.equal(sb.count(), 1);
});

test('the product service layer returns the legacy shapes through the session', () => {
  sessionMod._resetForTests();
  const file = tmpFile();
  seed(file);
  const P = require('../src/personal');
  const c = { meFile: file, db: { listProposals: () => [] } };
  assert.equal(P.addMemory(c, { section: 'Goals', text: 'Aim for a 9' }).ok, true);
  assert.deepEqual(P.listMemory(c).items, [{ section: 'Goals', text: 'Aim for a 9' }]);
  assert.equal(P.forgetMemory(c, { section: 'Goals', text: 'Aim for a 9' }).ok, true);
  assert.deepEqual(P.listMemory(c).items, []);
});

test('a failed file write leaves no phantom in the session view', () => {
  sessionMod._resetForTests();
  const file = tmpFile();
  seed(file, { Facts: ['First fact'] });
  const s = sessionMod.get(file);

  const realWrite = fs.writeFileSync;
  fs.writeFileSync = () => {
    throw Object.assign(new Error('persist_failed_write'), { code: 'EACCES' });
  };
  let threw = false;
  try { s.add('Facts', 'Second fact'); } catch (err) { threw = true; }
  fs.writeFileSync = realWrite;
  assert.equal(threw, true, 'the failed write must surface to the caller');

  // The canonical file never gained the bullet; the session view must agree.
  assert.deepEqual(s.list().map((b) => b.text), ['First fact']);

  // The view is still live: a retry after the environment heals lands once.
  assert.deepEqual(s.add('Facts', 'Second fact'), { ok: true, text: 'Second fact' });
  assert.deepEqual(s.list().map((b) => b.text), ['First fact', 'Second fact']);
});

test('forget of a marked on-disk bullet clears the sidecar mark: a re-add is not silently re-marked', () => {
  sessionMod._resetForTests();
  const file = tmpFile();
  seed(file, { Facts: ['likes filter coffee'] });
  const s = sessionMod.get(file);
  const id = s.items().find((b) => b.text === 'likes filter coffee').id;
  assert.equal(s.markSensitive(id, true).ok, true);
  assert.equal(s.forget('Facts', 'likes filter coffee').ok, true);
  assert.equal(s.add('Facts', 'likes filter coffee').ok, true);
  const again = s.items().find((b) => b.text === 'likes filter coffee');
  assert.ok(again, 're-added bullet exists');
  assert.ok(!again.sensitive, 'the re-added bullet must not inherit the forgotten mark');
  assert.ok(s.search('filter coffee', { k: 5 }).length >= 1,
    'the re-added bullet is retrievable, not hidden by a stale mark');
});

test('unmarking a session-only sensitive entry is refused and stays marked across rebuilds', () => {
  sessionMod._resetForTests();
  const file = tmpFile();
  seed(file, {});
  const s = sessionMod.get(file);
  const r = s.add('Facts', 'private session note', { sensitive: true });
  assert.equal(r.ok, true);
  assert.equal(r.persisted, false);
  const id = s.items().find((b) => b.text === 'private session note').id;
  const u = s.markSensitive(id, false);
  assert.equal(u.ok, false, 'a session-only entry is sensitive by construction');
  assert.equal(u.error, 'session_only_entry');
  fs.utimesSync(file, new Date(), new Date()); // force a rebuild via the stat check
  const still = s.items().find((b) => b.text === 'private session note');
  assert.ok(still && still.sensitive, 'still marked after a forced rebuild');
  assert.ok(!fs.readFileSync(file, 'utf8').includes('private session note'),
    'the session-only entry is never on disk');
});

test('persisted(): plain and marked file bullets are file content, session-only entries are not', () => {
  sessionMod._resetForTests();
  const file = tmpFile();
  seed(file, { Facts: ['plain fact one'] });
  const s = sessionMod.get(file);
  const add = s.add('Facts', 'private session note', { sensitive: true });
  assert.equal(add.ok, true);
  const plain = s.items().find((b) => b.text === 'plain fact one');
  const sess = s.items().find((b) => b.text === 'private session note');
  assert.equal(s.persisted(plain.id), 'file');
  assert.equal(s.persisted(sess.id), 'session-only');
  s.markSensitive(plain.id, true);
  assert.equal(s.persisted(plain.id), 'file', 'a mark does not change where the bullet lives');
  assert.equal(s.persisted('m999'), null, 'an unknown id is not a persistence claim');
});
