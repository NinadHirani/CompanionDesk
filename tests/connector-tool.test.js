'use strict';

// Gate 2 AI-access connector flow (Ninad's decision, 27 Nov 2026): the
// agent-facing tool. It reads states and raises user-facing connect
// requests; it never connects, never grants, never touches credentials.

const test = require('node:test');
const assert = require('node:assert');
const cc = require('../src/connectors.js');
const cr = require('../src/connector-requests.js');
const { CONNECTORS_TOOL_DEFINITION, createConnectorsTool } = require('../src/agent-tool-connectors.js');

function stack() {
  const catalog = cc.createConnectorCatalog({ clock: () => 1 });
  const requests = cr.createConnectorRequestCenter({ clock: () => 2, exists: (id) => !!catalog.describe(id) });
  const tool = createConnectorsTool({ catalog, requests });
  return { catalog, requests, tool };
}

function stackWithEngine(engine, adapters) {
  const catalog = cc.createConnectorCatalog({ clock: () => 1 });
  const requests = cr.createConnectorRequestCenter({ clock: () => 2, exists: (id) => !!catalog.describe(id) });
  const tool = createConnectorsTool({ catalog, requests, engine, adapters });
  return { catalog, requests, tool };
}

function fakeEngine(response) {
  const runs = [];
  return {
    runs,
    run: async function (id, actionId, params, runOpts) {
      runs.push({ id, actionId, params, runOpts });
      return typeof response === 'function' ? response(id, actionId, params) : response;
    },
  };
}

test('the definition exists, is ordinary capability and names no credential field', () => {
  assert.equal(CONNECTORS_TOOL_DEFINITION.name, 'connector_status');
  assert.equal(CONNECTORS_TOOL_DEFINITION.capability, 'ordinary');
  assert.equal(CONNECTORS_TOOL_DEFINITION.critical, false);
  const fields = Object.keys(CONNECTORS_TOOL_DEFINITION.schema.properties);
  assert.deepEqual(fields, ['action', 'connector_id', 'action_id', 'params', 'reason']);
  const blob = JSON.stringify(CONNECTORS_TOOL_DEFINITION);
  assert.equal(/keychain:|vault:|credential-store:/i.test(blob), false, 'no credential material in the definition');
});

test('list returns the catalog with live states and the open requests', async () => {
  const s = stack();
  s.requests.request('rss', { reason: 'needs feeds' });
  const out = await s.tool.execute({ action: 'list' });
  assert.equal(out.ok, true);
  assert.equal(out.connectors.length, 183, 'the shipped catalog (20 legacy + 13 curated popular providers + 149 expanded breadth tier + microsoft-calendar)');
  assert.equal(out.connectors.find((c) => c.id === 'rss').state, 'discovered');
  assert.equal(out.requests.length, 1);
});

test('request_connect raises a pending user-facing request and never changes a connection state', async () => {
  const s = stack();
  const out = await s.tool.execute({ action: 'request_connect', connector_id: 'ollama', reason: 'a local model would answer offline' });
  assert.equal(out.ok, true);
  assert.equal(out.state, 'pending');
  assert.equal(s.catalog.state('ollama'), 'discovered', 'nothing connected by a request');
  assert.equal(s.requests.list()[0].reason, 'a local model would answer offline');
});

test('request_connect refusals surface verbatim and create nothing', async () => {
  const s = stack();
  const bad = await s.tool.execute({ action: 'request_connect', connector_id: 'not-real', reason: 'x' });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'unknown_connector');
  const noReason = await s.tool.execute({ action: 'request_connect', connector_id: 'rss' });
  assert.equal(noReason.ok, false);
  assert.equal(noReason.reason, 'reason_required_1_280');
  assert.equal(s.requests.list().length, 0);
});

test('the tool executes only its two actions and refuses everything else', async () => {
  const s = stack();
  assert.equal((await s.tool.execute({})).reason, 'unknown_action');
  assert.equal((await s.tool.execute({ action: 'connect' })).reason, 'unknown_action', 'there is no connect action');
  assert.equal((await s.tool.execute(null)).reason, 'bad_request');
  assert.equal((await s.tool.execute({ action: 'list', extra: 'x' })).ok, true, 'list is tolerant of extra fields');
});

test('a request the user approved still leaves every connector undiscovered', async () => {
  const s = stack();
  const r = await s.tool.execute({ action: 'request_connect', connector_id: 'github', reason: 'repo read for a task' });
  assert.equal(s.requests.resolve(r.requestId, { userInitiated: true, decision: 'approved' }).ok, true);
  for (const e of s.catalog.list()) assert.equal(s.catalog.state(e.id), 'discovered', e.id + ' stays disconnected');
  const out = await s.tool.execute({ action: 'list' });
  assert.equal(out.requests.find((x) => x.id === r.requestId).status, 'approved');
});

// ---- batch 2 (27 Nov 2026): AI action calling through the same gates ----

test('run passes a read-only action through the engine untouched', async () => {
  const eng = fakeEngine({ ok: true, status: 200, data: { files: [] } });
  const { tool } = stackWithEngine(eng);
  const r = await tool.execute({ action: 'run', connector_id: 'google-drive', action_id: 'list_files', params: {} });
  assert.equal(r.ok, true);
  assert.equal(eng.runs.length, 1);
  assert.equal(eng.runs[0].id, 'google-drive');
  assert.equal(eng.runs[0].actionId, 'list_files');
});

test('run surfaces approval_required for sends and writes and never mints an approval', async () => {
  const eng = fakeEngine({ ok: false, reason: 'approval_required' });
  const { tool } = stackWithEngine(eng);
  const r = await tool.execute({ action: 'run', connector_id: 'slack', action_id: 'post_message', params: { channel: 'C1', text: 'hi' } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'approval_required', 'surfaced verbatim');
  assert.equal(typeof r.userAction, 'string');
  assert.match(r.userAction, /Workspace panel/);
  assert.equal(r.approvalId, undefined, 'no approval minted from the AI side');
});

test('run validates ids and bounds params before the engine is called', async () => {
  const eng = fakeEngine({ ok: true });
  const { tool } = stackWithEngine(eng);
  assert.equal((await tool.execute({ action: 'run' })).reason, 'bad_request');
  assert.equal((await tool.execute({ action: 'run', connector_id: '', action_id: 'x' })).reason, 'bad_request');
  assert.equal((await tool.execute({ action: 'run', connector_id: 'x'.repeat(65), action_id: 'x' })).reason, 'bad_request');
  assert.equal((await tool.execute({ action: 'run', connector_id: 'slack', action_id: '' })).reason, 'bad_request');
  assert.equal((await tool.execute({ action: 'run', connector_id: 'slack', action_id: 'x', params: [1] })).reason, 'param_invalid', 'params must be an object');
  const big = {}; for (let i = 0; i < 21; i++) big['k' + i] = 'v';
  assert.equal((await tool.execute({ action: 'run', connector_id: 'slack', action_id: 'x', params: big })).reason, 'param_invalid', 'bounded key count');
  assert.equal((await tool.execute({ action: 'run', connector_id: 'slack', action_id: 'x', params: { a: 'x'.repeat(3000) } })).reason, 'param_invalid', 'bounded payload size');
  assert.equal(eng.runs.length, 0, 'the engine is never reached with junk input');
});

test('run without an engine in this build refuses honestly', async () => {
  const { tool } = stackWithEngine(null);
  const r = await tool.execute({ action: 'run', connector_id: 'slack', action_id: 'auth_test' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unavailable');
});

test('list includes runnable actions for implemented adapters only', async () => {
  const adapters = require('../src/connector-adapters.js');
  const { tool } = stackWithEngine(fakeEngine({ ok: true }), adapters);
  const r = await tool.execute({ action: 'list' });
  assert.equal(r.ok, true);
  const slack = r.connectors.find((c) => c.id === 'slack');
  assert.ok(Array.isArray(slack.actions) && slack.actions.length > 0, 'implemented adapter names its actions');
  assert.equal(slack.actions[0].id, 'auth_test');
  const spotify = r.connectors.find((c) => c.id === 'spotify');
  assert.equal(spotify.actions, undefined, 'definition-only entries stay silent about actions');
});

test('run never passes an approvalId for a write action', async () => {
  const eng = fakeEngine({ ok: false, reason: 'approval_required' });
  const { tool } = stackWithEngine(eng);
  const r = await tool.execute({ action: 'run', connector_id: 'github', action_id: 'create_issue', params: { owner: 'o', repo: 'r', title: 'T' } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'approval_required', 'surfaced verbatim for write actions too');
  const ro = eng.runs[0].runOpts;
  assert.ok(!ro || ro.approvalId === undefined, 'the tool never mints or passes an approval');
});

test('run never passes an approvalId for a calendar write either', async () => {
  const eng = fakeEngine({ ok: false, reason: 'approval_required' });
  const { tool } = stackWithEngine(eng);
  const r = await tool.execute({ action: 'run', connector_id: 'google-calendar', action_id: 'create_event', params: { summary: 'x', start: '2026-12-01T10:00:00Z', end: '2026-12-01T11:00:00Z' } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'approval_required', 'surfaced verbatim for calendar writes');
  const ro = eng.runs[0].runOpts;
  assert.ok(!ro || ro.approvalId === undefined, 'the tool never mints or passes an approval');
});
