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

test('the definition exists, is ordinary capability and names no credential field', () => {
  assert.equal(CONNECTORS_TOOL_DEFINITION.name, 'connector_status');
  assert.equal(CONNECTORS_TOOL_DEFINITION.capability, 'ordinary');
  assert.equal(CONNECTORS_TOOL_DEFINITION.critical, false);
  const fields = Object.keys(CONNECTORS_TOOL_DEFINITION.schema.properties);
  assert.deepEqual(fields, ['action', 'connector_id', 'reason']);
  const blob = JSON.stringify(CONNECTORS_TOOL_DEFINITION);
  assert.equal(/keychain:|vault:|credential-store:/i.test(blob), false, 'no credential material in the definition');
});

test('list returns the catalog with live states and the open requests', async () => {
  const s = stack();
  s.requests.request('rss', { reason: 'needs feeds' });
  const out = await s.tool.execute({ action: 'list' });
  assert.equal(out.ok, true);
  assert.equal(out.connectors.length, 33, 'the shipped catalog (20 legacy + 13 curated popular providers)');
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
