'use strict';

// Gate 2 AI-access connector flow (Ninad's decision, 27 Nov 2026): the
// request center behind the AI's ask. The agent raises a user-facing
// connect request; only an explicit user gesture resolves it; approval
// never connects by itself. Red-first pins: validation, the one-open-
// request-per-connector dedupe, the bound, the userInitiated gate, the
// audit trail and the fail-closed snapshot/restore.

const test = require('node:test');
const assert = require('node:assert');
const { createConnectorRequestCenter } = require('../src/connector-requests.js');

function center(t) {
  let now = 1000;
  const known = new Set(['rss', 'ollama', 'github']);
  const c = createConnectorRequestCenter({ clock: () => now, exists: (id) => known.has(id) });
  c.__tick = () => { now += 1; };
  return c;
}

test('the agent can raise a request; it starts pending and is listed', () => {
  const c = center();
  const r = c.request('rss', { reason: 'the task needs feed reads' });
  assert.equal(r.ok, true);
  assert.equal(r.state, 'pending');
  const list = c.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].connectorId, 'rss');
  assert.equal(list[0].status, 'pending');
  assert.equal(list[0].reason, 'the task needs feed reads');
});

test('unknown connectors, empty or oversized or control-character reasons are refused', () => {
  const c = center();
  assert.equal(c.request('nope', { reason: 'x' }).reason, 'unknown_connector');
  assert.equal(c.request('', { reason: 'x' }).reason, 'bad_connector_id');
  assert.equal(c.request('rss', { reason: '' }).reason, 'reason_required_1_280');
  assert.equal(c.request('rss', { reason: ' '.repeat(281) }).reason, 'reason_required_1_280');
  assert.equal(c.request('rss', { reason: 'line1\nline2' }).reason, 'reason_invalid');
  assert.equal(c.request('rss', {}).reason, 'reason_required_1_280');
  assert.equal(c.list().length, 0, 'a refusal never creates a request');
});

test('one open request per connector: a repeat refreshes and counts, it never duplicates', () => {
  const c = center();
  const first = c.request('rss', { reason: 'first' });
  c.__tick();
  const second = c.request('rss', { reason: 'second' });
  assert.equal(second.ok, true);
  assert.equal(second.requestId, first.requestId, 'the same request is refreshed, not duplicated');
  assert.equal(c.list().length, 1);
  assert.equal(c.list()[0].reason, 'second');
  assert.equal(c.list()[0].repeats, 1);
});

test('a dismissed request can be asked again as a fresh pending one', () => {
  const c = center();
  const first = c.request('rss', { reason: 'first' });
  assert.equal(c.resolve(first.requestId, { userInitiated: true, decision: 'dismissed' }).ok, true);
  const second = c.request('rss', { reason: 'again' });
  assert.equal(second.ok, true);
  assert.notEqual(second.requestId, first.requestId);
  assert.equal(c.list().length, 2);
});

test('resolve requires an explicit user gesture, a valid decision and a pending request', () => {
  const c = center();
  const r = c.request('github', { reason: 'needs the API' });
  assert.equal(c.resolve(r.requestId, { decision: 'approved' }).reason, 'requires_user_action', 'no userInitiated, no resolution');
  assert.equal(c.resolve(r.requestId, { userInitiated: true, decision: 'maybe' }).reason, 'bad_decision');
  assert.equal(c.resolve('cr-999', { userInitiated: true, decision: 'approved' }).reason, 'unknown_request');
  assert.equal(c.resolve(r.requestId, { userInitiated: true, decision: 'approved' }).ok, true);
  assert.equal(c.resolve(r.requestId, { userInitiated: true, decision: 'dismissed' }).reason, 'not_pending', 'already resolved');
  const states = c.list().map((x) => x.status);
  assert.deepEqual(states, ['approved']);
});

test('approval never connects: the request center has no catalog access at all', () => {
  const c = center();
  const r = c.request('ollama', { reason: 'local models for a task' });
  c.resolve(r.requestId, { userInitiated: true, decision: 'approved' });
  assert.equal(c.list()[0].status, 'approved');
  // No connect/disconnect/grant surface exists on this module at all.
  for (const bad of ['connect', 'disconnect', 'grant', 'authorizeCall', 'approve']) {
    assert.equal(typeof c[bad], 'undefined', 'no ' + bad + ' surface on the request center');
  }
});

test('the open queue is bounded', () => {
  let now = 1000;
  const ids = new Set();
  for (let i = 0; i < 30; i++) ids.add('svc-' + i);
  const c = createConnectorRequestCenter({ clock: () => now++, exists: (id) => ids.has(id) });
  for (let i = 0; i < 26; i++) {
    const r = c.request('svc-' + i, { reason: 'r' + i });
    if (i < 25) assert.equal(r.ok, true, 'request ' + i + ' accepted');
    else assert.equal(r.reason, 'limit_reached', 'request 26 refused');
  }
});

test('the audit trail records accepted changes only and never carries credential material', () => {
  const c = center();
  const r = c.request('rss', { reason: 'needs feeds' });
  c.resolve(r.requestId, { userInitiated: true, decision: 'approved' });
  c.request('rss', { reason: 'rejected?' }); // refused: already approved, dedupe path? no: approved is open -> refresh
  const acts = c.audit().map((a) => a.action);
  assert.deepEqual(acts, ['request_created', 'request_approved', 'request_repeated']);
  const blob = JSON.stringify(c.audit());
  assert.equal(/keychain:|vault:|credential-store:/i.test(blob), false);
});

test('snapshot and restore round-trip pending and resolved requests', () => {
  const c = center();
  const a = c.request('rss', { reason: 'one' });
  const b = c.request('github', { reason: 'two' });
  c.resolve(b.requestId, { userInitiated: true, decision: 'dismissed' });
  const snap = JSON.parse(JSON.stringify(c.snapshot()));
  const fresh = center();
  const res = fresh.restore(snap);
  assert.equal(res.ok, true, JSON.stringify(res.problems));
  const list = fresh.list();
  assert.equal(list.length, 2);
  assert.equal(list.find((x) => x.id === a.requestId).status, 'pending');
  assert.equal(list.find((x) => x.id === b.requestId).status, 'dismissed');
  // seq continues after restore: a new request never reuses an id
  const next = fresh.request('ollama', { reason: 'three' });
  assert.equal(next.ok, true);
  const ids = new Set(fresh.list().map((x) => x.id));
  assert.equal(ids.size, fresh.list().length, 'no id reuse');
});

test('restore fails closed on invalid records and drops exactly the bad ones', () => {
  const snap = { requests: [
    { id: 'cr-1', connectorId: 'rss', reason: 'ok', requestedAt: 1, status: 'pending' },
    { id: 'cr-2', connectorId: 'nope', reason: 'ok', requestedAt: 2, status: 'pending' },
    { id: 'bad', connectorId: 'ollama', reason: 'ok', requestedAt: 3, status: 'pending' },
    { id: 'cr-4', connectorId: 'github', reason: '', requestedAt: 4, status: 'pending' },
    { id: 'cr-5', connectorId: 'github', reason: 'ok', requestedAt: 5, status: 'zapped' },
    { id: 'cr-6', connectorId: 'github', reason: 'ok', requestedAt: 'x', status: 'pending' },
  ] };
  const c = center();
  const res = c.restore(snap);
  assert.equal(res.ok, false);
  assert.equal(res.problems.length, 5);
  assert.deepEqual(c.list().map((r) => r.id), ['cr-1']);
  assert.equal(c.restore({}).ok, false, 'a malformed snapshot is refused');
});
