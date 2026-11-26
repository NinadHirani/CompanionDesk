'use strict';

// M4 sidecar slice (26 Nov 2026): tests for src/memory-sidecar.js, the
// session-only sidecar for sensitive memory state (decision-sheet item 6,
// approved by Ninad on 26 Nov 2026). Pins: purity (no requires, no fs,
// nothing touches disk), the key contract (section + normalized text),
// bounded books that fail closed, and fresh-copy outputs.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const src = fs.readFileSync('src/memory-sidecar.js', 'utf8');
const sidecarMod = require('../src/memory-sidecar');
const memory = require('../src/memory');

test('the sidecar is pure: no require, no fs, no timers in the module source', () => {
  assert.equal(src.includes('require('), false);
  assert.equal(src.includes('fs.'), false);
  assert.equal(/setTimeout|setInterval/.test(src), false);
});

test('marks: mark, unmark, isMarked over section + normalized text', () => {
  const sc = sidecarMod.createSidecar({ normalize: memory.normalize });
  assert.equal(sc.isMarked('Facts', 'secret note'), false);
  assert.equal(sc.mark('Facts', 'secret note').ok, true);
  assert.equal(sc.isMarked('Facts', 'secret note'), true);
  assert.equal(sc.isMarked('Facts', 'SECRET   NOTE.'), true, 'normalized');
  assert.equal(sc.isMarked('Goals', 'secret note'), false, 'section-bound');
  assert.equal(sc.unmark('Facts', 'secret note').ok, true);
  assert.equal(sc.isMarked('Facts', 'secret note'), false);
  assert.equal(sc.unmark('Facts', 'never marked').ok, true, 'idempotent');
});

test('entries: remember, forget, has, entryList fresh copies', () => {
  const sc = sidecarMod.createSidecar({ normalize: memory.normalize });
  assert.equal(sc.remember('Facts', 'session-only entry').ok, true);
  assert.equal(sc.has('Facts', 'session-only entry'), true);
  const list = sc.entryList();
  assert.deepEqual(list, [{ section: 'Facts', text: 'session-only entry' }]);
  list[0].text = 'mutated';
  assert.equal(sc.entryList()[0].text, 'session-only entry', 'fresh copies');
  assert.equal(sc.forget('Facts', 'session-only entry').ok, true);
  assert.equal(sc.has('Facts', 'session-only entry'), false);
  assert.equal(sc.forget('Facts', 'session-only entry').ok, false);
  assert.equal(sc.forget('Facts', 'session-only entry').reason, 'not_found');
});

test('bad input refuses: empty, non-string, oversized', () => {
  const sc = sidecarMod.createSidecar({ normalize: memory.normalize });
  const bad = [['', 'x'], ['Facts', ''], [42, 'x'], ['Facts', 42], ['Facts', 'x'.repeat(201)], ['x'.repeat(41), 'ok text']];
  for (const [sec, text] of bad) {
    assert.equal(sc.mark(sec, text).ok, false);
    assert.equal(sc.remember(sec, text).ok, false);
  }
});

test('bounded: 100 marks and 50 entries, then sidecar_full; clear empties both', () => {
  const sc = sidecarMod.createSidecar({ normalize: memory.normalize });
  for (let i = 0; i < 100; i++) assert.equal(sc.mark('Facts', `mark ${i}`).ok, true);
  assert.equal(sc.mark('Facts', 'one mark too many').ok, false);
  assert.equal(sc.mark('Facts', 'one mark too many').reason, 'sidecar_full');
  for (let i = 0; i < 50; i++) assert.equal(sc.remember('Goals', `entry ${i}`).ok, true);
  assert.equal(sc.remember('Goals', 'one entry too many').ok, false);
  assert.deepEqual(sc.counts(), { marks: 100, entries: 50 });
  assert.equal(sc.clear().ok, true);
  assert.deepEqual(sc.counts(), { marks: 0, entries: 0 });
});
