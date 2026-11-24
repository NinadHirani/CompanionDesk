'use strict';

// Gate 2 slice 4: the first harmless tools, end to end. Registers the
// notifications, reminders and ics tools in the real tool registry, runs
// them through the real policy engine and orchestrator, and proves the
// capability boundary design: these tools are read_only or reversible_write,
// so a standing grant suffices and NO per-call approval is ever required;
// nothing here can reach the shell, filesystem, browser or OS, and nothing
// is model-driven. Still NO product wiring: no UI, no IPC, no OS calls.

const test = require('node:test');
const assert = require('node:assert');
const { createRegistry, validateDefinition } = require('../src/tool-registry.js');
const { createPolicyEngine } = require('../src/policy-engine.js');
const { createApprovalDesk } = require('../src/approval.js');
const { createEmergencyStop } = require('../src/emergency-stop.js');
const { createAuditLog } = require('../src/audit.js');
const { createOrchestrator } = require('../src/agent-orchestrator.js');
const { createNotificationDesk } = require('../src/agent-notifications.js');
const { createReminderBook } = require('../src/agent-reminders.js');
const { createIcsGenerator } = require('../src/agent-ics.js');

const NOW = 1_700_000_000_000;

function definitions() {
  return [
    { name: 'notifications.create', description: 'Create a local notification record (reversible; nothing is delivered)', capability: 'reversible_write', schema: { properties: { title: { type: 'string', required: true, maxLength: 120 }, body: { type: 'string', required: true, maxLength: 500 }, priority: { type: 'string', maxLength: 8 } } } },
    { name: 'reminders.create', description: 'Create a local reminder record (reversible; nothing is scheduled)', capability: 'reversible_write', schema: { properties: { title: { type: 'string', required: true, maxLength: 120 }, due_at: { type: 'integer', required: true }, notes: { type: 'string', maxLength: 500 } } } },
    { name: 'reminders.cancel', description: 'Cancel a local reminder record (reversible)', capability: 'reversible_write', schema: { properties: { id: { type: 'string', required: true, maxLength: 16 } } } },
    { name: 'ics.generate', description: 'Generate iCalendar text for one event (pure string output)', capability: 'read_only', schema: { properties: { summary: { type: 'string', required: true, maxLength: 200 }, start: { type: 'string', required: true, maxLength: 20 }, duration_minutes: { type: 'integer', maxLength: 4 } } } },
  ];
}

function world() {
  const registry = createRegistry();
  for (const def of definitions()) {
    const v = validateDefinition(def);
    assert.deepEqual(v, [], 'definition must be valid: ' + JSON.stringify(v));
    registry.define(def);
  }
  const audit = createAuditLog({ clock: () => NOW });
  const approvals = createApprovalDesk({ clock: () => NOW });
  const stop = createEmergencyStop();
  const engine = createPolicyEngine({ registry, approvals, emergencyStop: stop, clock: () => NOW });
  const notifications = createNotificationDesk({ clock: () => NOW });
  const reminders = createReminderBook({ clock: () => NOW });
  const ics = createIcsGenerator({ clock: () => NOW });
  const orch = createOrchestrator({ engine, approvals, emergencyStop: stop, audit, clock: () => NOW });
  return { registry, audit, approvals, stop, engine, orch, notifications, reminders, ics };
}

const PROBE_ARGS = {
  'notifications.create': { title: 't', body: 'b' },
  'reminders.create': { title: 't', due_at: NOW + 1000 },
  'reminders.cancel': { id: 'rem-000001' },
  'ics.generate': { summary: 't', start: '2026-12-01T10:00:00Z', duration_minutes: 30 },
};

test('all four harmless tools validate and carry the intended capability classes', () => {
  const w = world();
  for (const def of definitions()) {
    const d = w.registry.get(def.name);
    assert.notEqual(d, null, def.name + ' is registered');
    assert.equal(d.capability, def.capability);
    assert.notEqual(def.capability, 'sensitive', 'no harmless tool is sensitive');
    assert.notEqual(def.capability, 'forbidden');
  }
});

test('a standing grant suffices; no per-call approval is ever requested', () => {
  const w = world();
  for (const def of definitions()) {
    // No grant yet: denied even with valid args.
    assert.equal(w.engine.authorize({ tool: def.name, args: PROBE_ARGS[def.name] }).allowed, false, def.name + ' is denied without a grant');
    // With a grant: allowed WITHOUT any approvalId.
    assert.equal(w.engine.grantTool({ tool: def.name, ttlMs: 60_000 }).ok, true);
    assert.equal(w.engine.authorize({ tool: def.name, args: PROBE_ARGS[def.name] }).allowed, true, def.name + ' needs no per-call approval');
  }
});

test('a full harmless run through the orchestrator creates real records', () => {
  const w = world();
  for (const def of definitions()) w.engine.grantTool({ tool: def.name, ttlMs: 60_000 });
  let icsText = null;
  const started = w.orch.startRun({
    runId: 'r1',
    goal: 'set up a reminder and its calendar entry',
    plan: [
      { id: 'remind', tool: 'reminders.create', args: { title: 'Paper deadline', due_at: NOW + 3_600_000 }, run: (args) => w.reminders.create({ title: args.title, dueAt: args.due_at, notes: args.notes }) },
      { id: 'note', tool: 'notifications.create', args: { title: 'Deadline set', body: 'A reminder was created' }, run: (args) => w.notifications.create(args) },
      { id: 'invite', tool: 'ics.generate', args: { summary: 'Paper deadline prep', start: '2026-12-01T10:00:00Z', duration_minutes: 60 }, run: (args) => { const r = w.ics.generateEvent({ summary: args.summary, start: args.start, durationMinutes: args.duration_minutes }); if (r.ok) icsText = r.ics; return { ok: r.ok, summary: r.ok ? 'generated' : null }; } },
    ],
  });
  assert.equal(started.ok, true, JSON.stringify(started));
  const s1 = w.orch.step('r1');
  assert.equal(s1.ok, true, JSON.stringify(s1));
  assert.equal(w.reminders.count(), 1, 'the reminder record exists');
  const s2 = w.orch.step('r1');
  assert.equal(s2.ok, true, JSON.stringify(s2));
  assert.equal(w.notifications.count(), 1, 'the notification record exists');
  const s3 = w.orch.step('r1');
  assert.equal(s3.ok, true, JSON.stringify(s3));
  const done = w.orch.step('r1');
  assert.equal(done.state, 'completed');
  assert.notEqual(icsText, null, 'the ics tool produced text');
  assert.ok(icsText.startsWith('BEGIN:VCALENDAR'));
  assert.deepEqual(w.audit.snapshot().entries.map((e) => e.action), [
    'run.started', 'run.step_started', 'run.step_succeeded',
    'run.step_started', 'run.step_succeeded',
    'run.step_started', 'run.step_succeeded', 'run.completed',
  ]);
});

test('an invalid tool call fails closed inside the run and never stores a bad record', () => {
  const w = world();
  for (const def of definitions()) w.engine.grantTool({ tool: def.name, ttlMs: 60_000 });
  w.orch.startRun({
    runId: 'r1',
    plan: [
      { id: 'bad', tool: 'reminders.create', args: { title: 'x', due_at: NOW - 1000 }, run: (args) => w.reminders.create({ title: args.title, dueAt: args.due_at }), recovery: 'skip' },
      { id: 'good', tool: 'notifications.create', args: { title: 'ok', body: 'still here' }, run: (args) => w.notifications.create(args) },
    ],
  });
  // With retries 0 and recovery skip, the failed step is skipped in the
  // same step() call that observes the refusal.
  const s1 = w.orch.step('r1');
  assert.equal(s1.skipped, true, 'a tool-level refusal is a failed step, skipped');
  assert.equal(w.reminders.count(), 0, 'no bad record was stored');
  const s2 = w.orch.step('r1');
  assert.equal(s2.ok, true, 'the good step still runs');
  assert.equal(w.notifications.count(), 1);
  const s3 = w.orch.step('r1');
  assert.equal(s3.state, 'completed');
});
