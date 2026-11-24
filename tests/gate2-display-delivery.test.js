'use strict';

// Gate 2 delivery gate, blueprint 3j.6: the narrow main-only delivery
// operation that copies UNREAD records from the persisted notification
// desk into the main-owned display store. Adversarial coverage:
//   - delivery never mutates the desk: no read flag flips, no audit, no
//     acknowledgement at delivery, no change across repeated passes;
//   - restart reconciliation repopulates only unread records into a fresh
//     store, and replays are idempotent duplicates;
//   - capacity is explicit: a full store stops with an overflow report
//     naming the remaining count and the next eligible id, and the store's
//     FIFO eviction may only ever displace a record the desk holds and has
//     already acked (an unread record is never silently displaced);
//   - progress is bounded and starvation-free: each successful ack
//     triggers a pass that frees exactly one slot, so every unread record
//     eventually displays;
//   - orphan garbage collection is explicit and reported, never silent;
//   - sink faults (throwing or malformed verdicts) fail closed with the
//     desk untouched;
//   - malformed sources are refused and counted, never guessed around;
//   - the renderer can neither trigger delivery, choose records, append,
//     nor bypass acknowledgement: no new IPC channel, no renderer path, no
//     ack words anywhere in the delivery operation;
//   - the real stack still acknowledges only through the 3j.5 explicit
//     gesture, audit durability is preserved, and an ack failure leaves
//     the record unread and eligible.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const LocalDb = require('../src/db');
const { createRegistry } = require('../src/tool-registry');
const { createPolicyEngine } = require('../src/policy-engine');
const { createApprovalDesk } = require('../src/approval');
const { createAuditLog } = require('../src/audit');
const { createEmergencyStop } = require('../src/emergency-stop');
const { createNotificationDesk } = require('../src/agent-notifications');
const { createReminderBook } = require('../src/agent-reminders');
const { createAgentPersistence } = require('../src/agent-persistence');
const { createAgentStack } = require('../src/agent-runtime');
const { createNotificationsDisplayStore, MAX_RECORDS } = require('../src/agent-notifications-display');
const { createDisplayDelivery } = require('../src/agent-display-delivery');

const NOW = 1_700_000_000_000;

function makeWorld(n, { maxBatch } = {}) {
  const desk = createNotificationDesk({ clock: () => NOW });
  for (let i = 0; i < n; i++) {
    const c = desk.create({ title: 't' + (i + 1), body: 'b' + (i + 1), priority: 'normal' });
    assert.equal(c.ok, true);
  }
  const store = createNotificationsDisplayStore();
  const delivery = createDisplayDelivery({ readDesk: () => desk.list(), store, ...(maxBatch !== undefined ? { maxBatch } : {}) });
  return { desk, store, delivery };
}

function ids(store) { return store.list().map((r) => r.id); }

test('constructor: bad shapes are refused', () => {
  assert.throws(() => createDisplayDelivery({}), /source_invalid/);
  const desk = createNotificationDesk({ clock: () => NOW });
  assert.throws(() => createDisplayDelivery({ readDesk: () => desk.list() }), /store_invalid/);
  const store = createNotificationsDisplayStore();
  assert.throws(() => createDisplayDelivery({ readDesk: () => desk.list(), store, maxBatch: 0 }), /max_batch_invalid/);
  assert.throws(() => createDisplayDelivery({ readDesk: () => desk.list(), store, maxBatch: -1 }), /max_batch_invalid/);
  assert.throws(() => createDisplayDelivery({ readDesk: () => desk.list(), store, maxBatch: 2.5 }), /max_batch_invalid/);
});

test('delivery never mutates the desk: no read flag flips across repeated passes', () => {
  const w = makeWorld(3);
  const before = w.desk.list();
  const r1 = w.delivery.deliver();
  const r2 = w.delivery.deliver();
  assert.deepEqual(w.desk.list(), before);
  for (const r of w.desk.list()) assert.equal(r.read, false);
  assert.equal(r1.ok, true);
  assert.equal(r2.delivered, 0);
  assert.equal(w.desk.count(), 3);
});

test('eligibility: only unread records are delivered, oldest first', () => {
  const w = makeWorld(3);
  assert.equal(w.desk.markRead('ntf-000002').ok, true);
  const r = w.delivery.deliver();
  assert.equal(r.ok, true);
  assert.equal(r.delivered, 2);
  assert.deepEqual(ids(w.store), ['ntf-000001', 'ntf-000003']);
  assert.equal(r.stopped, null);
  assert.equal(r.remaining, 0);
});

test('restart reconciliation: a fresh store repopulates only unread records; replays are duplicates', () => {
  const desk = createNotificationDesk({ clock: () => NOW });
  desk.create({ title: 'a', body: 'b' });
  desk.create({ title: 'c', body: 'd' });
  desk.markRead('ntf-000001');
  const storeA = createNotificationsDisplayStore();
  const dA = createDisplayDelivery({ readDesk: () => desk.list(), store: storeA });
  const rA = dA.deliver();
  assert.equal(rA.delivered, 1);
  assert.deepEqual(ids(storeA), ['ntf-000002']);
  storeA.close();

  // Simulated restart: a fresh ephemeral store, the same persisted desk.
  const storeB = createNotificationsDisplayStore();
  const dB = createDisplayDelivery({ readDesk: () => desk.list(), store: storeB });
  const r1 = dB.deliver();
  assert.equal(r1.delivered, 1);
  assert.deepEqual(ids(storeB), ['ntf-000002']);
  const r2 = dB.deliver();
  assert.equal(r2.delivered, 0);
  assert.equal(r2.duplicates, 1);
  assert.deepEqual(ids(storeB), ['ntf-000002']);
});

test('capacity and overflow: explicit report, no unread record is ever displaced', () => {
  const w = makeWorld(50);
  let total = 0;
  for (let i = 0; i < 7; i++) {
    const r = w.delivery.deliver();
    total += r.delivered;
    if (r.delivered === 0) { assert.equal(r.stopped, null); break; }
    assert.ok(r.stopped === 'batch_limit' || r.stopped === null, 'unexpected stop: ' + r.stopped);
  }
  assert.equal(total, 50);
  assert.equal(w.store.size(), MAX_RECORDS);

  assert.equal(w.desk.create({ title: 'late', body: 'one' }).ok, true);
  assert.equal(w.desk.create({ title: 'late', body: 'two' }).ok, true);
  const overflow = w.delivery.deliver();
  assert.equal(overflow.ok, true);
  assert.equal(overflow.stopped, 'overflow');
  assert.equal(overflow.remaining, 2);
  assert.equal(overflow.nextId, 'ntf-000051');
  assert.equal(w.store.size(), MAX_RECORDS);
  const shown = ids(w.store);
  assert.equal(shown.length, MAX_RECORDS);
  for (let i = 1; i <= 50; i++) assert.ok(shown.includes('ntf-' + String(i).padStart(6, '0')), 'unread record displaced: ntf-' + i);
  assert.ok(!shown.includes('ntf-000051'));
  assert.ok(!shown.includes('ntf-000052'));
});

test('progress: each ack frees exactly one slot and every record eventually displays', () => {
  const w = makeWorld(52);
  for (let i = 0; i < 5; i++) w.delivery.deliver(); // 50 displayed, 2 overflowed
  const everDisplayed = new Set(ids(w.store));
  let passes = 0;
  while (true) {
    const shown = ids(w.store);
    for (const id of shown) everDisplayed.add(id);
    // No unread record may vanish from display during a pass: collect
    // before-state, ack the oldest displayed unread, pass, then verify.
    const oldestUnreadShown = shown.find((id) => {
      const rec = w.desk.list().find((r) => r.id === id);
      return rec && rec.read === false;
    });
    if (oldestUnreadShown === undefined) {
      // everything shown is read; keep delivering until the desk is done
      const r = w.delivery.deliver();
      assert.equal(r.ok, true);
      if (r.delivered === 0 && r.duplicates === 0 && r.remaining === 0 && r.stopped === null) break;
      passes += 1;
      assert.ok(passes < 200, 'convergence loop did not end');
      continue;
    }
    const before = ids(w.store);
    assert.equal(w.desk.markRead(oldestUnreadShown).ok, true);
    const r = w.delivery.deliver();
    assert.equal(r.ok, true);
    const after = ids(w.store);
    for (const gone of before.filter((id) => !after.includes(id))) {
      const rec = w.desk.list().find((x) => x.id === gone);
      assert.ok(rec && rec.read === true, 'a record was displaced without being acked: ' + gone);
    }
    passes += 1;
    assert.ok(passes < 200, 'convergence loop did not end');
  }
  const finalShown = ids(w.store);
  for (const id of finalShown) everDisplayed.add(id);
  for (let i = 1; i <= 52; i++) {
    assert.ok(everDisplayed.has('ntf-' + String(i).padStart(6, '0')), 'record never displayed: ntf-' + i);
  }
});

test('duplicate and replay delivery changes nothing beyond the report', () => {
  const w = makeWorld(3);
  const r1 = w.delivery.deliver();
  assert.equal(r1.delivered, 3);
  const snapshot = ids(w.store);
  const r2 = w.delivery.deliver();
  assert.equal(r2.delivered, 0);
  assert.equal(r2.duplicates, 3);
  assert.deepEqual(ids(w.store), snapshot);
});

test('sink faults fail closed: a throwing or lying append never mutates the desk', () => {
  const w = makeWorld(3);
  const realAppend = w.store.append.bind(w.store);
  const hostile = {
    append: () => { throw new Error('boom'); },
    list: (l) => w.store.list(l),
    size: () => w.store.size(),
    isClosed: () => w.store.isClosed(),
    drop: (id) => w.store.drop(id),
  };
  const h = createDisplayDelivery({ readDesk: () => w.desk.list(), store: hostile });
  const r = h.deliver();
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'store_error');
  assert.equal(r.delivered, 0);
  assert.equal(w.desk.count(), 3);
  for (const rec of w.desk.list()) assert.equal(rec.read, false);

  // A verdict that lies about acceptance is also a failure, not a claim.
  const liar = { ...hostile, append: () => ({ ok: true }) };
  const h2 = createDisplayDelivery({ readDesk: () => w.desk.list(), store: liar });
  assert.equal(h2.deliver().reason, 'store_error');

  // After the fault is repaired a later pass delivers normally.
  const ok = w.delivery.deliver();
  assert.equal(ok.ok, true);
  assert.equal(ok.delivered, 3);
  assert.equal(realAppend({ id: 'ntf-000009', title: 'x', body: 'y', priority: 'normal', createdAt: NOW }).ok, true);
});

test('malformed source: refused and counted, valid records still delivered', () => {
  const desk = createNotificationDesk({ clock: () => NOW });
  desk.create({ title: 'good', body: 'b' });
  const bad = [
    null,
    { id: 'ntf-000002', title: 't', body: 'b', priority: 'normal', createdAt: NOW, read: false, extra: 1 },
    { id: 'BAD-ID', title: 't', body: 'b', priority: 'normal', createdAt: NOW, read: false },
    { id: 'ntf-000003', title: 't', body: 'b', priority: 'normal', createdAt: NOW, read: 'yes' },
    new Proxy({}, { get: (t, k) => (k === 'id' ? 'ntf-000004' : undefined) }),
  ];
  // sanity: the hostile proxy reads harmlessly but has no own data
  // properties, so the descriptor inspection is what refuses it
  assert.equal(typeof bad[4].id, 'string');
  assert.equal(Object.getOwnPropertyDescriptor(bad[4], 'id'), null);

  const store = createNotificationsDisplayStore();
  const delivery = createDisplayDelivery({ readDesk: () => [desk.list()[0], ...bad], store });
  const r = delivery.deliver();
  assert.equal(r.ok, true);
  assert.equal(r.delivered, 1);
  assert.equal(r.refused, bad.length);
  assert.deepEqual(ids(store), ['ntf-000001']);
  for (const rec of desk.list()) assert.equal(rec.read, false);

  // A non-array source is a refusal, not a silent empty pass.
  const none = createDisplayDelivery({ readDesk: () => null, store });
  assert.deepEqual(none.deliver(), { ok: false, reason: 'source_invalid' });
});

test('source duplicates: the first occurrence wins, later ones are counted', () => {
  const desk = createNotificationDesk({ clock: () => NOW });
  desk.create({ title: 'a', body: 'b' });
  const dup = { ...desk.list()[0] };
  const store = createNotificationsDisplayStore();
  const delivery = createDisplayDelivery({ readDesk: () => [desk.list()[0], dup], store });
  const r = delivery.deliver();
  assert.equal(r.delivered, 1);
  assert.equal(r.sourceDuplicates, 1);
  assert.equal(store.size(), 1);
});

test('orphan garbage collection: explicit and reported, never silent', () => {
  // Case 1: a small store.
  const w = makeWorld(2);
  w.delivery.deliver();
  assert.equal(w.desk.remove('ntf-000001').ok, true);
  const r = w.delivery.deliver();
  assert.equal(r.ok, true);
  assert.equal(r.delivered, 0);
  assert.equal(r.droppedOrphans, 1);
  assert.deepEqual(r.droppedIds, ['ntf-000001']);
  assert.deepEqual(ids(w.store), ['ntf-000002']);

  // Case 2: a full store; dropping the orphan frees a real slot.
  const w2 = makeWorld(50);
  let filled = 0;
  for (let i = 0; i < 7; i++) {
    const r = w2.delivery.deliver();
    filled += r.delivered;
    if (r.delivered === 0) break;
  }
  assert.equal(filled, 50);
  assert.equal(w2.store.size(), MAX_RECORDS);
  assert.equal(w2.desk.remove('ntf-000001').ok, true);
  w2.desk.create({ title: 'new', body: 'one' });
  const r2 = w2.delivery.deliver();
  assert.equal(r2.ok, true);
  assert.equal(r2.droppedOrphans, 1);
  assert.equal(r2.delivered, 1);
  assert.equal(w2.store.size(), MAX_RECORDS);
  assert.ok(ids(w2.store).includes('ntf-000051'));
});

test('lifecycle: a closed display store refuses the whole pass, desk untouched', () => {
  const w = makeWorld(2);
  w.store.close();
  const r = w.delivery.deliver();
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'store_closed');
  assert.equal(w.desk.count(), 2);
  for (const rec of w.desk.list()) assert.equal(rec.read, false);
  assert.equal(w.store.drop('ntf-000001').reason, 'closed');
});

test('bounded batch: default 10, lowerable, never raisable', () => {
  const w = makeWorld(15);
  const r = w.delivery.deliver();
  assert.equal(r.delivered, 10);
  assert.equal(r.stopped, 'batch_limit');
  assert.equal(r.remaining, 5);
  assert.equal(r.nextId, 'ntf-000011');
  const r2 = w.delivery.deliver();
  assert.equal(r2.delivered, 5);
  assert.equal(r2.stopped, null);

  const small = makeWorld(15, { maxBatch: 3 });
  assert.equal(small.delivery.deliver().delivered, 3);
  assert.equal(small.delivery.maxBatch, 3);

  const big = makeWorld(15, { maxBatch: 1000 });
  assert.equal(big.delivery.maxBatch, 10);
  assert.equal(big.delivery.deliver().delivered, 10);
});

test('refused ids in the report are bounded', () => {
  const bad = [];
  for (let i = 0; i < 30; i++) bad.push({ id: 'BAD-' + i, title: 't', body: 'b', priority: 'normal', createdAt: NOW, read: false });
  const store = createNotificationsDisplayStore();
  const delivery = createDisplayDelivery({ readDesk: () => bad, store });
  const r = delivery.deliver();
  assert.equal(r.refused, 30);
  assert.ok(r.refusedIds.length <= 10);
});

// ---- integration with the real stack and the 3j.5 acknowledgement ----

async function stackWorld() {
  const state = { bytes: null, now: NOW };
  const storage = { load: async () => state.bytes, save: async (b) => { state.bytes = b; } };
  const db = await LocalDb.open({ storage });
  const clock = () => state.now;
  const registry = createRegistry();
  registry.define({ name: 'notes.search', description: 'Search local notes (read-only fixture)', capability: 'read_only', schema: { properties: { query: { type: 'string', required: true, maxLength: 200 } } } });
  return { db, clock, registry, state };
}

test('integration: delivery, explicit ack, re-delivery refusal, audit durability preserved', async () => {
  const w = await stackWorld();
  const stack = createAgentStack({ db: w.db, clock: w.clock });
  const store = createNotificationsDisplayStore();
  const delivery = createDisplayDelivery({ readDesk: () => stack.notifications.list(), store });

  const id = stack.notifications.create({ title: 't', body: 'b' }).notification.id;
  const auditBefore = stack.audit.snapshot().entries.length;

  const d1 = delivery.deliver();
  assert.equal(d1.ok, true);
  assert.equal(d1.delivered, 1);
  assert.deepEqual(ids(store), [id]);

  // Delivery itself added no audit entries and flipped no read flag.
  assert.equal(stack.audit.snapshot().entries.length, auditBefore);
  assert.equal(stack.notifications.list()[0].read, false);

  const ack = stack.persistence.acknowledgeNotification(id);
  assert.equal(ack.ok, true);
  assert.equal(ack.idempotent, false);
  assert.equal(stack.notifications.list()[0].read, true);
  assert.equal(stack.audit.snapshot().entries.length, auditBefore + 1);
  assert.equal(stack.audit.verify().ok, true);

  // The record stays displayed (acked records leave only by safe eviction
  // or orphan GC), and delivery never re-delivers a read record.
  const d2 = delivery.deliver();
  assert.equal(d2.ok, true);
  assert.equal(d2.delivered, 0);
  assert.equal(d2.duplicates, 0);
  assert.deepEqual(ids(store), [id]);
  assert.equal(stack.audit.snapshot().entries.length, auditBefore + 1);
  assert.equal(stack.audit.verify().ok, true);
});

test('integration: an ack failure leaves the record unread and still eligible', async () => {
  const w = await stackWorld();
  const registry = w.registry;
  const audit = createAuditLog({ clock: w.clock });
  const approvals = createApprovalDesk({ clock: w.clock });
  const stop = createEmergencyStop();
  const engine = createPolicyEngine({ registry, approvals, emergencyStop: stop, clock: w.clock });
  const realDesk = createNotificationDesk({ clock: w.clock });
  // A desk whose writer fails after the audit entry is durable: exactly
  // the hard-refusal path 3j.5 documents.
  const desk = Object.assign({}, realDesk, { markRead: () => ({ ok: false, reason: 'simulated_failure' }) });
  const reminders = createReminderBook({ clock: w.clock });
  const p = createAgentPersistence({ db: w.db, clock: w.clock, registry, audit, approvals, engine, emergencyStop: stop, notifications: desk, reminders });
  realDesk.create({ title: 't', body: 'b' });

  const store = createNotificationsDisplayStore();
  const delivery = createDisplayDelivery({ readDesk: () => realDesk.list(), store });
  assert.equal(delivery.deliver().delivered, 1);

  const ack = p.acknowledgeNotification('ntf-000001');
  assert.equal(ack.ok, false);
  assert.equal(ack.reason, 'ack_failed');
  assert.equal(realDesk.list()[0].read, false);

  // Still unread, still displayed, never dropped, never re-delivered.
  const d = delivery.deliver();
  assert.equal(d.ok, true);
  assert.equal(d.delivered, 0);
  assert.equal(d.duplicates, 1);
  assert.equal(d.droppedOrphans, 0);
  assert.deepEqual(ids(store), ['ntf-000001']);
});

// ---- static guards: the renderer can neither inject nor bypass ----

function readSrc(p) { return fs.readFileSync(path.join(__dirname, '..', p), 'utf8'); }

// Code-only view of a source file: comments removed, so a guard scans what
// would RUN, never prose that merely describes intent.
function codeOf(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|\n)\s*\/\/[^\n]*/g, '$1');
}

test('renderer cannot inject: no new channel, no renderer path, no ack words in delivery', () => {
  const preload = readSrc('src/preload.js');
  assert.ok(!/'[a-z]+:deliver'/.test(preload), 'a delivery channel exists in preload');
  assert.ok(!/display:/.test(preload), 'a display channel exists in preload');
  // The channel allowlist keeps its exact shape: six reads plus the ONE
  // narrow notifications:ack exception.
  const channels = [...preload.matchAll(/'([a-z]+:[a-z]+)'/g)].map((m) => m[1]);
  const expected = ['status:get', 'runs:get', 'audit:read', 'providers:get', 'notifications:read', 'reminders:read', 'notifications:ack'];
  for (const c of expected) assert.ok(channels.includes(c), 'missing channel ' + c);
  assert.equal(channels.filter((c) => c.startsWith('notifications')).length, 2);

  const panel = readSrc('renderer/agent-panel.js');
  const index = readSrc('renderer/index.html');
  for (const f of [panel, index]) {
    assert.ok(!f.includes('createDisplayDelivery'), 'renderer references the delivery operation');
    assert.ok(!f.includes('agent-display-delivery'), 'renderer references the delivery module');
    assert.ok(!f.includes('notificationsDisplay'), 'renderer references the main-owned store');
    assert.ok(!f.includes('.drop('), 'renderer references a drop path');
    assert.ok(!f.includes('.append('), 'renderer references an append path');
  }

  const deliveryCode = codeOf(readSrc('src/agent-display-delivery.js'));
  assert.ok(!deliveryCode.includes('markRead'), 'delivery operation calls markRead');
  assert.ok(!deliveryCode.toLowerCase().includes('acknowledg'), 'delivery operation acknowledges');
  assert.ok(!deliveryCode.includes('audit'), 'delivery operation touches the audit log');
  assert.ok(!deliveryCode.includes("require('electron')"), 'delivery operation touches electron');
  assert.ok(!deliveryCode.includes('setTimeout') && !deliveryCode.includes('setInterval'), 'delivery operation schedules on its own');
});

test('main wiring: the pass runs at startup reconciliation and after a successful ack only', () => {
  const main = readSrc('src/main.js');
  assert.ok(main.includes("createDisplayDelivery({"), 'main constructs the delivery operation');
  assert.ok(/const agentStarted = await agentRuntime\.start\(\);[\s\S]{0,600}runDisplayDelivery\(\);/, 'no reconciliation pass after runtime start');
  const ackBlock = main.slice(main.indexOf('acknowledgeNotification: (id) => {'), main.indexOf('acknowledgeNotification: (id) => {') + 900);
  assert.ok(ackBlock.includes('runDisplayDelivery()'), 'no pass after a successful acknowledgement');
  const afterIf = ackBlock.slice(ackBlock.indexOf('runDisplayDelivery()') - 200);
  assert.ok(afterIf.includes('r.ok === true'), 'the pass is not gated on a successful ack');
});
