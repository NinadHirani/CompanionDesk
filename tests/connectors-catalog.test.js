'use strict';
const test = require('node:test');
const assert = require('node:assert');
const cc = require('../src/connectors.js');

const T = () => 1700000000000;

test('the module is pure: importing it connects nothing and every connector starts discovered', () => {
  const c = cc.createConnectorCatalog({ clock: T });
  assert.equal(cc.AUTO_CONNECT, false);
  assert.equal(c.list().length > 10, true, 'the catalog ships broad');
  for (const e of c.list()) assert.equal(c.state(e.id), 'discovered');
});

test('discovery is free-first and paid entries sort last', () => {
  const c = cc.createConnectorCatalog({ clock: T });
  const all = c.list();
  const first = all[0], last = all[all.length - 1];
  assert.equal(first.costModel === 'free_open_source' && first.hosting !== 'cloud_paid', true);
  assert.equal(last.costModel, 'paid');
  const ranks = all.map(e => cc.COST_RANK[e.costModel]);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), 'cost rank never regresses');
});

test('every catalog entry declares cost and limits BEFORE activation, and a paid entry exists to prove the clarity rule', () => {
  const c = cc.createConnectorCatalog({ clock: T });
  for (const e of c.list()) {
    const d = c.describe(e.id);
    assert.equal(typeof d.costNote, 'string');
    assert.ok(d.costNote.length >= 8, `${e.id} needs a real cost note`);
    assert.equal(typeof d.limits, 'string');
    assert.ok(d.limits.length >= 8, `${e.id} needs a real limits note`);
    assert.ok(Array.isArray(d.scopes) && d.scopes.length > 0);
  }
  assert.equal(c.list({ costModel: 'paid' }).length >= 1, true, 'a paid-only entry shows what paid means');
});

test('self-hostable and local-first filtering works', () => {
  const c = cc.createConnectorCatalog({ clock: T });
  const local = c.list({ hosting: 'local' });
  assert.ok(local.length >= 2);
  for (const e of local) assert.equal(e.hosting, 'local');
  const sh = c.list({ selfHostable: true });
  for (const e of sh) assert.equal(e.selfHostable, true);
  const combined = c.list({ hosting: 'local', selfHostable: true });
  for (const e of combined) assert.equal(e.hosting === 'local' || e.selfHostable === true, true);
});

test('nothing connects without an explicit user action, exact scopes, and a credential reference', () => {
  const c = cc.createConnectorCatalog({ clock: T });
  assert.equal(c.autoConnect, undefined, 'no blanket auto-connect API exists');
  assert.equal(c.connect('github', { scopes: ['repos.read'] }).reason, 'requires_user_action');
  assert.equal(c.connect('github', { scopes: ['repos.read'], userInitiated: true }).reason, 'credential_ref_required');
  assert.equal(c.connect('github', { scopes: [], userInitiated: true, credentialRef: 'keychain:gh-1' }).reason, 'requires_explicit_scopes');
  assert.equal(c.connect('github', { scopes: ['repos.read', 'nope.read'], userInitiated: true, credentialRef: 'keychain:gh-1' }).reason, 'scope_not_declared');
  assert.equal(c.state('github'), 'discovered');
});

test('credential references are opaque: raw secrets are refused and never stored or echoed', () => {
  const c = cc.createConnectorCatalog({ clock: T });
  const r = c.connect('github', { scopes: ['repos.read'], userInitiated: true, credentialRef: 'keychain:gh-prod-1' });
  assert.equal(r.ok, true, 'a keychain-style opaque ref is accepted');
  assert.equal(c.connect('github', { scopes: ['repos.read'], userInitiated: true, credentialRef: 'raw-token-pasted-inline' }).reason, 'already_connected');
  assert.equal(c.state('github'), 'connected');
  const bad = c.connect('gitlab', { scopes: ['projects.read'], userInitiated: true, credentialRef: 'raw secret with spaces' });
  assert.equal(bad.reason, 'credential_ref_invalid');
  const tooLong = c.connect('gitlab', { scopes: ['projects.read'], userInitiated: true, credentialRef: 'x'.repeat(200) });
  assert.equal(tooLong.reason, 'credential_ref_invalid');
  assert.equal(c.state('gitlab'), 'discovered', 'gitlab stays unconnected after refusals');
  assert.equal(c.audit().some(e => JSON.stringify(e).includes('raw secret')), false, 'the audit never carries a secret-looking value');
});

test('grants are exact least-privilege: no wildcards, never widened after connect', () => {
  const c = cc.createConnectorCatalog({ clock: T });
  c.connect('github', { scopes: ['repos.read'], userInitiated: true, credentialRef: 'keychain:gh-1' });
  assert.equal(c.authorizeCall('github', '*').allowed, false);
  assert.equal(c.authorizeCall('github', 'issues.write').allowed, false, 'not granted at connect');
  assert.equal(c.connect('github', { scopes: ['repos.read', 'issues.write'], userInitiated: true, credentialRef: 'keychain:gh-1' }).reason, 'already_connected', 'widening is refused; disconnect + reconnect is the path');
});

test('lifecycle: disconnect, reconnect, revoke, and revoke blocks reconnection until explicit readmission', () => {
  const c = cc.createConnectorCatalog({ clock: T });
  c.connect('rss', { scopes: ['feed.read'], userInitiated: true, credentialRef: 'keychain:rss-1' });
  assert.equal(c.disconnect('rss', { userInitiated: true }).ok, true);
  assert.equal(c.state('rss'), 'disconnected');
  assert.equal(c.authorizeCall('rss', 'feed.read').allowed, false);
  c.reconnect('rss', { scopes: ['feed.read'], userInitiated: true, credentialRef: 'keychain:rss-1' });
  assert.equal(c.state('rss'), 'connected');
  c.revoke('rss', { userInitiated: true });
  assert.equal(c.state('rss'), 'revoked');
  assert.equal(c.reconnect('rss', { scopes: ['feed.read'], userInitiated: true, credentialRef: 'keychain:rss-1' }).reason, 'revoked_requires_readmit');
  c.readmit('rss', { userInitiated: true });
  assert.equal(c.state('rss'), 'discovered', 'readmission returns it to discovery, never auto-connects');
  assert.equal(c.connect('rss', { scopes: ['feed.read'], userInitiated: true, credentialRef: 'keychain:rss-1' }).ok, true);
});

test('approval gates: write/send/delete/external/sensitive scopes need a per-scope approval, read-only does not', () => {
  const c = cc.createConnectorCatalog({ clock: T });
  const CLASSES = c.SCOPE_CLASSES;
  for (const cls of ['write', 'send', 'delete', 'external', 'sensitive']) assert.equal(CLASSES[cls].requiresApproval, true);
  assert.equal(CLASSES.read_only.requiresApproval, false);
  c.connect('github', { scopes: ['repos.read', 'issues.write'], userInitiated: true, credentialRef: 'keychain:gh-1' });
  assert.equal(c.authorizeCall('github', 'repos.read').allowed, true, 'read-only needs no approval');
  assert.equal(c.authorizeCall('github', 'issues.write').allowed, false);
  assert.equal(c.authorizeCall('github', 'issues.write').reason, 'approval_required');
  const a = c.approve('github', 'issues.write', { userInitiated: true });
  assert.equal(a.ok, true);
  assert.equal(c.authorizeCall('github', 'issues.write', { approvalId: a.approvalId }).allowed, true);
  assert.equal(c.authorizeCall('github', 'issues.write', { approvalId: a.approvalId }).allowed, false, 'an approval is single-use');
});

test('approvals are explicit too: no user action, wrong connector, or unknown scope is refused', () => {
  const c = cc.createConnectorCatalog({ clock: T });
  assert.equal(c.approve('github', 'issues.write').reason, 'requires_user_action');
  assert.equal(c.approve('github', 'nope.write', { userInitiated: true }).reason, 'scope_not_declared');
  assert.equal(c.approve('github', 'repos.read', { userInitiated: true }).reason, 'approval_not_needed');
  c.connect('mastodon', { scopes: ['timeline.read'], userInitiated: true, credentialRef: 'keychain:mstdn-1' });
  assert.equal(c.approve('mastodon', 'post.write', { userInitiated: true }).reason, 'not_connected');
});

test('the catalog is extensible through reviewed registration only: validation is strict, registration never connects', () => {
  const c = cc.createConnectorCatalog({ clock: T });
  assert.equal(c.registerConnector({ id: 'ab', name: 'x', costModel: 'free_tier', costNote: 'free tier', limits: '10k calls/day', scopes: [{ name: 'a.read', class: 'read_only' }] }).reason, 'id_invalid');
  assert.equal(c.registerConnector({ id: 'valid-app', name: 'Valid App', costModel: 'free_tier', costNote: 'free tier', limits: '10k calls/day', scopes: [] }).reason, 'requires_explicit_scopes');
  assert.equal(c.registerConnector({ id: 'valid-app', name: 'Valid App', costModel: 'weird', costNote: 'free tier', limits: '10k calls/day', scopes: [{ name: 'a.read', class: 'read_only' }] }).reason, 'cost_model_invalid');
  const ok = c.registerConnector({ id: 'valid-app', name: 'Valid App', costModel: 'free_tier', costNote: 'free tier', limits: '10k calls/day', scopes: [{ name: 'a.read', class: 'read_only' }] });
  assert.equal(ok.ok, true);
  assert.equal(c.state('valid-app'), 'discovered', 'registration is discovery only');
  assert.equal(c.registerConnector({ id: 'valid-app', name: 'Valid App', costModel: 'free_tier', costNote: 'free tier', limits: '10k calls/day', scopes: [{ name: 'a.read', class: 'read_only' }] }).reason, 'id_taken');
});

test('audit carries accepted state changes only, with ids, actions and scopes; refusals append nothing', () => {
  const c = cc.createConnectorCatalog({ clock: T });
  assert.equal(c.audit().length, 0);
  const before = c.audit().length;
  c.connect('github', { scopes: [] }); // refused, no entry
  assert.equal(c.audit().length, before);
  c.connect('github', { scopes: ['repos.read'], userInitiated: true, credentialRef: 'keychain:gh-1' });
  const log = c.audit();
  assert.equal(log.length, before + 1);
  assert.equal(log[log.length - 1].action, 'connect');
  assert.deepEqual(log[log.length - 1].scopes, ['repos.read']);
  assert.equal(JSON.stringify(log).includes('keychain:gh-1'), false, 'audit entries carry no credential references');
});

// ---- batch 7 (27 Nov 2026): keyless public connectors ----

test('keyless public connectors connect without a credential reference', () => {
  const c = cc.createConnectorCatalog({});
  const r = c.connect('arxiv', { scopes: ['papers.read'], userInitiated: true });
  assert.equal(r.ok, true, 'a public API needs no vault ref');
  const bad = c.connect('crossref', { scopes: ['works.read'], userInitiated: true, credentialRef: 'not a ref!' });
  assert.equal(bad.reason, 'credential_ref_invalid', 'a given ref is still validated');
  const secreted = c.connect('openalex', { scopes: ['works.read'], userInitiated: true, credentialRef: 'vault:oa-cred' });
  assert.equal(secreted.ok, true, 'a ref stays accepted when one is given');
});
