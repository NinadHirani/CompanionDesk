'use strict';

// Gate 2 enable step (26 Nov 2026, approved by Ninad in the decision-sheet
// review), widened by the Gate 4 approval (26 Nov), the connector flow
// (27 Nov) and the file-output enable (28 Nov 2026, approved by Ninad):
// main.js carries EXACTLY FIVE registration literals - schedule_create,
// file_access, the connector status/request tool, file_write, and the
// Stage B calendar_upcoming read-only projection (enabled 28 Nov 2026).
// Registration alone lets no run start:
// requestRun still has no caller in this build (D1/D-S2 unchanged), tools
// execute only inside driver-driven runs, and every registered tool is sensitive, so
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
const { CONNECTORS_TOOL_DEFINITION } = require('../src/agent-tool-connectors.js');
const { FILE_OUTPUT_TOOL_DEFINITION, createFileOutputTool } = require('../src/agent-tool-file-output.js');
const { CALENDAR_UPCOMING_DEF } = require('../src/agent-tool-calendar.js');
const { createRunDriver, KINDS } = require('../src/agent-run-driver.js');

const NOW = 1_700_000_000_000;

async function enabledStack() {
  const state = { bytes: null };
  const storage = { load: async () => state.bytes, save: async (b) => { state.bytes = b; } };
  const db = await LocalDb.open({ storage });
  const stack = createAgentStack({ db, clock: () => NOW });
  const loaded = stack.persistence.load();
  assert.equal(loaded.ok, true, 'world must load clean: ' + JSON.stringify(loaded.problems));
  // The four registration literals, exactly as main.js performs them
  // (the connector flow, 27 Nov 2026; the file-output enable, 28 Nov 2026).
  // 28 Nov 2026 (item 9 fixed under Ninad's standing authorization): the
  // connectors definition now registers cleanly, so all four definitions
  // below join the runtime registry.
  stack.registry.define(SCHEDULING_TOOL_DEFINITION);
  stack.registry.define(FILE_ACCESS_TOOL_DEFINITION);
  stack.registry.define(CONNECTORS_TOOL_DEFINITION);
  stack.registry.define(FILE_OUTPUT_TOOL_DEFINITION);
  stack.registry.define(CALENDAR_UPCOMING_DEF);
  const tool = createSchedulingTool({ book: stack.schedules, clock: () => NOW, audit: stack.durableAudit });
  return { db, stack, tool };
}

test('the enable registers exactly five tools in main and nothing else fires', () => {
  const main = fs.readFileSync('src/main.js', 'utf8');
  const defines = main.split('.define(').length - 1;
  assert.equal(defines, 5, 'exactly five registration literals, got ' + defines);
  // The registry must be assigned BEFORE the first define: the enable
  // block previously read agentRegistry before assigning it, so the first
  // boot threw inside buildAgent and the agent runtime stayed blocked.
  assert.ok(main.indexOf('agentRegistry = stack.registry;') < main.indexOf('agentRegistry.define(SCHEDULING_TOOL_DEFINITION)'), 'the registry is assigned before the defines');
  assert.ok(main.includes('agentRegistry.define(SCHEDULING_TOOL_DEFINITION)'), 'it registers the scheduling gate definition');
  assert.ok(main.includes('agentRegistry.define(FILE_ACCESS_TOOL_DEFINITION)'), 'it registers the file-access gate definition');
  assert.ok(main.includes('agentRegistry.define(CONNECTORS_TOOL_DEFINITION)'), 'it registers the connector status/request tool');
  assert.ok(main.includes('agentRegistry.define(FILE_OUTPUT_TOOL_DEFINITION)'), 'it registers the file-output definition');
  assert.ok(main.includes("require('./agent-tool-file-output')"), 'main requires the file-output module');
  assert.ok(main.includes('agentRegistry.define(CALENDAR_UPCOMING_DEF)'), 'it registers the Stage B calendar projection definition');
  assert.ok(main.includes("require('./agent-tool-calendar')"), 'main requires the calendar tool module');
  assert.ok(main.includes("require('./agent-tool-connectors')"), 'main requires the connector tool module');
  assert.ok(main.includes("require('./agent-tool-scheduling')"), 'main requires the tool module');
  assert.ok(main.includes("require('./agent-tool-file-access')"), 'main requires the file-access module');
  const strip = (t) => t.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.equal(strip(main).includes('requestRun('), false, 'no executable call site of requestRun in main');
  const preload = fs.readFileSync('src/preload.js', 'utf8');
  assert.equal(preload.includes('schedule_create'), false, 'the renderer never sees the tool');
  assert.equal(preload.includes('run-driver'), false);
  assert.deepEqual(KINDS, ['user'], "the driver's kind allowlist stays ['user']");
});

test('the enabled registry carries exactly five tools with their approved classes', async () => {
  const { stack } = await enabledStack();
  const list = stack.registry.list();
  assert.equal(list.length, 5);
  assert.equal(list[0].name, 'schedule_create');
  assert.equal(list[0].capability, 'sensitive');
  assert.equal(list[0].critical, false);
  assert.equal(list[1].name, 'file_access');
  assert.equal(list[1].capability, 'sensitive');
  assert.equal(list[1].critical, false);
  assert.equal(list[2].name, 'connector_status');
  assert.equal(list[2].capability, 'reversible_write');
  assert.equal(list[2].critical, false);
  assert.equal(list[3].name, 'file_write');
  assert.equal(list[3].capability, 'sensitive');
  assert.equal(list[3].critical, false);
  assert.equal(list[4].name, 'calendar_upcoming');
  assert.equal(list[4].capability, 'read_only');
  assert.equal(list[4].critical, false);
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

test('Stage B calendar_upcoming is registered read_only (Stage B enable, 28 Nov 2026)', async () => {
  const { stack } = await enabledStack();
  assert.equal(stack.registry.has('calendar_upcoming'), true);
  assert.equal(stack.registry.get('calendar_upcoming').capability, 'read_only');
  assert.equal(stack.registry.list().length, 5);
});

// --- file-output enable (28 Nov 2026) ---------------------------------------

function stubFileIo() {
  const files = new Map();
  return {
    files,
    exists: (p) => files.has(p),
    realpath: (p) => p,
    writeFileAtomic: (p, c) => { files.set(p, c); },
  };
}

const FILE_ARGS = { name: 'summary.md', content: '# Summary\n\nAll quiet.' };

test('file_write refuses every call while the root is unconfigured, grant and approval notwithstanding', async () => {
  const { stack } = await enabledStack();
  const tool = createFileOutputTool({ clock: () => NOW, io: stubFileIo(), audit: stack.durableAudit, root: undefined });
  assert.equal(stack.engine.grantTool({ tool: 'file_write' }).ok, true);
  const denied = stack.engine.authorize({ tool: 'file_write', args: FILE_ARGS });
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, 'approval_required');
  const approval = stack.approvals.request({ tool: 'file_write', args: FILE_ARGS }).approval;
  assert.equal(stack.engine.authorize({ tool: 'file_write', args: FILE_ARGS, approvalId: approval.id }).allowed, true);
  const r = tool.execute(FILE_ARGS);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'file_output_root_unconfigured');
});

test('the full approval path writes exactly one file; a repeat is refused until renamed', async () => {
  const { stack } = await enabledStack();
  const io = stubFileIo();
  const ROOT = '/Users/ninad/CompanionDeskExports';
  const tool = createFileOutputTool({ clock: () => NOW, io, audit: stack.durableAudit, root: ROOT });
  assert.equal(stack.engine.grantTool({ tool: 'file_write' }).ok, true);
  const driver = createRunDriver({
    orchestrator: stack.orchestrator,
    persistence: stack.persistence,
    notifications: stack.notifications,
    registry: stack.registry,
    clock: () => NOW,
    randomHex: () => 'abc123',
  });
  const r = driver.run({
    goal: 'write a summary file',
    kind: 'user',
    plan: [{ id: 'write', tool: 'file_write', args: FILE_ARGS, needsApproval: true, run: (a) => tool.execute(a) }],
  });
  assert.equal(r.ok, true);
  assert.equal(r.state, 'awaiting_approval');
  assert.equal(io.files.size, 0, 'nothing written before the approval');
  const approval = stack.approvals.request({ tool: 'file_write', args: FILE_ARGS }).approval;
  const rr = driver.resume(r.runId, { approvalId: approval.id });
  assert.equal(rr.ok, true, JSON.stringify(rr));
  assert.equal(rr.state, 'completed');
  assert.deepEqual([...io.files.keys()], [ROOT + '/' + FILE_ARGS.name]);
  assert.equal(io.files.get(ROOT + '/' + FILE_ARGS.name), FILE_ARGS.content);
  const entries = stack.audit.read({}).filter((e) => e.action === 'file.write');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].tool, 'file_write');
  assert.equal(entries[0].detail.name, FILE_ARGS.name);
  assert.equal(entries[0].detail.bytes, Buffer.byteLength(FILE_ARGS.content, 'utf8'));
  // Refuse-if-exists: the same step retried needs a fresh approval AND a
  // different name; the first file is never overwritten.
  const again = tool.execute(FILE_ARGS);
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'file_exists');
  const renamed = { name: 'summary-2.md', content: FILE_ARGS.content };
  const approval2 = stack.approvals.request({ tool: 'file_write', args: renamed }).approval;
  assert.equal(stack.engine.authorize({ tool: 'file_write', args: renamed, approvalId: approval2.id }).allowed, true);
  assert.equal(tool.execute(renamed).ok, true);
  assert.equal(io.files.size, 2);
});
