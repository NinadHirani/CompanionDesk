'use strict';

// Gate 2 run entry point (25 Nov 2026): Stage A decision D1, option (a).
// The scheduling gate is the ONLY source of run requests. Every refusal
// path fails closed, the durable user-intent entry is appended BEFORE
// driver.run(), the kind stays 'user' (D-S2 untouched: the scheduled kind
// is never accepted), the production registry stays empty, and the
// renderer has no run-control channel.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const { createRegistry } = require('../src/tool-registry.js');
const { createPolicyEngine } = require('../src/policy-engine.js');
const { createApprovalDesk } = require('../src/approval.js');
const { createEmergencyStop } = require('../src/emergency-stop.js');
const { createAuditLog } = require('../src/audit.js');
const { createOrchestrator } = require('../src/agent-orchestrator.js');
const { createScheduleBook } = require('../src/agent-scheduler.js');
const { createSchedulingTool, SCHEDULING_TOOL_DEFINITION } = require('../src/agent-tool-scheduling.js');
const { createNotificationDesk } = require('../src/agent-notifications.js');
const { createReminderBook } = require('../src/agent-reminders.js');
const { createAgentPersistence } = require('../src/agent-persistence.js');
const { createRunDriver, KINDS } = require('../src/agent-run-driver.js');
const { createRunEntry } = require('../src/agent-run-entry.js');
const LocalDb = require('../src/db');

const NOW = 1_700_000_000_000;
const ARGS = { title: 'Review paper draft', scope: 'reminder', due_at: NOW + 3_600_000 };
const REMINDER_DEF = { name: 'reminders.create', description: 'Create a local reminder record (reversible; nothing is scheduled)', capability: 'reversible_write', schema: { properties: { title: { type: 'string', required: true, maxLength: 120 }, due_at: { type: 'integer', required: true }, notes: { type: 'string', maxLength: 500 } } } };
const PLAN = [{ id: 's1', tool: 'reminders.create', args: { title: 'x', due_at: NOW + 86_400_000 }, run: () => ({ ok: true }) }];

async function world(opts = {}) {
  const state = { bytes: null };
  const storage = { load: async () => state.bytes, save: async (b) => { state.bytes = b; } };
  const db = await LocalDb.open({ storage });
  const registry = createRegistry();
  if (!opts.emptyRegistry) registry.define(REMINDER_DEF);
  const audit = createAuditLog({ clock: () => NOW });
  const approvals = createApprovalDesk({ clock: () => NOW });
  const stop = createEmergencyStop();
  const engine = createPolicyEngine({ registry, approvals, emergencyStop: stop, clock: () => NOW });
  const notifications = createNotificationDesk({ clock: () => NOW });
  const reminders = createReminderBook({ clock: () => NOW });
  const book = createScheduleBook({ clock: () => NOW });
  const p = createAgentPersistence({ db, clock: () => NOW, registry, audit, approvals, engine, emergencyStop: stop, notifications, reminders, schedules: book });
  const loaded = p.load();
  assert.equal(loaded.ok, true, 'world must load clean: ' + JSON.stringify(loaded.problems));
  const orch = createOrchestrator({ engine, approvals, emergencyStop: stop, audit: p.durableAudit(), clock: () => NOW });
  const tool = createSchedulingTool({ book, clock: () => NOW, audit: p.durableAudit() });
  const driver = createRunDriver({ orchestrator: orch, persistence: p, notifications, registry, clock: () => NOW, randomHex: () => 'abc123' });
  const entry = createRunEntry({ driver, book, audit: p.durableAudit() });
  return { db, state, registry, audit: p.durableAudit(), approvals, stop, engine, notifications, book, p, orch, tool, driver, entry };
}

function noRunStarted(w) {
  const entries = w.audit.snapshot().entries;
  assert.equal(entries.some((e) => e.action === 'run.started'), false, 'no run.started');
  assert.equal(w.p.listRuns().length, 0, 'no ledger row');
  return entries;
}

test('construction fails closed without a driver, book or durable audit', async () => {
  const w = await world();
  assert.throws(() => createRunEntry({}), /run driver/);
  assert.throws(() => createRunEntry({ driver: w.driver }), /schedule book/);
  assert.throws(() => createRunEntry({ driver: w.driver, book: w.book }), /durable audit/);
  assert.throws(() => createRunEntry({ driver: w.driver, book: w.book, audit: { append: () => ({ ok: true }) } }), /durable audit/);
});

test('arg and kind refusals: only the user kind ever leaves the entry', async () => {
  const w = await world();
  const created = w.tool.execute(ARGS);
  assert.equal(created.ok, true);
  const sid = created.schedule.id;
  assert.equal(w.entry.requestRun(null).reason, 'args_invalid');
  assert.equal(w.entry.requestRun({}).reason, 'args_invalid');
  assert.equal(w.entry.requestRun({ scheduleId: sid }).reason, 'args_invalid', 'no plan');
  assert.equal(w.entry.requestRun({ scheduleId: sid, plan: [] }).reason, 'args_invalid');
  assert.equal(w.entry.requestRun({ scheduleId: sid, plan: [{ id: 's', tool: 't', args: {} }] }).reason, 'args_invalid', 'step without run');
  assert.equal(w.entry.requestRun({ scheduleId: sid, plan: PLAN, kind: 'scheduled' }).reason, 'kind_refused');
  assert.equal(w.entry.requestRun({ scheduleId: sid, plan: PLAN, kind: 'agent' }).reason, 'kind_refused');
  const entries = noRunStarted(w);
  assert.equal(entries.filter((e) => e.action === 'run.request').length, 0, 'no intent entry for a refusal');
});

test('unknown and cancelled schedules are refused', async () => {
  const w = await world();
  assert.equal(w.entry.requestRun({ scheduleId: 'sch-999999', plan: PLAN }).reason, 'schedule_unknown');
  const created = w.tool.execute(ARGS);
  assert.equal(created.ok, true);
  const c = w.book.cancel(created.schedule.id);
  assert.equal(c.ok, true, 'cancel works: ' + JSON.stringify(c));
  assert.equal(w.entry.requestRun({ scheduleId: created.schedule.id, plan: PLAN }).reason, 'schedule_cancelled');
  const entries = noRunStarted(w);
  assert.equal(entries.filter((e) => e.action === 'run.request').length, 0, 'no intent entry for a cancelled schedule');
});

test('a product-surface schedule can never start a run: no schedule.create entry, no run', async () => {
  const w = await world();
  const direct = w.book.create({ title: 'User-made', scope: 'reminder', dueAt: NOW + 3_600_000 });
  assert.equal(direct.ok, true);
  const r = w.entry.requestRun({ scheduleId: direct.schedule.id, plan: PLAN });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'origin_unverified');
  const entries = noRunStarted(w);
  assert.equal(entries.some((e) => e.action === 'run.request'), false, 'no intent entry without origin');
});

test('a schedule whose creation audit never landed is refused (the approved audit_append_failed mode)', async () => {
  const w = await world();
  const silent = { append: () => ({ ok: false, reason: 'persist_failure' }) };
  const tool2 = createSchedulingTool({ book: w.book, clock: () => NOW, audit: silent });
  const r = tool2.execute(ARGS);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'audit_append_failed');
  const rec = w.book.list().find((s) => s.title === ARGS.title);
  assert.ok(rec, 'the created schedule stays visible in the book');
  const out = w.entry.requestRun({ scheduleId: rec.id, plan: PLAN });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'origin_unverified');
  noRunStarted(w);
});

test('the only lawful run: scheduling-gate origin, intent entry precedes startRun, kind user', async () => {
  const w = await world();
  w.engine.grantTool({ tool: 'reminders.create', ttlMs: 60_000 });
  const created = w.tool.execute(ARGS);
  assert.equal(created.ok, true);
  const res = w.entry.requestRun({ scheduleId: created.schedule.id, plan: PLAN, goal: 'Prep the draft' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.kind, 'user');
  assert.equal(res.scheduleId, created.schedule.id);
  const entries = w.audit.snapshot().entries;
  const iCreate = entries.findIndex((e) => e.action === 'schedule.create');
  const iIntent = entries.findIndex((e) => e.action === 'run.request');
  const iStart = entries.findIndex((e) => e.action === 'run.started');
  assert.ok(iCreate !== -1 && iIntent !== -1 && iStart !== -1, 'all three entries exist');
  assert.ok(iCreate < iIntent && iIntent < iStart, 'origin, then intent, then start');
  const intent = entries[iIntent];
  assert.equal(intent.actor, 'user');
  assert.equal(intent.detail.schedule_id, created.schedule.id);
  assert.equal(intent.detail.source, 'scheduling_gate');
  const rows = w.p.listRuns();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'user');
});

test('an intent-append failure refuses the run before anything starts', async () => {
  const w = await world();
  const created = w.tool.execute(ARGS);
  assert.equal(created.ok, true);
  const real = w.p.durableAudit();
  const refusing = {
    append: (e) => (e.action === 'run.request' ? { ok: false, reason: 'persist_failure' } : real.append(e)),
    snapshot: () => real.snapshot(),
  };
  const entry2 = createRunEntry({ driver: w.driver, book: w.book, audit: refusing });
  const res = entry2.requestRun({ scheduleId: created.schedule.id, plan: PLAN });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'intent_audit_failed');
  noRunStarted(w);
});

test('with the production registry empty, a request still cannot execute', async () => {
  const w = await world({ emptyRegistry: true });
  const created = w.tool.execute(ARGS);
  assert.equal(created.ok, true);
  const res = w.entry.requestRun({ scheduleId: created.schedule.id, plan: PLAN });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'plan_tool_unknown');
  const entries = noRunStarted(w);
  assert.equal(entries.filter((e) => e.action === 'run.request').length, 1, 'the attempt itself is audited');
});

test('D-S2 stays untouched: the driver kind allowlist is exactly user', async () => {
  const w = await world();
  assert.deepEqual(KINDS, ['user']);
  const bad = w.driver.run({ goal: 'g', kind: 'scheduled', plan: PLAN });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'kind_invalid');
});

test('static guards: the entry module is pure, channel-free and never names the scheduled kind', () => {
  const src = fs.readFileSync('src/agent-run-entry.js', 'utf8');
  assert.equal(/require\(/.test(src), false, 'no requires');
  assert.equal(/setTimeout|setInterval/.test(src), false, 'no timers');
  assert.equal(/'scheduled'/.test(src), false, 'the scheduled kind is never named in code');
  assert.equal(/ipcRenderer|webContents|'agent:|'runs:|'run:/.test(src), false, 'no renderer channels');
  assert.equal(/child_process|\bnet\b|\bhttp\b/.test(src), false, 'no process or network');
});

test('wiring: main constructs the entry from the stack book and durable audit, and registers nothing', () => {
  const src = fs.readFileSync('src/main.js', 'utf8');
  assert.ok(src.includes("require('./agent-run-entry')"), 'main requires the entry module');
  assert.ok(src.includes('createRunEntry({'), 'main constructs the entry');
  assert.ok(src.includes('book: stack.schedules'), 'the entry rides the stack schedule book');
  assert.ok(src.includes('audit: stack.persistence.durableAudit()'), 'the entry writes through the durable audit');
  // Gate 2 enable step (26 Nov 2026, approved by Ninad), widened by the
  // Gate 4 approval (26 Nov), the AI-access connector flow (27 Nov) and
  // the file-output enable (28 Nov 2026, approved by Ninad): main carries
  // EXACTLY FOUR registration literals, nothing else. The run-entry still
  // registers nothing itself.
  const mainDefines = src.split('.define(').length - 1;
  assert.equal(mainDefines, 4, 'exactly four registration literals, got ' + mainDefines);
  assert.ok(src.includes('agentRegistry.define(SCHEDULING_TOOL_DEFINITION)'), 'the enable registers the scheduling gate definition');
  assert.ok(src.includes('agentRegistry.define(FILE_ACCESS_TOOL_DEFINITION)'), 'the enable registers the file-access gate definition');
  assert.ok(src.includes('agentRegistry.define(CONNECTORS_TOOL_DEFINITION)'), 'the connector status/request tool is the third registration');
  assert.ok(src.includes('agentRegistry.define(FILE_OUTPUT_TOOL_DEFINITION)'), 'the file-output tool is the fourth registration');
});
