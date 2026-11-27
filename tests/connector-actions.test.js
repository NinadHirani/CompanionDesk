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

// ---- batch 4 (27 Nov 2026): calendar write gates on create_event ----

test('calendar create_event needs a single-use approval and the approval opens exactly one event', async () => {
  const cred = '{"client_id":"c","access_token":"at"}';
  const { catalog, engine } = makeEngine(async () => ({ status: 201, body: '{"id":"ev1"}' }), cred);
  catalog.connect('google-calendar', { userInitiated: true, scopes: ['events.read', 'events.write'], credentialRef: 'vault:gcal-cred' });
  const p = { summary: 'Focus block', start: '2026-12-01T10:00:00Z', end: '2026-12-01T11:00:00Z' };
  assert.equal((await engine.run('google-calendar', 'create_event', p)).reason, 'approval_required', 'write without an approval refuses');
  const a = catalog.approve('google-calendar', 'events.write', { userInitiated: true });
  const r1 = await engine.run('google-calendar', 'create_event', p, { approvalId: a.approvalId });
  assert.equal(r1.ok, true, 'the approved write runs once');
  assert.equal((await engine.run('google-calendar', 'create_event', p, { approvalId: a.approvalId })).reason, 'approval_required', 'the spent approval is dead');
});

test('calendar create_event still refuses when not connected or the scope was not granted', async () => {
  const { catalog, engine } = makeEngine(async () => { throw new Error('must not be called'); }, '{"client_id":"c","access_token":"at"}');
  const p = { subject: 'x', start: '2026-12-01T10:00:00Z', end: '2026-12-01T11:00:00Z' };
  assert.equal((await engine.run('microsoft-calendar', 'create_event', p)).reason, 'not_connected');
  catalog.connect('microsoft-calendar', { userInitiated: true, scopes: ['events.read'], credentialRef: 'vault:ms-cal-cred' });
  assert.equal((await engine.run('microsoft-calendar', 'create_event', p)).reason, 'scope_not_granted', 'write scope was not granted at connect');
});

test('a bad event parameter set refuses before any approval is consumed', async () => {
  const { catalog, engine } = makeEngine(async () => ({ status: 201, body: '{}' }), '{"client_id":"c","access_token":"at"}');
  catalog.connect('google-calendar', { userInitiated: true, scopes: ['events.write'], credentialRef: 'vault:gcal-cred' });
  const a = catalog.approve('google-calendar', 'events.write', { userInitiated: true });
  const bad = await engine.run('google-calendar', 'create_event', { summary: 'x', start: '2026-12-01T10:00:00Z' }, { approvalId: a.approvalId });
  assert.equal(bad.reason, 'param_missing', 'missing end refuses before the transport');
  const good = await engine.run('google-calendar', 'create_event', { summary: 'x', start: '2026-12-01T10:00:00Z', end: '2026-12-01T11:00:00Z' }, { approvalId: a.approvalId });
  assert.equal(good.ok, true, 'the SAME approval still works after the invalid run was refused');
});

// ---- batch 5 (27 Nov 2026): the new reads flow through the same gates ----

test('new messaging reads run after connect with their scope and never need an approval', async () => {
  const { catalog, engine } = makeEngine(async () => ({ status: 200, body: '{"ok":true}' }), 'bot-token');
  catalog.connect('telegram', { userInitiated: true, scopes: ['chats.read'], credentialRef: 'vault:tg-cred' });
  const r = await engine.run('telegram', 'get_updates', {});
  assert.equal(r.ok, true, 'a granted read runs with no approval');
  catalog.connect('discord', { userInitiated: true, scopes: ['guilds.read', 'channels.read'], credentialRef: 'vault:dc-cred' });
  const r2 = await engine.run('discord', 'list_channel_messages', { channel_id: '123456789012345678' });
  assert.equal(r2.ok, true, 'channel reads need no approval');
});

test('a read without its scope still refuses with scope_not_granted', async () => {
  const { catalog, engine } = makeEngine(async () => { throw new Error('must not be called'); }, 'bot-token');
  catalog.connect('discord', { userInitiated: true, scopes: ['guilds.read'], credentialRef: 'vault:dc-cred' });
  const r = await engine.run('discord', 'list_channel_messages', { channel_id: '123456789012345678' });
  assert.equal(r.reason, 'scope_not_granted', 'channels.read was not granted at connect');
});

// ---- batch 6 (27 Nov 2026): the new reads and the new adapter through the gates ----

test('github and notion reads run with no approval once connected', async () => {
  const { catalog, engine } = makeEngine(async () => ({ status: 200, body: '{}' }), 'ghp-tok');
  catalog.connect('github', { userInitiated: true, scopes: ['repos.read'], credentialRef: 'vault:gh-cred' });
  const r = await engine.run('github', 'list_pull_requests', { owner: 'NinadHirani', repo: 'CompanionDesk' });
  assert.equal(r.ok, true, 'a granted read runs with no approval');
  catalog.connect('notion', { userInitiated: true, scopes: ['pages.read'], credentialRef: 'vault:nt-cred' });
  const r2 = await engine.run('notion', 'get_page_blocks', { page_id: 'abc' });
  assert.equal(r2.ok, true);
});

test('the huggingface adapter runs its reads after connect and refuses without scope', async () => {
  const { catalog, engine } = makeEngine(async () => ({ status: 200, body: '{"ok":1}' }), 'hf-tok');
  assert.equal((await engine.run('huggingface', 'whoami', {})).reason, 'not_connected');
  catalog.connect('huggingface', { userInitiated: true, scopes: ['models.read'], credentialRef: 'vault:hf-cred' });
  const r = await engine.run('huggingface', 'whoami', {});
  assert.equal(r.ok, true, 'a granted read runs with no approval');
  const r2 = await engine.run('huggingface', 'list_models', { search: 'qiskit' });
  assert.equal(r2.ok, true);
});

// ---- batch 7 (27 Nov 2026): public connectors run keyless behind the connect gate ----

test('public research connectors run with no credential once connected', async () => {
  const { catalog, engine } = makeEngine(async () => ({ status: 200, body: '{}' }), null);
  assert.equal((await engine.run('arxiv', 'search_papers', { query: 'qaoa' })).reason, 'not_connected');
  const c = catalog.connect('arxiv', { userInitiated: true, scopes: ['papers.read'] });
  assert.equal(c.ok, true, 'a public API connects with no credential ref');
  const r = await engine.run('arxiv', 'search_papers', { query: 'qaoa' });
  assert.equal(r.ok, true, 'the read runs with no credential at all');
  catalog.connect('crossref', { userInitiated: true, scopes: ['works.read'] });
  const r2 = await engine.run('crossref', 'get_work', { doi: '10.1234/abc' });
  assert.equal(r2.ok, true);
  catalog.connect('openalex', { userInitiated: true, scopes: ['works.read'] });
  const r3 = await engine.run('openalex', 'search_works', { search: 'qubo' });
  assert.equal(r3.ok, true);
});

test('the connect gate still holds for public connectors: no scopes, no run', async () => {
  const { catalog, engine } = makeEngine(async () => ({ status: 200, body: '{}' }), null);
  assert.equal(catalog.connect('arxiv', { userInitiated: true, scopes: [] }).reason, 'requires_explicit_scopes');
  assert.equal(catalog.connect('arxiv', {}).reason, 'requires_user_action');
  assert.equal((await engine.run('arxiv', 'get_paper', { id: '2310.1' })).reason, 'not_connected');
});

// ---- batch 8 (27 Nov 2026): weather and map reads run keyless behind the gate ----

test('open-meteo and openstreetmap reads run with no credential once connected', async () => {
  const { catalog, engine } = makeEngine(async () => ({ status: 200, body: '{}' }), null);
  assert.equal((await engine.run('open-meteo', 'get_current_weather', { latitude: '1', longitude: '2' })).reason, 'not_connected');
  assert.equal(catalog.connect('open-meteo', { userInitiated: true, scopes: ['weather.read'] }).ok, true);
  assert.equal((await engine.run('open-meteo', 'get_current_weather', { latitude: '1', longitude: '2' })).ok, true);
  assert.equal(catalog.connect('openstreetmap', { userInitiated: true, scopes: ['places.read'] }).ok, true);
  assert.equal((await engine.run('openstreetmap', 'search_places', { query: 'Rajkot' })).ok, true);
  assert.equal((await engine.run('openstreetmap', 'reverse_geocode', { latitude: '22.3', longitude: '70.8' })).ok, true);
});

// ---- batch 9 (27 Nov 2026): wikimedia and openlibrary run keyless behind the gate ----

test('wikimedia and openlibrary reads run with no credential once connected', async () => {
  const { catalog, engine } = makeEngine(async () => ({ status: 200, body: '{}' }), null);
  assert.equal((await engine.run('wikimedia', 'search_pages', { query: 'qaoa' })).reason, 'not_connected');
  assert.equal(catalog.connect('wikimedia', { userInitiated: true, scopes: ['search.read'] }).ok, true);
  assert.equal((await engine.run('wikimedia', 'search_pages', { query: 'qaoa' })).ok, true);
  assert.equal(catalog.connect('openlibrary', { userInitiated: true, scopes: ['books.read'] }).ok, true);
  assert.equal((await engine.run('openlibrary', 'search_books', { query: 'qaoa' })).ok, true);
  assert.equal((await engine.run('openlibrary', 'get_book', { identifier: '9780262033848' })).ok, true);
});

// ---- batch 10 (27 Nov 2026): brave-search and tavily gate + redaction ----

test('brave-search and tavily refuse unconnected/unauthorized runs and redact secret-shaped text', async () => {
  let seen = null;
  const transport = async (req) => { seen = req; return { status: 200, body: JSON.stringify({ results: [], echo: 'api_key=sk-tavily-secret-42' }) }; };
  const { catalog, engine } = makeEngine(transport, () => 'tvly-secret-key-9');
  assert.equal((await engine.run('brave-search', 'web_search', { query: 'q' })).reason, 'not_connected');
  assert.equal(catalog.connect('brave-search', { userInitiated: true, scopes: ['search.read'] }).reason, 'credential_ref_required');
  const c = catalog.connect('brave-search', { userInitiated: true, scopes: ['search.read'], credentialRef: 'vault:brave-key' });
  assert.equal(c.ok, true);
  const r1 = await engine.run('brave-search', 'web_search', { query: 'quantum' });
  assert.equal(r1.ok, true);
  assert.equal(seen.headers['X-Subscription-Token'], 'tvly-secret-key-9');
  assert.ok(seen.url.indexOf('tvly-secret-key') === -1, 'the vault key never appears in the request URL');
  assert.ok(r1.data.echo.indexOf('sk-tavily-secret-42') === -1 && r1.data.echo.indexOf('REDACTED') !== -1, 'secret-shaped response text is redacted');
  const c2 = catalog.connect('tavily', { userInitiated: true, scopes: ['search.read'], credentialRef: 'vault:tavily-key' });
  assert.equal(c2.ok, true);
  const r2 = await engine.run('tavily', 'web_search', { query: 'quantum' });
  assert.equal(r2.ok, true);
  assert.equal(seen.headers.Authorization, 'Bearer tvly-secret-key-9');
  const second = makeEngine(async () => ({ status: 200, body: '{}' }), () => null);
  assert.equal(second.catalog.connect('tavily', { userInitiated: true, scopes: ['search.read'], credentialRef: 'vault:k' }).ok, true);
  assert.equal((await second.engine.run('tavily', 'web_search', { query: 'q' })).reason, 'credential_missing');
});

// ---- batch 11 (27 Nov 2026): google-docs and google-sheets gates + refresh ----

test('google-docs and google-sheets refuse unconnected runs and refresh expired tokens', async () => {
  const s = oauthStack(async function (req) {
    if (req.url.indexOf('oauth2.googleapis.com/token') !== -1) {
      return { status: 200, body: JSON.stringify({ access_token: 'at-2', expires_in: 3600, refresh_token: 'rt-2' }) };
    }
    return { status: 200, body: JSON.stringify({ values: [['A1', 'B1']], echo: 'access_token=at-2' }) };
  }, expiredBlob());
  assert.equal((await s.engine.run('google-sheets', 'get_values', { spreadsheet_id: '1Bxi', range: 'A1:B2' })).reason, 'not_connected');
  assert.equal(s.catalog.connect('google-sheets', { userInitiated: true, scopes: ['spreadsheets.read'] }).reason, 'credential_ref_required');
  const c = s.catalog.connect('google-sheets', { userInitiated: true, scopes: ['spreadsheets.read'], credentialRef: 'vault:gs' });
  assert.equal(c.ok, true);
  const r = await s.engine.run('google-sheets', 'get_values', { spreadsheet_id: '1Bxi', range: 'A1:B2' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(s.recorded.length, 2, 'one refresh, one action');
  assert.equal(s.recorded[0].url.indexOf('oauth2.googleapis.com/token') !== -1, true, 'refresh goes to the pinned token endpoint');
  assert.equal(s.recorded[1].url.indexOf('https://sheets.googleapis.com/v4/spreadsheets/1Bxi/values/') === 0, true, 'pinned sheets host');
  assert.equal(s.recorded[1].headers.Authorization, 'Bearer at-2', 'the action uses the fresh token');
  assert.ok(s.recorded[1].url.indexOf('at-2') === -1, 'the access token never rides the URL');
  assert.ok(r.data.echo.indexOf('at-2') === -1 && r.data.echo.indexOf('REDACTED') !== -1, 'secret-shaped response text is redacted');
  const s2 = oauthStack(async function (req) {
    if (req.url.indexOf('oauth2.googleapis.com/token') !== -1) {
      return { status: 200, body: JSON.stringify({ access_token: 'at-2', expires_in: 3600 }) };
    }
    return { status: 200, body: JSON.stringify({ documentId: 'abc' }) };
  }, expiredBlob());
  assert.equal((await s2.engine.run('google-docs', 'get_document_content', { document_id: 'abc' })).reason, 'not_connected');
  const c2 = s2.catalog.connect('google-docs', { userInitiated: true, scopes: ['documents.read'], credentialRef: 'vault:gd' });
  assert.equal(c2.ok, true);
  const r2 = await s2.engine.run('google-docs', 'get_document_content', { document_id: 'abc' });
  assert.equal(r2.ok, true);
  assert.equal(s2.recorded[1].url.indexOf('https://docs.googleapis.com/v1/documents/abc') === 0, true, 'pinned docs host');
});

// ---- batch 12 (27 Nov 2026): microsoft-excel and microsoft-word gates + refresh ----

test('microsoft-excel refuses unconnected runs, connects on the minimal scope, and refreshes before a read', async () => {
  const s = oauthStack(async function (req) {
    if (req.url.indexOf('login.microsoftonline.com/common/oauth2/v2.0/token') !== -1) {
      return { status: 200, body: JSON.stringify({ access_token: 'at-2', expires_in: 3600, refresh_token: 'rt-2' }) };
    }
    return { status: 200, body: JSON.stringify({ address: 'A1:C10', echo: 'access_token=at-2' }) };
  }, expiredBlob());
  assert.equal((await s.engine.run('microsoft-excel', 'get_workbook_range', { workbook_item_id: 'id1', worksheet: 'Sheet1', range: 'A1:C10' })).reason, 'not_connected');
  assert.equal(s.catalog.connect('microsoft-excel', { userInitiated: true, scopes: ['workbook.read'] }).reason, 'credential_ref_required');
  const c = s.catalog.connect('microsoft-excel', { userInitiated: true, scopes: ['workbook.read'], credentialRef: 'vault:msx' });
  assert.equal(c.ok, true);
  const r = await s.engine.run('microsoft-excel', 'get_workbook_range', { workbook_item_id: 'id1', worksheet: 'Sheet1', range: 'A1:C10' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(s.recorded.length, 2, 'one refresh, one action');
  assert.equal(s.recorded[0].url.indexOf('login.microsoftonline.com/common/oauth2/v2.0/token') !== -1, true, 'refresh goes to the pinned Microsoft token endpoint');
  assert.equal(s.recorded[1].url.indexOf('https://graph.microsoft.com/v1.0/me/drive/items/id1/workbook/worksheets/') === 0, true, 'pinned Graph host');
  assert.equal(s.recorded[1].headers.Authorization, 'Bearer at-2', 'the action uses the fresh token');
  assert.ok(s.recorded[1].url.indexOf('at-2') === -1, 'the access token never rides the URL');
  assert.ok(r.data.echo.indexOf('at-2') === -1 && r.data.echo.indexOf('REDACTED') !== -1, 'secret-shaped response text is redacted');
});

test('microsoft-word refuses unconnected runs and reads metadata after a refresh', async () => {
  const s = oauthStack(async function (req) {
    if (req.url.indexOf('login.microsoftonline.com/common/oauth2/v2.0/token') !== -1) {
      return { status: 200, body: JSON.stringify({ access_token: 'at-2', expires_in: 3600, refresh_token: 'rt-2' }) };
    }
    return { status: 200, body: JSON.stringify({ name: 'notes.docx', echo: 'refresh_token=rt-2' }) };
  }, expiredBlob());
  assert.equal((await s.engine.run('microsoft-word', 'get_document_properties', { item_id: 'doc1' })).reason, 'not_connected');
  assert.equal(s.catalog.connect('microsoft-word', { userInitiated: true, scopes: ['documents.read'] }).reason, 'credential_ref_required');
  const c = s.catalog.connect('microsoft-word', { userInitiated: true, scopes: ['documents.read'], credentialRef: 'vault:msw' });
  assert.equal(c.ok, true);
  const r = await s.engine.run('microsoft-word', 'get_document_properties', { item_id: 'doc1' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(s.recorded.length, 2, 'one refresh, one action');
  assert.equal(s.recorded[1].url, 'https://graph.microsoft.com/v1.0/me/drive/items/doc1?select=id,name,size,lastModifiedDateTime,webUrl', 'pinned Graph metadata URL');
  assert.equal(s.recorded[1].headers.Authorization, 'Bearer at-2');
  assert.ok(r.data.echo.indexOf('rt-2') === -1 && r.data.echo.indexOf('REDACTED') !== -1, 'secret-shaped response text is redacted');
});

// ---- batch 13 (27 Nov 2026): microsoft-teams gates + refresh ----

test('microsoft-teams refuses unconnected runs, connects on the minimal scope, and refreshes before chat reads', async () => {
  const s = oauthStack(async function (req) {
    if (req.url.indexOf('login.microsoftonline.com/common/oauth2/v2.0/token') !== -1) {
      return { status: 200, body: JSON.stringify({ access_token: 'at-2', expires_in: 3600, refresh_token: 'rt-2' }) };
    }
    return { status: 200, body: JSON.stringify({ value: [], echo: 'access_token=at-2' }) };
  }, expiredBlob());
  assert.equal((await s.engine.run('microsoft-teams', 'list_chats', {})).reason, 'not_connected');
  assert.equal(s.catalog.connect('microsoft-teams', { userInitiated: true, scopes: ['chat.read'] }).reason, 'credential_ref_required');
  const c = s.catalog.connect('microsoft-teams', { userInitiated: true, scopes: ['chat.read'], credentialRef: 'vault:mst' });
  assert.equal(c.ok, true);
  const r = await s.engine.run('microsoft-teams', 'list_chats', {});
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(s.recorded.length, 2, 'one refresh, one action');
  assert.equal(s.recorded[0].url.indexOf('login.microsoftonline.com/common/oauth2/v2.0/token') !== -1, true, 'refresh goes to the pinned Microsoft token endpoint');
  assert.equal(s.recorded[1].url.indexOf('https://graph.microsoft.com/v1.0/chats?$top=20') === 0, true, 'pinned Graph host');
  assert.equal(s.recorded[1].headers.Authorization, 'Bearer at-2', 'the action uses the fresh token');
  assert.ok(s.recorded[1].url.indexOf('at-2') === -1, 'the access token never rides the URL');
  assert.ok(r.data.echo.indexOf('at-2') === -1 && r.data.echo.indexOf('REDACTED') !== -1, 'secret-shaped response text is redacted');
  const r2 = await s.engine.run('microsoft-teams', 'get_chat_messages', { chat_id: '19:abcXYZ@thread.v2' });
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.ok(s.recorded[s.recorded.length - 1].url.indexOf(encodeURIComponent('19:abcXYZ@thread.v2')) !== -1, 'the chat id is URL-encoded');
});

// ---- batch 14 (27 Nov 2026): gitlab gates + token handling ----

test('gitlab refuses unconnected runs, connects on the vault token, and never leaks it', async () => {
  let seen = null;
  const transport = async (req) => { seen = req; return { status: 200, body: JSON.stringify([{ id: 1, name: 'demo' }]), }; };
  const { catalog, engine } = makeEngine(transport, () => 'glpat-secret-7');
  assert.equal((await engine.run('gitlab', 'search_projects', { query: 'demo' })).reason, 'not_connected');
  assert.equal(catalog.connect('gitlab', { userInitiated: true, scopes: ['read_api'] }).reason, 'credential_ref_required');
  const c = catalog.connect('gitlab', { userInitiated: true, scopes: ['read_api'], credentialRef: 'vault:gitlab-pat' });
  assert.equal(c.ok, true);
  const r = await engine.run('gitlab', 'search_projects', { query: 'demo' });
  assert.equal(r.ok, true);
  assert.equal(seen.headers.Authorization, 'Bearer glpat-secret-7', 'the action uses the vault token');
  assert.ok(seen.url.indexOf('glpat-secret') === -1, 'the vault token never appears in the request URL');
  const second = makeEngine(async () => ({ status: 200, body: '{}' }), () => null);
  assert.equal(second.catalog.connect('gitlab', { userInitiated: true, scopes: ['read_api'], credentialRef: 'vault:k' }).ok, true);
  assert.equal((await second.engine.run('gitlab', 'search_projects', { query: 'q' })).reason, 'credential_missing');
});

// ---- batch 15 (27 Nov 2026): jira gates + secret handling ----

test('jira refuses unconnected runs, connects on the vault payload, and never leaks the token', async () => {
  let seen = null;
  const cred = JSON.stringify({ host: 'https://example.atlassian.net', email: 'user@example.com', token: 'at3t-secret-token-42' });
  const transport = async (req) => { seen = req; return { status: 200, body: JSON.stringify({ key: 'PROJ-42', echo: 'token=at3t-secret-token-42' }) }; };
  const { catalog, engine } = makeEngine(transport, () => cred);
  assert.equal((await engine.run('jira', 'get_issue', { issue_key: 'PROJ-42' })).reason, 'not_connected');
  assert.equal(catalog.connect('jira', { userInitiated: true, scopes: ['issues.read'] }).reason, 'credential_ref_required');
  const c = catalog.connect('jira', { userInitiated: true, scopes: ['issues.read'], credentialRef: 'vault:jira-cred' });
  assert.equal(c.ok, true);
  const r = await engine.run('jira', 'get_issue', { issue_key: 'PROJ-42' });
  assert.equal(r.ok, true);
  assert.equal(seen.url.indexOf('https://example.atlassian.net/rest/api/3/issue/PROJ-42') === 0, true, 'pinned tenant host from the validated payload');
  assert.ok(seen.url.indexOf('at3t-secret') === -1, 'the vault token never appears in the request URL');
  assert.ok(seen.headers.Authorization.indexOf('Basic ') === 0, 'the token rides only in the Basic Authorization header');
  assert.ok(r.data.echo.indexOf('at3t-secret-token-42') === -1 && r.data.echo.indexOf('REDACTED') !== -1, 'secret-shaped response text is redacted');
  const evil = makeEngine(async () => ({ status: 200, body: '{}' }), () => JSON.stringify({ host: 'https://evil.com', email: 'u@e.com', token: 'at3t-token-1234567890' }));
  assert.equal(evil.catalog.connect('jira', { userInitiated: true, scopes: ['issues.read'], credentialRef: 'vault:j' }).ok, true);
  assert.equal((await evil.engine.run('jira', 'get_issue', { issue_key: 'PROJ-42' })).reason, 'credential_invalid', 'a non-Atlassian tenant host is refused');
  const empty = makeEngine(async () => ({ status: 200, body: '{}' }), () => null);
  assert.equal(empty.catalog.connect('jira', { userInitiated: true, scopes: ['issues.read'], credentialRef: 'vault:k' }).ok, true);
  assert.equal((await empty.engine.run('jira', 'get_issue', { issue_key: 'PROJ-42' })).reason, 'credential_missing');
});

// ---- batch 16 (27 Nov 2026): musicbrainz public gates + redaction ----

test('musicbrainz connects keyless, reads on the pinned host, and redacts', async () => {
  let seen = null;
  const transport = async (req) => { seen = req; return { status: 200, body: JSON.stringify({ artists: [{ name: 'Radiohead' }] }) }; };
  const { catalog, engine } = makeEngine(transport, () => null);
  assert.equal((await engine.run('musicbrainz', 'search_artists', { query: 'x' })).reason, 'not_connected');
  const c = catalog.connect('musicbrainz', { userInitiated: true, scopes: ['recordings.read'] });
  assert.equal(c.ok, true);
  const r = await engine.run('musicbrainz', 'search_artists', { query: 'radiohead' });
  assert.equal(r.ok, true);
  assert.equal(seen.url, 'https://musicbrainz.org/ws/2/artist?query=radiohead&fmt=json&limit=20');
  assert.ok(seen.headers['User-Agent'] === 'CompanionDesk', 'the pinned user agent rides along');
  assert.deepEqual(r.data.artists, [{ name: 'Radiohead' }], 'the public response passes through; a keyless connector holds no secret to redact');
});

// ---- batch 17 (27 Nov 2026): pypi public gates ----

test('pypi connects keyless and reads on the pinned host', async () => {
  let seen = null;
  const transport = async (req) => { seen = req; return { status: 200, body: JSON.stringify({ info: { name: 'qiskit', version: '1.0.0' } }) }; };
  const { catalog, engine } = makeEngine(transport, () => null);
  assert.equal((await engine.run('pypi', 'get_package', { package: 'qiskit' })).reason, 'not_connected');
  const c = catalog.connect('pypi', { userInitiated: true, scopes: ['packages.read'] });
  assert.equal(c.ok, true);
  const r = await engine.run('pypi', 'get_package', { package: 'qiskit' });
  assert.equal(r.ok, true);
  assert.equal(seen.url, 'https://pypi.org/pypi/qiskit/json');
  assert.equal(r.data.info.name, 'qiskit');
});

// ---- batch 18 (27 Nov 2026): internet-archive public gates ----

test('internet-archive connects keyless and reads on the pinned host', async () => {
  let seen = null;
  const transport = async (req) => { seen = req; return { status: 200, body: JSON.stringify({ metadata: { identifier: 'nasa_apollo', title: 'Apollo' } }) }; };
  const { catalog, engine } = makeEngine(transport, () => null);
  assert.equal((await engine.run('internet-archive', 'get_metadata', { identifier: 'nasa_apollo' })).reason, 'not_connected');
  const c = catalog.connect('internet-archive', { userInitiated: true, scopes: ['metadata.read'] });
  assert.equal(c.ok, true);
  const r = await engine.run('internet-archive', 'get_metadata', { identifier: 'nasa_apollo' });
  assert.equal(r.ok, true);
  assert.equal(seen.url, 'https://archive.org/metadata/nasa_apollo');
  assert.equal(r.data.metadata.identifier, 'nasa_apollo');
});

// ---- batch 19 (27 Nov 2026): docker-hub public gates ----

test('docker-hub connects keyless and reads on the pinned host', async () => {
  let seen = null;
  const transport = async (req) => { seen = req; return { status: 200, body: JSON.stringify({ name: 'nginx', pull_count: 1000000 }) }; };
  const { catalog, engine } = makeEngine(transport, () => null);
  assert.equal((await engine.run('docker-hub', 'get_repository', { namespace: 'library', repository: 'nginx' })).reason, 'not_connected');
  const c = catalog.connect('docker-hub', { userInitiated: true, scopes: ['images.read'] });
  assert.equal(c.ok, true);
  const r = await engine.run('docker-hub', 'get_repository', { namespace: 'library', repository: 'nginx' });
  assert.equal(r.ok, true);
  assert.equal(seen.url, 'https://hub.docker.com/v2/repositories/library/nginx/');
  assert.equal(r.data.name, 'nginx');
});

// ---- batch 20 (27 Nov 2026): npm public gates ----

test('npm connects keyless and reads on the pinned host', async () => {
  let seen = null;
  const transport = async (req) => { seen = req; return { status: 200, body: JSON.stringify({ name: 'qiskit', 'dist-tags': { latest: '1.0.0' } }) }; };
  const { catalog, engine } = makeEngine(transport, () => null);
  assert.equal((await engine.run('npm', 'get_package', { package: 'qiskit' })).reason, 'not_connected');
  const c = catalog.connect('npm', { userInitiated: true, scopes: ['packages.read'] });
  assert.equal(c.ok, true);
  const r = await engine.run('npm', 'get_package', { package: 'qiskit' });
  assert.equal(r.ok, true);
  assert.equal(seen.url, 'https://registry.npmjs.org/qiskit');
  assert.equal(r.data['dist-tags'].latest, '1.0.0');
});

// ---- batch 21 (27 Nov 2026): todoist credential + approval gates ----

test('todoist refuses before connect, reads with a credential, and gates its create behind one approval', async () => {
  let seen = null;
  const transport = async (req) => { seen = req; return { status: 200, body: JSON.stringify([{ id: '6Xf9', name: 'Inbox' }]) }; };
  const { catalog, engine } = makeEngine(transport, 'test-token');
  assert.equal((await engine.run('todoist', 'get_tasks', {})).reason, 'not_connected');
  const c = catalog.connect('todoist', { userInitiated: true, scopes: ['tasks.read', 'tasks.write'], credentialRef: 'vault:td-cred' });
  assert.equal(c.ok, true);
  const r = await engine.run('todoist', 'get_tasks', { limit: '50' });
  assert.equal(r.ok, true);
  assert.equal(seen.url, 'https://api.todoist.com/rest/v2/tasks?limit=50');
  assert.equal(seen.headers.Authorization, 'Bearer test-token', 'the stored credential rides the request');
  assert.equal((await engine.run('todoist', 'create_task', { content: 'x' })).reason, 'approval_required', 'write without an approval refuses');
  const a = catalog.approve('todoist', 'tasks.write', { userInitiated: true });
  const w = await engine.run('todoist', 'create_task', { content: 'x' }, { approvalId: a.approvalId });
  assert.equal(w.ok, true);
  const w2 = await engine.run('todoist', 'create_task', { content: 'y' }, { approvalId: a.approvalId });
  assert.equal(w2.reason, 'approval_required', 'the spent approval is dead');
});

// ---- batch 22 (27 Nov 2026): airtable credential + approval gates ----

test('airtable refuses before connect, reads with a credential, and gates its create behind one approval', async () => {
  let seen = null;
  const transport = async (req) => { seen = req; return { status: 200, body: JSON.stringify({ bases: [] }) }; };
  const { catalog, engine } = makeEngine(transport, 'at-tok');
  assert.equal((await engine.run('airtable', 'list_records', { base_id: 'appabcdefghijkl12', table: 'T' })).reason, 'not_connected');
  const c = catalog.connect('airtable', { userInitiated: true, scopes: ['records.read', 'records.write'], credentialRef: 'vault:at-cred' });
  assert.equal(c.ok, true);
  const r = await engine.run('airtable', 'list_bases', {});
  assert.equal(r.ok, true);
  assert.equal(seen.url, 'https://api.airtable.com/v0/meta/bases');
  assert.equal(seen.headers.Authorization, 'Bearer at-tok', 'the stored credential rides the request');
  assert.equal((await engine.run('airtable', 'create_record', { base_id: 'appabcdefghijkl12', table: 'T', fields_json: '{"Name":"x"}' })).reason, 'approval_required', 'write without an approval refuses');
  const a = catalog.approve('airtable', 'records.write', { userInitiated: true });
  const w = await engine.run('airtable', 'create_record', { base_id: 'appabcdefghijkl12', table: 'T', fields_json: '{"Name":"x"}' }, { approvalId: a.approvalId });
  assert.equal(w.ok, true);
  assert.equal((await engine.run('airtable', 'create_record', { base_id: 'appabcdefghijkl12', table: 'T', fields_json: '{"Name":"y"}' }, { approvalId: a.approvalId })).reason, 'approval_required', 'the spent approval is dead');
});
// ---- batch 23 (27 Nov 2026): linear credential + approval gates ----

test('linear refuses before connect, reads with a credential, and gates its create behind one approval', async () => {
  let seen = null;
  const transport = async (req) => { seen = req; return { status: 200, body: JSON.stringify({ data: { issues: { nodes: [] } } }) }; };
  const { catalog, engine } = makeEngine(transport, 'lin-tok');
  assert.equal((await engine.run('linear', 'list_issues', {})).reason, 'not_connected');
  const c = catalog.connect('linear', { userInitiated: true, scopes: ['issues.read', 'issues.write'], credentialRef: 'vault:lin-cred' });
  assert.equal(c.ok, true);
  const r = await engine.run('linear', 'list_issues', { limit: '20' });
  assert.equal(r.ok, true);
  assert.equal(seen.url, 'https://api.linear.app/graphql');
  assert.equal(seen.headers.Authorization, 'lin-tok', 'the stored credential rides the request');
  assert.equal((await engine.run('linear', 'create_issue', { team_id: 't', title: 'x' })).reason, 'approval_required', 'write without an approval refuses');
  const a = catalog.approve('linear', 'issues.write', { userInitiated: true });
  const w = await engine.run('linear', 'create_issue', { team_id: 't', title: 'x' }, { approvalId: a.approvalId });
  assert.equal(w.ok, true);
  assert.equal((await engine.run('linear', 'create_issue', { team_id: 't', title: 'y' }, { approvalId: a.approvalId })).reason, 'approval_required', 'the spent approval is dead');
});

// ---- batch 24 (27 Nov 2026): trello credential + approval gates ----

test('trello refuses before connect, reads with the key+token credential, and gates its create behind one approval', async () => {
  let seen = null;
  const transport = async (req) => { seen = req; return { status: 200, body: JSON.stringify([]) }; };
  const { catalog, engine } = makeEngine(transport, 'key=abcdef0123456789abcdef0123456789&token=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
  assert.equal((await engine.run('trello', 'list_boards', {})).reason, 'not_connected');
  const c = catalog.connect('trello', { userInitiated: true, scopes: ['boards.read', 'boards.write'], credentialRef: 'vault:trello-cred' });
  assert.equal(c.ok, true);
  const r = await engine.run('trello', 'list_boards', {});
  assert.equal(r.ok, true);
  assert.ok(seen.url.indexOf('&key=abcdef0123456789abcdef0123456789&token=0123456789') > 0, 'the stored key and token ride the url');
  assert.equal((await engine.run('trello', 'create_card', { list_id: 'l', name: 'x' })).reason, 'approval_required', 'write without an approval refuses');
  const a = catalog.approve('trello', 'boards.write', { userInitiated: true });
  const w = await engine.run('trello', 'create_card', { list_id: 'l', name: 'x' }, { approvalId: a.approvalId });
  assert.equal(w.ok, true);
  assert.equal((await engine.run('trello', 'create_card', { list_id: 'l', name: 'y' }, { approvalId: a.approvalId })).reason, 'approval_required', 'the spent approval is dead');
});

// ---- batch 25 (27 Nov 2026): coda credential + approval gates ----

test('coda refuses before connect, reads with a credential, and gates its create behind one approval', async () => {
  let seen = null;
  const transport = async (req) => { seen = req; return { status: 200, body: JSON.stringify({ items: [] }) }; };
  const { catalog, engine } = makeEngine(transport, 'cod-tok');
  assert.equal((await engine.run('coda', 'list_docs', {})).reason, 'not_connected');
  const c = catalog.connect('coda', { userInitiated: true, scopes: ['docs.read', 'docs.write'], credentialRef: 'vault:coda-cred' });
  assert.equal(c.ok, true);
  const r = await engine.run('coda', 'list_docs', {});
  assert.equal(r.ok, true);
  assert.equal(seen.url, 'https://coda.io/apis/v1/docs?limit=25');
  assert.equal(seen.headers.Authorization, 'Bearer cod-tok', 'the stored credential rides the read');
  assert.equal((await engine.run('coda', 'create_doc', { title: 'x' })).reason, 'approval_required', 'write without an approval refuses');
  const a = catalog.approve('coda', 'docs.write', { userInitiated: true });
  const w = await engine.run('coda', 'create_doc', { title: 'x' }, { approvalId: a.approvalId });
  assert.equal(w.ok, true);
  assert.equal((await engine.run('coda', 'create_doc', { title: 'y' }, { approvalId: a.approvalId })).reason, 'approval_required', 'the spent approval is dead');
});

// ---- batch 26 (27 Nov 2026): circleci credential gates ----

test('circleci refuses before connect and reads with the credential in the Circle-Token header', async () => {
  let seen = null;
  const transport = async (req) => { seen = req; return { status: 200, body: JSON.stringify({ login: 'n' }) }; };
  const { catalog, engine } = makeEngine(transport, 'cci-tok');
  assert.equal((await engine.run('circleci', 'get_me', {})).reason, 'not_connected');
  const c = catalog.connect('circleci', { userInitiated: true, scopes: ['pipelines.read'], credentialRef: 'vault:cci-cred' });
  assert.equal(c.ok, true);
  const r = await engine.run('circleci', 'get_me', {});
  assert.equal(r.ok, true);
  assert.equal(seen.url, 'https://circleci.com/api/v2/me');
  assert.equal(seen.headers['Circle-Token'], 'cci-tok', 'the stored credential rides the read');
});

// ---- batch 27 (27 Nov 2026): mailer credential gates ----

test('sendgrid, mailgun and postmark refuse before connect and ride their credentials on reads', async () => {
  let seen = null;
  const transport = async (req) => { seen = req; return { status: 200, body: JSON.stringify([]) }; };
  const { catalog, engine } = makeEngine(transport, 'mailer-tok');
  for (const [id, action, header, scope] of [['sendgrid', 'get_scopes', 'Authorization', 'stats.read'], ['mailgun', 'list_domains', 'Authorization', 'domains.read'], ['postmark', 'get_bounces', 'X-Postmark-Server-Token', 'bounces.read']]) {
    assert.equal((await engine.run(id, action, {})).reason, 'not_connected', id + ' refuses before connect');
    const c = catalog.connect(id, { userInitiated: true, scopes: [scope], credentialRef: 'vault:' + id + '-cred' });
    assert.equal(c.ok, true, id + ' connects');
    const r = await engine.run(id, action, {});
    assert.equal(r.ok, true, id + ' reads with a credential');
    if (header === 'X-Postmark-Server-Token') { assert.equal(seen.headers[header], 'mailer-tok', id + ' header'); }
    else if (id === 'mailgun') { assert.equal(seen.headers[header], 'Basic ' + Buffer.from('api:mailer-tok').toString('base64'), id + ' credential rides the header'); }
    else { assert.equal(seen.headers[header], 'Bearer mailer-tok', id + ' credential rides the header'); }
  }
});

// ---- batch 28 (27 Nov 2026): render + supabase credential gates ----

test('render and supabase refuse before connect and ride their credentials on reads', async () => {
  let seen = null;
  const transport = async (req) => { seen = req; return { status: 200, body: JSON.stringify([]) }; };
  const { catalog, engine } = makeEngine(transport, 'dev-tok');
  for (const [id, action, scope] of [['render', 'list_services', 'services.read'], ['supabase', 'list_projects', 'tables.read']]) {
    assert.equal((await engine.run(id, action, {})).reason, 'not_connected', id + ' refuses before connect');
    const c = catalog.connect(id, { userInitiated: true, scopes: [scope], credentialRef: 'vault:' + id + '-cred' });
    assert.equal(c.ok, true, id + ' connects');
    const r = await engine.run(id, action, {});
    assert.equal(r.ok, true, id + ' reads with a credential');
    assert.ok(seen.headers.Authorization.indexOf('dev-tok') > 0, id + ' credential rides the header');
  }
});

// ---- batch 29 (27 Nov 2026): heroku credential gate ----

test('heroku refuses before connect and rides its credential on reads', async () => {
  let seen = null;
  const transport = async (req) => { seen = req; return { status: 200, body: JSON.stringify([]) }; };
  const { catalog, engine } = makeEngine(transport, 'heroku-tok');
  assert.equal((await engine.run('heroku', 'list_apps', {})).reason, 'not_connected');
  const c = catalog.connect('heroku', { userInitiated: true, scopes: ['apps.read'], credentialRef: 'vault:heroku-cred' });
  assert.equal(c.ok, true, 'heroku connects');
  const r = await engine.run('heroku', 'list_apps', {});
  assert.equal(r.ok, true, 'heroku reads with a credential');
  assert.equal(seen.headers.Authorization, 'Bearer heroku-tok', 'credential rides the header');
});

// ---- batch 30 (27 Nov 2026): sentry + pagerduty credential gates ----

test('sentry and pagerduty refuse before connect and ride their credentials on reads', async () => {
  let seen = null;
  const transport = async (req) => { seen = req; return { status: 200, body: JSON.stringify([]) }; };
  const { catalog, engine } = makeEngine(transport, 'mon-tok');
  for (const [id, action, scope] of [['sentry', 'list_org_issues', 'events.read'], ['pagerduty', 'list_incidents', 'incidents.read']]) {
    assert.equal((await engine.run(id, action, { org_slug: 'acme' })).reason, 'not_connected', id + ' refuses before connect');
    const c = catalog.connect(id, { userInitiated: true, scopes: [scope], credentialRef: 'vault:' + id + '-cred' });
    assert.equal(c.ok, true, id + ' connects');
    const r = await engine.run(id, action, id === 'sentry' ? { org_slug: 'acme' } : {});
    assert.equal(r.ok, true, id + ' reads with a credential');
    assert.ok(seen.headers.Authorization.indexOf('mon-tok') > 0, id + ' credential rides the header');
  }
});

// ---- batch 31 (27 Nov 2026): cloudflare + digitalocean credential gates ----

test('cloudflare and digitalocean refuse before connect and ride their credentials on reads', async () => {
  let seen = null;
  const transport = async (req) => { seen = req; return { status: 200, body: JSON.stringify([]) }; };
  const { catalog, engine } = makeEngine(transport, 'cloud-tok');
  for (const [id, action, scope] of [['cloudflare', 'verify_token', 'zones.read'], ['digitalocean', 'list_droplets', 'droplets.read']]) {
    assert.equal((await engine.run(id, action, {})).reason, 'not_connected', id + ' refuses before connect');
    const c = catalog.connect(id, { userInitiated: true, scopes: [scope], credentialRef: 'vault:' + id + '-cred' });
    assert.equal(c.ok, true, id + ' connects');
    const r = await engine.run(id, action, {});
    assert.equal(r.ok, true, id + ' reads with a credential');
    assert.equal(seen.headers.Authorization, 'Bearer cloud-tok', id + ' credential rides the header');
  }
});

// ---- batch 32 (27 Nov 2026): tmdb + unsplash credential gates ----

test('tmdb and unsplash refuse before connect and ride their credentials on reads', async () => {
  let seen = null;
  const transport = async (req) => { seen = req; return { status: 200, body: JSON.stringify([]) }; };
  const { catalog, engine } = makeEngine(transport, 'media-tok');
  for (const [id, action, scope] of [['tmdb', 'search_movies', 'movies.read'], ['unsplash', 'search_photos', 'photos.read']]) {
    assert.equal((await engine.run(id, action, { query: 'test' })).reason, 'not_connected', id + ' refuses before connect');
    const c = catalog.connect(id, { userInitiated: true, scopes: [scope], credentialRef: 'vault:' + id + '-cred' });
    assert.equal(c.ok, true, id + ' connects');
    const r = await engine.run(id, action, { query: 'test' });
    assert.equal(r.ok, true, id + ' reads with a credential');
    assert.ok(seen.headers.Authorization.indexOf('media-tok') > 0, id + ' credential rides the header');
  }
});
