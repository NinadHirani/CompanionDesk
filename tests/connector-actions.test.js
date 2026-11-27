'use strict';
// Action engine tests (27 Nov 2026, Ninad's integration go-ahead, batch 1).
// The engine gates EVERY call through the catalog's authorizeCall (the
// single consent authority) before building any request, resolves the
// credential only through the injected reader, and never lets secrets or
// URLs into its audit trail or results. The transport is a fake here: the
// real HTTPS executor is wired in main.js and is not what these tests pin.

const { test } = require('node:test');
const assert = require('node:assert');
const { createConnectorCatalog } = require('../src/connectors.js');
const adapters = require('../src/connector-adapters.js');
const { createActionEngine } = require('../src/connector-actions.js');

function makeEngine(transport, credentialValue) {
  const catalog = createConnectorCatalog({ clock: () => 0 });
  const creds = typeof credentialValue === 'function' ? credentialValue : () => credentialValue;
  return {
    catalog,
    engine: createActionEngine({
      catalog: catalog,
      adapters: adapters,
      transport: transport,
      credentialReader: creds,
    }),
  };
}

test('the gate chain runs in order and each step refuses honestly', async () => {
  const { catalog, engine } = makeEngine(async () => { throw new Error('must not be called'); }, 'xoxb-tok');
  assert.equal((await engine.run('no-such', 'x', {})).reason, 'unknown_connector');
  assert.equal((await engine.run('spotify', 'x', {})).reason, 'no_adapter', 'definition-only entries have no adapter');
  assert.equal((await engine.run('rss', 'feed.read', {})).reason, 'no_adapter', 'legacy tier has no fake execution');
  assert.equal((await engine.run('slack', 'auth_test', {})).reason, 'not_connected');
  catalog.connect('slack', { userInitiated: true, scopes: ['channels.read'], credentialRef: 'vault:slack-cred' });
  assert.equal((await engine.run('slack', 'nope', {})).reason, 'unknown_action');
  assert.equal((await engine.run('slack', 'post_message', { channel: 'C1', text: 'x' })).reason, 'scope_not_granted', 'send scope was not granted at connect');
  assert.equal((await engine.run('slack', 'auth_test', { junk: 'x' })).reason, 'param_invalid');
});

test('a granted read-only action runs with no approval and returns provider JSON', async () => {
  const { catalog, engine } = makeEngine(async (req) => ({ status: 200, body: JSON.stringify({ ok: true, url: 'https://slack.com/api/auth.test', team: 't' }) }), 'xoxb-tok');
  catalog.connect('slack', { userInitiated: true, scopes: ['channels.read'], credentialRef: 'vault:slack-cred' });
  const r = await engine.run('slack', 'auth_test', {});
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.equal(r.data.team, 't');
});

test('a send action needs a single-use approval minted by the user, and the approval opens exactly one call', async () => {
  const { catalog, engine } = makeEngine(async (req) => ({ status: 200, body: JSON.stringify({ ok: true }) }), 'xoxb-tok');
  catalog.connect('slack', { userInitiated: true, scopes: ['channels.read', 'message.send'], credentialRef: 'vault:slack-cred' });
  assert.equal((await engine.run('slack', 'post_message', { channel: 'C1', text: 'hi' })).reason, 'approval_required');
  const a = catalog.approve('slack', 'message.send', { userInitiated: true });
  const r1 = await engine.run('slack', 'post_message', { channel: 'C1', text: 'hi' }, { approvalId: a.approvalId });
  assert.equal(r1.ok, true, 'the approved send runs once');
  const a2 = catalog.approve('slack', 'message.send', { userInitiated: true });
  const r2 = await engine.run('slack', 'post_message', { channel: 'C1', text: 'again' }, { approvalId: a.approvalId });
  assert.equal(r2.reason, 'approval_required', 'the spent approval is dead');
  assert.equal((await engine.run('slack', 'post_message', { channel: 'C1', text: 'x' }, { approvalId: a2.approvalId })).ok, true);
});

test('a missing credential refuses before any request is built', async () => {
  const { catalog, engine } = makeEngine(async () => ({ status: 200, body: '{}' }), () => null);
  catalog.connect('slack', { userInitiated: true, scopes: ['channels.read'], credentialRef: 'vault:slack-cred' });
  assert.equal((await engine.run('slack', 'auth_test', {})).reason, 'credential_missing');
});

test('transport failures come back as transport_error and never carry request material', async () => {
  const boom = new Error('getaddrinfo ENOTFOUND api.slack.com https://slack.com/api/auth.test Authorization: Bearer xoxb-secret');
  const { catalog, engine } = makeEngine(async () => { throw boom; }, 'xoxb-tok');
  catalog.connect('slack', { userInitiated: true, scopes: ['channels.read'], credentialRef: 'vault:slack-cred' });
  const r = await engine.run('slack', 'auth_test', {});
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'transport_error');
  assert.ok(!JSON.stringify(r).includes('xoxb-secret'), 'no secret in the failure');
  assert.ok(!JSON.stringify(r).includes('getaddrinfo'), 'no raw error text in the failure');
});

test('non-2xx responses fail as provider_error with the status kept and the body still scrubbed', async () => {
  const { catalog, engine } = makeEngine(async () => ({ status: 401, body: JSON.stringify({ error: 'bad key=ABC123-secret' }) }), 'xoxb-tok');
  catalog.connect('slack', { userInitiated: true, scopes: ['channels.read'], credentialRef: 'vault:slack-cred' });
  const r = await engine.run('slack', 'auth_test', {});
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'provider_error');
  assert.equal(r.status, 401);
  assert.ok(!JSON.stringify(r.data).includes('ABC123-secret'), 'credential-shaped values are scrubbed');
  assert.ok(JSON.stringify(r.data).includes('key=REDACTED'));
});

test('results are scrubbed of credential-shaped query values and truncated past the cap', async () => {
  const { catalog, engine } = makeEngine(async () => ({ status: 200, body: JSON.stringify({ next: 'https://x/y?token=zzz-secret&ok=1' }) }), 'xoxb-tok');
  catalog.connect('slack', { userInitiated: true, scopes: ['channels.read'], credentialRef: 'vault:slack-cred' });
  const r = await engine.run('slack', 'auth_test', {});
  assert.ok(!JSON.stringify(r.data).includes('zzz-secret'));
  assert.ok(JSON.stringify(r.data).includes('token=REDACTED'));
  const big = makeEngine(async () => ({ status: 200, body: JSON.stringify({ blob: 'x'.repeat(30000) }) }), 'xoxb-tok');
  big.catalog.connect('slack', { userInitiated: true, scopes: ['channels.read'], credentialRef: 'vault:slack-cred' });
  const rb = await big.engine.run('slack', 'auth_test', {});
  assert.equal(rb.data.truncated, true);
  assert.ok(rb.data.raw.length <= big.engine.maxResponseChars);
});

test('the audit trail carries ids, scope, status and timing only', async () => {
  const { catalog, engine } = makeEngine(async () => ({ status: 200, body: '{"ok":true}' }), 'xoxb-tok');
  catalog.connect('slack', { userInitiated: true, scopes: ['channels.read', 'message.send'], credentialRef: 'vault:slack-cred' });
  await engine.run('slack', 'auth_test', {});
  await engine.run('slack', 'post_message', { channel: 'C1', text: 'hello world' }, { approvalId: catalog.approve('slack', 'message.send', { userInitiated: true }).approvalId });
  const audit = engine.audit();
  assert.equal(audit.length, 2);
  for (const e of audit) {
    assert.deepEqual(Object.keys(e).sort(), ['action', 'actionId', 'id', 'kind', 'ms', 'scope', 'status', 'ts'].sort(), 'only safe keys');
    assert.ok(!JSON.stringify(e).includes('xoxb-tok'));
    assert.ok(!JSON.stringify(e).includes('hello world'), 'param values never enter the audit trail');
  }
});

test('the telegram adapter works through the same gates with the url-token shape', async () => {
  let seenUrl = null;
  const { catalog, engine } = makeEngine(async (req) => { seenUrl = req.url; return { status: 200, body: JSON.stringify({ ok: true, result: { id: 1 } }) }; }, '12345:ABC-secret');
  catalog.connect('telegram', { userInitiated: true, scopes: ['chats.read'], credentialRef: 'vault:telegram-cred' });
  const r = await engine.run('telegram', 'get_me', {});
  assert.equal(r.ok, true);
  assert.ok(seenUrl.includes('bot12345%3AABC-secret'), 'the real request carries the token to the provider (colon percent-encoded)');
  assert.ok(!JSON.stringify(r).includes('12345:ABC-secret'), 'but nothing returned or audited does');
});
