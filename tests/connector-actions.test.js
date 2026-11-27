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

// ---- batch 2 (27 Nov 2026): OAuth token lifecycle ------------------------
// The engine refreshes an expired oauth blob BEFORE the action, rotates
// the rotated blob back into the vault through the injected writer,
// classifies a dead grant as reauth_required (disconnect via the hook),
// treats everything else as transient, and gives a provider 401 exactly
// one refresh-and-retry. The fake transport records every request; no
// secret may appear in any audit entry or result.

function oauthStack(transport, credential, hooks) {
  const catalog = createConnectorCatalog({ clock: () => 0 });
  const calls = [];
  const recorded = [];
  const writer = { blobs: [] };
  const engine = createActionEngine({
    catalog: catalog,
    adapters: adapters,
    transport: async function (req) {
      recorded.push(req);
      return transport(req);
    },
    credentialReader: () => credential,
    credentialWriter: hooks && hooks.writer ? hooks.writer : (id, blob) => { writer.blobs.push(blob); return true; },
    onReauthRequired: hooks && hooks.onReauth ? hooks.onReauth : function () {},
  });
  return { catalog, engine, calls, recorded, writer };
}

function expiredBlob() {
  return JSON.stringify({ client_id: 'cid', client_secret: 'csecret', access_token: 'at-1', refresh_token: 'rt-1', expires_at: -1000 });
}

test('an expired oauth blob is refreshed before the action and the rotation is persisted', async () => {
  const s = oauthStack(async function (req) {
    if (req.url.indexOf('oauth2.googleapis.com/token') !== -1) {
      return { status: 200, body: JSON.stringify({ access_token: 'at-2', expires_in: 3600, refresh_token: 'rt-2' }) };
    }
    return { status: 200, body: JSON.stringify({ files: [] }) };
  }, expiredBlob());
  s.catalog.connect('google-drive', { userInitiated: true, scopes: ['files.read'], credentialRef: 'vault:g' });
  const r = await s.engine.run('google-drive', 'list_files', {});
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(s.recorded.length, 2, 'one refresh, one action');
  assert.equal(s.recorded[0].url.indexOf('oauth2.googleapis.com/token') !== -1, true);
  assert.equal(s.recorded[0].body.indexOf('refresh_token=rt-1') !== -1, true);
  assert.equal(s.recorded[1].headers.Authorization, 'Bearer at-2', 'the action uses the fresh token');
  assert.equal(s.writer.blobs.length, 1, 'rotation written back to the vault');
  const saved = JSON.parse(s.writer.blobs[0]);
  assert.equal(saved.access_token, 'at-2');
  assert.equal(saved.refresh_token, 'rt-2', 'rotated refresh token replaces the old');
  assert.equal(saved.expires_at, 3600000, 'clock 0 + 3600s');
  const refreshAudit = s.engine.audit().filter((a) => a.action === 'connector_refresh');
  assert.equal(refreshAudit.length, 1);
  assert.equal(refreshAudit[0].status, 'ok');
  assert.equal(JSON.stringify(refreshAudit).indexOf('rt-') === -1, true, 'no token material in the audit');
  assert.equal(JSON.stringify(r).indexOf('at-') !== -1 && JSON.stringify(r).indexOf('Bearer') !== -1, false, 'no token in the result');
});

test('a dead grant disconnects the connector instead of limping on', async () => {
  const reauthCalls = [];
  const s = oauthStack(async function () {
    return { status: 400, body: JSON.stringify({ error: 'invalid_grant' }) };
  }, expiredBlob(), { onReauth: (id) => { reauthCalls.push(id); s.catalog.disconnect(id, { userInitiated: true }); } });
  s.catalog.connect('google-drive', { userInitiated: true, scopes: ['files.read'], credentialRef: 'vault:g' });
  const r = await s.engine.run('google-drive', 'list_files', {});
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'reauth_required');
  assert.deepEqual(reauthCalls, ['google-drive'], 'the failure-safe hook ran');
  assert.equal(s.writer.blobs.length, 0, 'nothing persisted on a dead grant');
  assert.equal(s.catalog.state('google-drive'), 'disconnected', 'the connector no longer masquerades as live');
  const again = await s.engine.run('google-drive', 'list_files', {});
  assert.equal(again.reason, 'not_connected', 'a re-auth is a fresh explicit connect');
  const refreshAudit = s.engine.audit().filter((a) => a.action === 'connector_refresh');
  assert.equal(refreshAudit[0].status, 'reauth_required');
});

test('a transient refresh failure keeps the credential and reports refresh_failed', async () => {
  const reauthCalls = [];
  const s = oauthStack(async function (req) {
    if (req.url.indexOf('oauth2.googleapis.com/token') !== -1) return { status: 503, body: 'unavailable' };
    return { status: 200, body: JSON.stringify({ files: [] }) };
  }, expiredBlob(), { onReauth: (id) => reauthCalls.push(id) });
  s.catalog.connect('google-drive', { userInitiated: true, scopes: ['files.read'], credentialRef: 'vault:g' });
  const r = await s.engine.run('google-drive', 'list_files', {});
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'refresh_failed');
  assert.deepEqual(reauthCalls, [], 'no disconnect for a transient failure');
  assert.equal(s.writer.blobs.length, 0);
});

test('a refresh whose rotation cannot be persisted fails the action instead of gambling', async () => {
  const s = oauthStack(async function (req) {
    if (req.url.indexOf('oauth2.googleapis.com/token') !== -1) {
      return { status: 200, body: JSON.stringify({ access_token: 'at-2', expires_in: 3600 }) };
    }
    return { status: 200, body: JSON.stringify({ files: [] }) };
  }, expiredBlob(), { writer: () => false });
  s.catalog.connect('google-drive', { userInitiated: true, scopes: ['files.read'], credentialRef: 'vault:g' });
  const r = await s.engine.run('google-drive', 'list_files', {});
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'refresh_persist_failed');
  assert.equal(s.recorded.length, 1, 'the action endpoint was never hit with an unpersisted rotation');
});

test('a provider 401 earns exactly one refresh-and-retry', async () => {
  let actionCalls = 0;
  const s = oauthStack(async function (req) {
    if (req.url.indexOf('oauth2.googleapis.com/token') !== -1) {
      return { status: 200, body: JSON.stringify({ access_token: 'at-2', expires_in: 3600 }) };
    }
    actionCalls += 1;
    if (actionCalls === 1) return { status: 401, body: JSON.stringify({ error: 'unauthorized' }) };
    return { status: 200, body: JSON.stringify({ files: [] }) };
  }, JSON.stringify({ client_id: 'cid', client_secret: 'csecret', access_token: 'at-1', refresh_token: 'rt-1', expires_at: 9999999999 }));
  s.catalog.connect('google-drive', { userInitiated: true, scopes: ['files.read'], credentialRef: 'vault:g' });
  const r = await s.engine.run('google-drive', 'list_files', {});
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.status, 200);
  assert.equal(actionCalls, 2, 'one 401, one retry after the refresh');
  assert.equal(s.recorded[1].url.indexOf('oauth2.googleapis.com/token') !== -1, true);
  assert.equal(s.writer.blobs.length, 1);
});

test('an expired blob with no refresh token runs anyway and refreshes nothing', async () => {
  const s = oauthStack(async function () {
    return { status: 200, body: JSON.stringify({ files: [] }) };
  }, JSON.stringify({ client_id: 'cid', client_secret: 'csecret', access_token: 'at-1', refresh_token: null, expires_at: -1000 }));
  s.catalog.connect('google-drive', { userInitiated: true, scopes: ['files.read'], credentialRef: 'vault:g' });
  const r = await s.engine.run('google-drive', 'list_files', {});
  assert.equal(r.ok, true, 'no refresh token means no proactive refresh, the action still runs');
  assert.equal(s.recorded.length, 1, 'only the action request');
  assert.equal(s.recorded[0].headers.Authorization, 'Bearer at-1');
});

// ---- batch 3 (27 Nov 2026): write gates on the new create actions ----

test('a write action needs a single-use approval and the approval opens exactly one call', async () => {
  const { catalog, engine } = makeEngine(async () => ({ status: 201, body: '{"number":7}' }), 'ghp-tok');
  catalog.connect('github', { userInitiated: true, scopes: ['issues.read', 'issues.write'], credentialRef: 'vault:gh-cred' });
  assert.equal((await engine.run('github', 'create_issue', { owner: 'o', repo: 'r', title: 'T' })).reason, 'approval_required', 'write without an approval refuses');
  const a = catalog.approve('github', 'issues.write', { userInitiated: true });
  const r1 = await engine.run('github', 'create_issue', { owner: 'o', repo: 'r', title: 'T' }, { approvalId: a.approvalId });
  assert.equal(r1.ok, true, 'the approved write runs once');
  assert.equal((await engine.run('github', 'create_issue', { owner: 'o', repo: 'r', title: 'T' }, { approvalId: a.approvalId })).reason, 'approval_required', 'the spent approval is dead');
});

test('a write action still refuses when not connected or the scope was not granted', async () => {
  const { catalog, engine } = makeEngine(async () => { throw new Error('must not be called'); }, 'ghp-tok');
  assert.equal((await engine.run('github', 'create_issue', { owner: 'o', repo: 'r', title: 'T' })).reason, 'not_connected');
  catalog.connect('github', { userInitiated: true, scopes: ['issues.read'], credentialRef: 'vault:gh-cred' });
  assert.equal((await engine.run('github', 'create_issue', { owner: 'o', repo: 'r', title: 'T' })).reason, 'scope_not_granted', 'write scope was not granted at connect');
});

test('a bad parameter set refuses before any approval is consumed', async () => {
  const { catalog, engine } = makeEngine(async () => ({ status: 201, body: '{}' }), 'ghp-tok');
  catalog.connect('github', { userInitiated: true, scopes: ['issues.write'], credentialRef: 'vault:gh-cred' });
  const a = catalog.approve('github', 'issues.write', { userInitiated: true });
  const bad = await engine.run('github', 'create_issue', { owner: 'o', repo: 'r' }, { approvalId: a.approvalId });
  assert.equal(bad.reason, 'param_missing', 'missing title refuses before the transport');
  const good = await engine.run('github', 'create_issue', { owner: 'o', repo: 'r', title: 'T' }, { approvalId: a.approvalId });
  assert.equal(good.ok, true, 'the SAME approval still works after the invalid run was refused');
});
