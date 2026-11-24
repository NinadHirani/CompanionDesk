'use strict';
// Gate 2 delivery gate: proves the pure delivery bridge against the REAL
// agent-notifications desk (normal paths) and stub desks (hostile paths):
// oldest-first bounded drain, at-most-once acknowledgment via markRead,
// sink refusal/throw/invalid verdicts fail closed with sanitized reasons,
// a plain allowlisted copy that the sink cannot use to reach the desk,
// malformed records refused before the sink, and bounded construction.
const test = require('node:test');
const assert = require('node:assert');
const { createNotificationDesk } = require('../src/agent-notifications');
const { createDeliveryBridge } = require('../src/agent-delivery');

function deskWith(n) {
  const d = createNotificationDesk({ clock: () => 1000 });
  for (let i = 0; i < n; i++) {
    const r = d.create({ title: 'T' + i, body: 'B' + i, priority: i === 0 ? 'high' : 'normal' });
    assert.equal(r.ok, true);
  }
  return d;
}

function stubDesk(records) {
  const acked = [];
  return {
    acked,
    pending: () => records, // pass-through: no spread, so accessors survive to the bridge
    markRead: (id) => { acked.push(id); return { ok: true, notification: { id } }; },
  };
}

test('delivery bridge: drains pending oldest-first, marks read, reports clean state', () => {
  const d = deskWith(3);
  const seen = [];
  const b = createDeliveryBridge({ notifications: d, sink: (r) => { seen.push(r.id); return { ok: true }; } });
  const out = b.drain();
  assert.equal(out.ok, true);
  assert.deepEqual(seen, ['ntf-000001', 'ntf-000002', 'ntf-000003']);
  assert.equal(out.delivered, 3);
  assert.equal(out.stopped, null);
  assert.equal(out.remainingPending, 0);
  assert.equal(d.pending().length, 0);
  assert.equal(d.list().every((r) => r.read), true);
});

test('delivery bridge: limit bounds the batch and a later drain finishes the rest', () => {
  const d = deskWith(3);
  const b = createDeliveryBridge({ notifications: d, sink: () => ({ ok: true }) });
  const first = b.drain({ limit: 2 });
  assert.equal(first.delivered, 2);
  assert.equal(first.remainingPending, 1);
  const second = b.drain();
  assert.equal(second.delivered, 1);
  assert.equal(second.remainingPending, 0);
});

test('delivery bridge: delivered records are never re-delivered', () => {
  const d = deskWith(2);
  let calls = 0;
  const b = createDeliveryBridge({ notifications: d, sink: () => { calls += 1; return { ok: true }; } });
  b.drain();
  const again = b.drain();
  assert.equal(calls, 2);
  assert.equal(again.delivered, 0);
  assert.equal(again.stopped, null);
});

test('delivery bridge: a sink refusal stops the drain; the refused record stays unread and a later drain recovers it', () => {
  const d = deskWith(3);
  let failOn = 2;
  const b = createDeliveryBridge({ notifications: d, sink: (r) => (r.id === 'ntf-000002' && failOn > 0 ? { ok: false, reason: 'storage_full' } : { ok: true }) });
  const out = b.drain();
  assert.equal(out.delivered, 1);
  assert.equal(out.stopped, 'storage_full');
  assert.equal(out.remainingPending, 2);
  const unread = d.pending();
  assert.equal(unread.length, 2);
  assert.equal(unread[0].id, 'ntf-000002');
  failOn = 0;
  const after = b.drain();
  assert.equal(after.delivered, 2);
  assert.equal(after.stopped, null);
});

test('delivery bridge: a throwing sink is caught, fails closed, and never escapes', () => {
  const d = deskWith(2);
  const b = createDeliveryBridge({ notifications: d, sink: () => { throw new Error('secret /home/user/path'); } });
  const out = b.drain();
  assert.equal(out.ok, true);
  assert.equal(out.delivered, 0);
  assert.equal(out.stopped, 'sink_error');
  assert.equal(d.pending().length, 2);
});

test('delivery bridge: a non-object sink verdict is a refusal', () => {
  for (const verdict of [undefined, null, 42, 'ok', [], true === 1 ? {} : [1, 2]]) {
    const d = deskWith(1);
    const b = createDeliveryBridge({ notifications: d, sink: () => verdict });
    const out = b.drain();
    assert.equal(out.stopped, 'sink_invalid');
    assert.equal(out.delivered, 0);
    assert.equal(d.pending().length, 1);
  }
});

test('delivery bridge: refusal reasons are sanitized to bounded printable strings', () => {
  const cases = [
    [{ ok: false, reason: { toString() { throw new Error('boom'); } } }, 'sink_refused'],
    [{ ok: false, reason: 'x'.repeat(300) }, 'sink_refused'],
    [{ ok: false, reason: 'bad\u0000reason' }, 'sink_refused'],
    [{ ok: false, reason: 'disk_full' }, 'disk_full'],
  ];
  for (const [verdict, expected] of cases) {
    const d = deskWith(1);
    const b = createDeliveryBridge({ notifications: d, sink: () => verdict });
    const out = b.drain();
    assert.equal(out.stopped, expected);
    assert.equal(d.pending().length, 1);
  }
});

test('delivery bridge: invalid limits are refused and the sink is never called', () => {
  const d = deskWith(1);
  let calls = 0;
  const b = createDeliveryBridge({ notifications: d, sink: () => { calls += 1; return { ok: true }; } });
  for (const limit of [0, -1, 1.5, '3', NaN]) {
    const out = b.drain({ limit });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'limit_invalid');
  }
  assert.equal(calls, 0);
});

test('delivery bridge: the sink receives a plain copy of exactly the allowlisted fields', () => {
  const rec = { id: 'ntf-000001', title: 'T', body: 'B', priority: 'normal', createdAt: 1000 };
  rec[Symbol('hostile')] = 'x';
  const d = stubDesk([rec]);
  let seen = null;
  const b = createDeliveryBridge({ notifications: d, sink: (r) => { seen = r; return { ok: true }; } });
  const out = b.drain();
  assert.equal(out.delivered, 1);
  assert.deepEqual(Object.keys(seen).sort(), ['body', 'createdAt', 'id', 'priority', 'title']);
  assert.equal(Object.getOwnPropertySymbols(seen).length, 0);
  assert.equal(Object.getPrototypeOf(seen), Object.prototype);
});

test('delivery bridge: mutating the delivered copy cannot reach the desk', () => {
  const d = deskWith(1);
  const b = createDeliveryBridge({ notifications: d, sink: (r) => { r.title = 'HACKED'; r.body = null; return { ok: true }; } });
  const out = b.drain();
  assert.equal(out.delivered, 1);
  const rec = d.list()[0];
  assert.equal(rec.title, 'T0');
  assert.equal(rec.body, 'B0');
  assert.equal(rec.read, true);
});

test('delivery bridge: a malformed record is refused unread before the sink', () => {
  for (const bad of [
    { id: 'ntf-000001', title: 'T', body: 'B', priority: 'normal', createdAt: 'not-a-number' },
    { id: 'X', title: 'T', body: 'B', priority: 'normal', createdAt: 1 },
    { id: 'ntf-000001', title: 'T', body: 'B', priority: 'urgent', createdAt: 1 },
    { id: 'ntf-000001', title: 'T', body: 'B', priority: 'normal', get createdAt() { return 1; } },
  ]) {
    const d = stubDesk([bad]);
    let calls = 0;
    const b = createDeliveryBridge({ notifications: d, sink: () => { calls += 1; return { ok: true }; } });
    const out = b.drain();
    assert.equal(out.stopped, 'record_invalid');
    assert.equal(out.delivered, 0);
    assert.equal(calls, 0);
    assert.equal(d.acked.length, 0);
  }
});

test('delivery bridge: construction fails closed on a missing or malformed sink, desk, or cap', () => {
  const d = deskWith(1);
  assert.throws(() => createDeliveryBridge({ notifications: d }), /sink_invalid/);
  assert.throws(() => createDeliveryBridge({ sink: () => ({ ok: true }) }), /desk_invalid/);
  assert.throws(() => createDeliveryBridge({ notifications: { pending: () => [] }, sink: () => ({ ok: true }) }), /desk_invalid/);
  for (const maxBatch of [0, -1, 1.5, '3']) {
    assert.throws(() => createDeliveryBridge({ notifications: d, sink: () => ({ ok: true }), maxBatch }), /max_batch_invalid/);
  }
});

test('delivery bridge: maxBatch may only lower the default cap', () => {
  const d = deskWith(5);
  const b = createDeliveryBridge({ notifications: d, sink: () => ({ ok: true }), maxBatch: 3 });
  assert.equal(b.maxBatch, 3);
  const out = b.drain();
  assert.equal(out.delivered, 3);
  assert.equal(out.remainingPending, 2);
});

test('delivery bridge: the default cap holds at 10 records per drain', () => {
  const d = deskWith(12);
  const b = createDeliveryBridge({ notifications: d, sink: () => ({ ok: true }) });
  assert.equal(b.maxBatch, 10);
  const out = b.drain();
  assert.equal(out.delivered, 10);
  assert.equal(out.remainingPending, 2);
});

test('delivery bridge: an empty queue drains to a clean no-op', () => {
  const d = deskWith(0);
  let calls = 0;
  const b = createDeliveryBridge({ notifications: d, sink: () => { calls += 1; return { ok: true }; } });
  const out = b.drain();
  assert.equal(out.ok, true);
  assert.equal(out.delivered, 0);
  assert.equal(out.stopped, null);
  assert.equal(calls, 0);
});

test('delivery bridge: a non-array pending list from a desk-shaped source is reported, not trusted', () => {
  const d = { pending: () => 'nope', markRead: () => ({ ok: true }) };
  const b = createDeliveryBridge({ notifications: d, sink: () => ({ ok: true }) });
  const out = b.drain();
  assert.equal(out.ok, true);
  assert.equal(out.delivered, 0);
  assert.equal(out.stopped, 'desk_invalid');
});
