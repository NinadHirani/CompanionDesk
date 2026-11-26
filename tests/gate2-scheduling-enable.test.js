'use strict';

// Gate 2 enable step (26 Nov 2026, approved by Ninad in the decision-sheet
// review), widened the same day by the Gate 4 approval: the production
// registry carries EXACTLY TWO tools, the scheduling gate's schedule_create
// and the file-access gate's file_access (registration mirrors the
// schedule_create enable step). Registration alone lets no run start:
// requestRun still has no caller in this build (D1/D-S2 unchanged), tools
// execute only inside driver-driven runs, and both tools are sensitive, so
// a fresh one-time approval is required for every call - a standing grant
// can never authorize either. The renderer sees nothing new; delivery stays
// opt-in (proactive_enabled default false); the 'scheduled' run kind stays
// refused (D-S2 deferred).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const { createAgentStack } = require('../src/agent-runtime.js');
const LocalDb = require('../src/db.js');
const { SCHEDULING_TOOL_DEFINITION, createSchedulingTool, MAX_HORIZON_MS } = require('../src/agent-tool-scheduling.js');
const { FILE_ACCESS_TOOL_DEFINITION, createFileAccessTool } = require('../src/agent-tool-file-access.js');
const { createRunDriver, KINDS } = require('../src/agent-run-driver.js');

const NOW = 1_700_000_000_000;

async function enabledStack() {
  const state = { bytes: null };
  const storage = { load: async () => state.bytes, save: async (b) => { state.bytes = b; } };
  const db = await LocalDb.open({ storage });
  const stack = createAgentStack({ db, clock: () => NOW });
  const loaded = stack.persistence.load();
  assert.equal(loaded.ok, true, 'world must load clean: ' + JSON.stringify(loaded.problems));
  // The two registration literals, exactly as main.js performs them.
  stack.registry.define(SCHEDULING_TOOL_DEFINITION);
  stack.registry.define(FILE_ACCESS_TOOL_DEFINITION);
  const tool = createSchedulingTool({ book: stack.schedules, clock: () => NOW, audit: stack.durableAudit });
  return { db, stack, tool };
}

test('the enable registers exactly two tools in main and nothing else fires', () => {
  const main = fs.readFileSync('src/main.js', 'utf8');
  const defines = main.split('.define(').length - 1;
  assert.equal(defines, 2, 'exactly two registration literals, got ' + defines);
  assert.ok(main.includes('agentRegistry.define(SCHEDULING_TOOL_DEFINITION)'), 'it registers the scheduling gate definition');
  assert.ok(main.includes('agentRegistry.define(FILE_ACCESS_TOOL_DEFINITION)'), 'it registers the file-access gate definition');
  assert.ok(main.includes("require('./agent-tool-scheduling')"), 'main requires the tool module');
  assert.ok(main.includes("require('./agent-tool-file-access')"), 'main requires the file-access module');
  const strip = (t) => t.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.equal(strip(main).includes('requestRun('), false, 'no executable call site of requestRun in main');
  const preload = fs.readFileSync('src/preload.js', 'utf8');
  assert.equal(preload.includes('schedule_create'), false, 'the renderer never sees the tool');
  assert.equal(preload.includes('run-driver'), false);
  assert.deepEqual(KINDS, ['user'], "the driver's kind allowlist stays ['user']");
});

test('the enabled registry carries exactly two tools, both sensitive and non-critical', async () => {
  const { stack } = await enabledStack();
  const list = stack.registry.list();
  assert.equal(list.length, 2);
  assert.equal(list[0].name, 'schedule_create');
  assert.equal(list[0].capability, 'sensitive');
  assert.equal(list[0].critical, false);
  assert.equal(list[1].name, 'file_access');
  assert.equal(list[1].capability, 'sensitive');
  assert.equal(list[1].critical, false);
});

test('a standing grant can never authorize it; only a fresh one-time approval can', async () => {
  const { stack } = await enabledStack();
  assert.equal(stack.engine.grantTool({ tool: 'schedule_create' }).ok, true);
  const args = { title: 'Stretch', scope: 'reminder', due_at: NOW + 3_600_000 };
  const denied = stack.engine.authorize({ tool: 'schedule_create', args });
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, 'approval_required');
  const approval = stack.approvals.request({ tool: 'schedule_create', args }).approval;
  const ok = stack.engine.authorize({ tool: 'schedule_create', args, approvalId: approval.id });
  assert.equal(ok.allowed, true);
});

test('the full approval path creates exactly one real schedule through the driver', async () => {
  const { stack, tool } = await enabledStack();
  // Both halves of the sensitive gate: the standing grant admits the tool
  // to the run at all; the fresh one-time approval is still required per
  // call and is what actually authorizes the create.
  assert.equal(stack.engine.grantTool({ tool: 'schedule_create' }).ok, true);
  const args = { title: 'Water plants', scope: 'reminder', due_at: NOW + 7_200_000 };
  const driver = createRunDriver({
    orchestrator: stack.orchestrator,
    persistence: stack.persistence,
    notifications: stack.notifications,
    registry: stack.registry,
    clock: () => NOW,
    randomHex: () => 'abc123',
  });
  const r = driver.run({
    goal: 'create a reminder',
    kind: 'user',
    plan: [{ id: 'sched', tool: 'schedule_create', args, needsApproval: true, run: (a) => tool.execute(a) }],
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.state, 'awaiting_approval');
  assert.equal(stack.schedules.list().length, 0, 'nothing created before the approval');
  const approval = stack.approvals.request({ tool: 'schedule_create', args }).approval;
  const rr = driver.resume(r.runId, { approvalId: approval.id });
  assert.equal(rr.ok, true, JSON.stringify(rr));
  assert.equal(rr.state, 'completed');
  const rows = stack.schedules.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'Water plants');
  assert.equal(rows[0].scope, 'reminder');
  assert.equal(rows[0].dueAt, args.due_at);
  const scheduleEntries = stack.audit.read({}).filter((e) => e.action === 'schedule.create');
  assert.equal(scheduleEntries.length, 1);
  assert.equal(scheduleEntries[0].detail.schedule_id, rows[0].id);
  assert.equal(scheduleEntries[0].tool, 'schedule_create');
  const ledger = stack.persistence.listRuns();
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].status, 'succeeded');
  assert.equal(stack.notifications.list().length, 1, 'only the run terminal notification: delivery stays opt-in');
  assert.equal(stack.notifications.list()[0].title, 'Agent run completed');
});

test('an exact duplicate is refused and creates nothing', async () => {
  const { stack, tool } = await enabledStack();
  const args = { title: 'Water plants', scope: 'reminder', due_at: NOW + 7_200_000 };
  assert.equal(tool.execute(args).ok, true);
  const again = tool.execute(args);
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'duplicate_schedule');
  assert.equal(stack.schedules.list().length, 1);
});

test('scope and horizon refusals stay in force', async () => {
  const { stack, tool } = await enabledStack();
  assert.equal(stack.registry.validateArgs('schedule_create', { title: 'x', scope: 'deadline', due_at: NOW + 1 }).ok, false);
  assert.equal(tool.execute({ title: 'x', scope: 'deadline', due_at: NOW + 1 }).reason, 'scope_deadline_refused');
  assert.equal(tool.execute({ title: 'x', scope: 'reminder', due_at: NOW - 1 }).reason, 'due_at_past');
  assert.equal(tool.execute({ title: 'x', scope: 'reminder', due_at: NOW + MAX_HORIZON_MS + 1 }).reason, 'due_at_too_far');
});

test('Stage B tools stay unregistered: the enable covers only schedule_create and file_access', async () => {
  const { stack } = await enabledStack();
  assert.equal(stack.registry.has('calendar_upcoming'), false);
  assert.equal(stack.registry.list().length, 2);
});
