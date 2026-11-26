'use strict';

// Red-first tests for the Gate 8 row stores (Ninad's 26 Nov 2026
// decision A): owning row stores for files/workflows/models. Pure
// in-memory containers: rows arrive only through explicit add() calls,
// nothing auto-scans and nothing auto-exposes; rows are frozen copies;
// the store is bounded; search is a bounded substring match.

const test = require('node:test');
const assert = require('node:assert');

let createWorkspaceStore;
try { createWorkspaceStore = require('../src/workspace-stores.js').createWorkspaceStore; }
catch (e) { createWorkspaceStore = null; }

function store(over) {
  if (!createWorkspaceStore) return null;
  return createWorkspaceStore(Object.assign({
    clock: () => 1000,
    name: 'files',
    prefix: 'f',
    maxRows: 5,
    fields: ['name', 'path', 'kind', 'size', 'modifiedAt', 'source'],
    types: { name: 'string', path: 'string', kind: 'string', size: 'number', modifiedAt: 'number', source: 'string' },
    enums: { kind: ['file', 'folder'], source: ['app_data', 'user_picked'] },
  }, over || {}));
}

test('a fresh store is empty, and add assigns prefix ids and freezes the row', () => {
  const s = store();
  if (!s) return assert.ok(false, 'module missing');
  assert.deepEqual(s.list(), []);
  const r = s.add({ name: 'todo.txt', path: '/Users/ninad/todo.txt', kind: 'file', size: 12, modifiedAt: 900, source: 'app_data' });
  assert.equal(r.ok, true);
  assert.equal(r.row.id, 'f1');
  assert.equal(Object.isFrozen(r.row), true);
  try { r.row.name = 'changed'; } catch (e) { /* frozen: strict-mode assignment throws, which is fine */ }
  assert.equal(s.list()[0].name, 'todo.txt', 'the stored row never mutates through a handed-out copy');
});

test('unknown keys and wrong types are refused with named reasons', () => {
  const s = store();
  if (!s) return assert.ok(false, 'module missing');
  assert.equal(s.add({ name: 'x', sneaky: true }).reason, 'unknown_field:sneaky');
  assert.equal(s.add({ name: 42 }).reason, 'wrong_type:name');
  assert.equal(s.add({ name: '' }).reason, 'empty_string:name');
  assert.equal(s.add(null).reason, 'row_invalid');
  assert.equal(s.add({ name: 'x', kind: 'symlink' }).reason, 'value_not_allowed:kind', 'the caller-side enum check holds');
});

test('the store is bounded and the refusal names the limit', () => {
  const s = store();
  if (!s) return assert.ok(false, 'module missing');
  for (let i = 0; i < 5; i++) s.add({ name: 'n' + i });
  assert.equal(s.add({ name: 'overflow' }).reason, 'store_full');
  assert.equal(s.list().length, 5);
});

test('remove and get work round trip and an unknown id is refused by name', () => {
  const s = store();
  if (!s) return assert.ok(false, 'module missing');
  s.add({ name: 'a' });
  s.add({ name: 'b' });
  assert.equal(s.get('w1'), undefined, 'ids never cross stores');
  assert.equal(s.get('f1').name, 'a');
  const rem = s.remove('f1');
  assert.equal(rem.ok, true);
  assert.equal(rem.row.name, 'a');
  assert.equal(s.list().length, 1);
  assert.equal(s.remove('f9').reason, 'unknown_id');
});

test('search is a bounded case-insensitive substring match over string fields', () => {
  const s = store();
  if (!s) return assert.ok(false, 'module missing');
  s.add({ name: 'Quarterly Report', path: '/docs/q4.pdf' });
  s.add({ name: 'notes', path: '/docs/notes.txt' });
  assert.deepEqual(s.search('quarterly').map((r) => r.id), ['f1']);
  assert.deepEqual(s.search('DOCS').map((r) => r.id), ['f1', 'f2'], 'matches any string field');
  assert.deepEqual(s.search('zzz'), []);
  assert.deepEqual(s.search(''), [], 'an empty query is not a list-all');
  assert.equal(s.search('a'.repeat(101)).reason, 'query_too_long');
});

test('the three approved stores construct with their own prefixes and fields', () => {
  const files = store();
  const workflows = store({ name: 'workflows', prefix: 'w', enums: {}, fields: ['name', 'kind', 'state', 'updatedAt', 'detail'], types: { name: 'string', kind: 'string', state: 'string', updatedAt: 'number', detail: 'string' } });
  const models = store({ name: 'models', prefix: 'md', enums: {}, fields: ['name', 'kind', 'source', 'status', 'notes'], types: { name: 'string', kind: 'string', source: 'string', status: 'string', notes: 'string' } });
  if (!files || !workflows || !models) return assert.ok(false, 'module missing');
  workflows.add({ name: 'nightly sync', kind: 'workflow', state: 'draft', updatedAt: 1, detail: 'syncs nightly' });
  models.add({ name: 'whisper-small', kind: 'stt', source: 'local', status: 'unavailable', notes: 'not downloaded' });
  assert.equal(workflows.list()[0].id, 'w1');
  assert.equal(models.list()[0].id, 'md1');
  assert.equal(files.list().length, 0, 'every store starts empty: no auto-scan, no auto-exposure');
});
