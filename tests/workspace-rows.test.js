'use strict';

// Tests for the workspace rows provider (Gate 3/8 wiring): projection to
// the exact schema fields, and a refusal reason for every fail-closed edge.

const test = require('node:test');
const assert = require('node:assert');
const { createWorkspaceRows } = require('../src/workspace-rows.js');

const REMINDER = { id: 'rem-000003', title: 'Evening plan', dueAt: 1735312800000, notes: null, createdAt: 1735309200000, cancelled: false, acknowledged: true };
const MEMORY_ITEM = { id: 'm-1', section: 'preferences', text: 'likes tea', sensitive: true, persisted: false };

test('rows() projects owning rows to exactly the schema fields', () => {
  const w = createWorkspaceRows({
    tasks: () => [REMINDER],
    memory: () => [MEMORY_ITEM],
  });
  const t = w.rows('tasks');
  assert.strictEqual(t.ok, true);
  assert.deepStrictEqual(Object.keys(t.rows[0]), ['id', 'title', 'dueAt', 'notes', 'createdAt', 'cancelled']);
  const m = w.rows('memory');
  assert.strictEqual(m.ok, true);
  assert.deepStrictEqual(Object.keys(m.rows[0]), ['id', 'section', 'text']);
});

test('rows() refuses every fail-closed edge with a reason', () => {
  const w = createWorkspaceRows({
    tasks: () => [REMINDER],
    conversations: () => { throw new Error('boom'); },
    tools: () => 'not-an-array',
  });
  assert.strictEqual(w.rows('files').reason, 'view_not_wired');
  assert.strictEqual(w.rows('nope').reason, 'unknown_view');
  assert.strictEqual(w.rows('').reason, 'bad_input');
  assert.strictEqual(w.rows(7).reason, 'bad_input');
  const bare = createWorkspaceRows({});
  assert.strictEqual(bare.rows('tasks').reason, 'provider_missing');
  assert.strictEqual(w.rows('conversations').reason, 'provider_failed');
  assert.strictEqual(w.rows('tools').reason, 'bad_provider_output');
});

test('rows() output feeds the shaper without silent skips when extras exist', () => {
  const views = require('../src/workspace-views.js');
  const w = createWorkspaceRows({ tasks: () => [REMINDER] });
  const sh = views.shape('tasks', w.rows('tasks').rows);
  assert.strictEqual(sh.ok, true);
  assert.strictEqual(sh.shown, 1);
  assert.strictEqual(sh.skipped, 0);
});
