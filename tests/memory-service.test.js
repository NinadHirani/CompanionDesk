'use strict';

// M2/M4 memory panel service tests: the new personal.js memory functions
// over a real tmp About-me file, no Electron and no network.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const memory = require('../src/memory');
const sessionMod = require('../src/memory-session');
const personal = require('../src/personal');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-memsrv-'));
  return path.join(dir, '_about-me.md');
}

const SECTIONS = ['Facts', 'Goals', 'Routines', 'Preferences', 'Constraints'];

function seed(file, sections = {}) {
  let text = '# About me\n\n';
  for (const sec of SECTIONS) {
    text += '## ' + sec + '\n\n';
    for (const b of sections[sec] || []) text += '- ' + b + '\n';
    text += '\n';
  }
  memory.writeText(file, text);
}

test('itemsMemory: full view with persisted provenance and sections', () => {
  sessionMod._resetForTests();
  const file = tmpFile();
  seed(file, { Facts: ['plain fact one'] });
  sessionMod.get(file).add('Facts', 'private session note', { sensitive: true });
  const p = personal.itemsMemory({ meFile: file });
  assert.equal(p.ok, true);
  assert.deepEqual(p.sections, memory.SECTIONS);
  const plain = p.items.find((b) => b.text === 'plain fact one');
  const sess = p.items.find((b) => b.text === 'private session note');
  assert.equal(plain.persisted, true);
  assert.equal(plain.sensitive, undefined);
  assert.equal(sess.persisted, false);
  assert.equal(sess.sensitive, true);
});

test('markMemory: mark and unmark round-trip on a saved bullet', () => {
  sessionMod._resetForTests();
  const file = tmpFile();
  seed(file, { Facts: ['plain fact one'] });
  const id = personal.itemsMemory({ meFile: file }).items[0].id;
  const m = personal.markMemory({ meFile: file }, { id, value: true });
  assert.equal(m.ok, true);
  assert.equal(personal.itemsMemory({ meFile: file }).items[0].sensitive, true);
  const u = personal.markMemory({ meFile: file }, { id, value: false });
  assert.equal(u.ok, true);
  assert.equal(personal.itemsMemory({ meFile: file }).items[0].sensitive, undefined);
});

test('markMemory: unmarking a session-only entry is refused', () => {
  sessionMod._resetForTests();
  const file = tmpFile();
  seed(file, {});
  sessionMod.get(file).add('Facts', 'private session note', { sensitive: true });
  const id = personal.itemsMemory({ meFile: file }).items[0].id;
  const u = personal.markMemory({ meFile: file }, { id, value: false });
  assert.equal(u.ok, false);
  assert.equal(u.error, 'session_only_entry');
});

test('persistMemory: fail-closed for session-only, no-op ok for plain, nothing written', () => {
  sessionMod._resetForTests();
  const file = tmpFile();
  seed(file, { Facts: ['plain fact one'] });
  sessionMod.get(file).add('Facts', 'private session note', { sensitive: true });
  const items = personal.itemsMemory({ meFile: file }).items;
  const plain = items.find((b) => b.text === 'plain fact one');
  const sess = items.find((b) => b.text === 'private session note');
  const r1 = personal.persistMemory({ meFile: file }, { id: sess.id });
  assert.equal(r1.ok, false);
  assert.equal(r1.error, 'sensitive_storage_blocked');
  assert.match(r1.detail, /no on-disk format preserves the sensitive mark yet/);
  const r2 = personal.persistMemory({ meFile: file }, { id: plain.id });
  assert.equal(r2.ok, true);
  assert.equal(r2.persisted, true);
  assert.ok(!fs.readFileSync(file, 'utf8').includes('private session note'), 'nothing was written to the file');
});

test('searchMemory: budget, consent gate and matched terms are visible', () => {
  sessionMod._resetForTests();
  const file = tmpFile();
  seed(file, { Facts: ['likes filter coffee', 'private health note'] });
  const id = personal.itemsMemory({ meFile: file }).items.find((b) => b.text === 'private health note').id;
  personal.markMemory({ meFile: file }, { id, value: true });
  const hidden = personal.searchMemory({ meFile: file }, { query: 'health note' });
  assert.equal(hidden.ok, true);
  assert.equal(hidden.task, 'chat');
  assert.equal(hidden.budget, 12);
  assert.equal(hidden.candidates, 2);
  assert.equal(hidden.sensitiveTotal, 1);
  assert.equal(hidden.sensitiveIncluded, 0);
  assert.deepEqual(hidden.results, [], 'the consent gate hides the marked bullet without consent');
  const consented = personal.searchMemory({ meFile: file }, { query: 'health note', includeSensitive: true });
  assert.equal(consented.sensitiveIncluded, 1);
  assert.equal(consented.results.length, 1);
  assert.equal(consented.results[0].id, id);
  assert.ok(Array.isArray(consented.results[0].matched) && consented.results[0].matched.length >= 1, 'matched terms are returned');
  const plain = personal.searchMemory({ meFile: file }, { query: 'filter coffee' });
  assert.equal(plain.results.length, 1);
  assert.equal(plain.results[0].text, 'likes filter coffee');
  const vision = personal.searchMemory({ meFile: file }, { query: 'filter coffee', task: 'vision' });
  assert.equal(vision.budget, 0);
  assert.deepEqual(vision.results, [], 'vision pulls zero memory');
  const none = personal.searchMemory({ meFile: file }, { query: 'zzzqqq' });
  assert.deepEqual(none.results, []);
});
