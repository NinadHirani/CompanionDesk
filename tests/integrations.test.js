'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createIntegrationRegistry, validateManifest, SCOPES, GRANTABLE } = require('../src/integrations');

const GOOD = { id: 'demo-integration', name: 'Demo integration', version: '1.0.0', scopes: ['calendar.read'] };
const reg = () => createIntegrationRegistry({ clock: () => 1700000000000 });

test('manifest validation refuses every malformed shape', () => {
  assert.equal(validateManifest(null), 'bad_manifest');
  assert.equal(validateManifest([]), 'bad_manifest');
  assert.equal(validateManifest({ ...GOOD, extra: 1 }), 'unknown_field:extra');
  assert.equal(validateManifest({ ...GOOD, id: 'X' }), 'bad_id');
  assert.equal(validateManifest({ ...GOOD, version: '1.0' }), 'bad_version');
  assert.equal(validateManifest({ ...GOOD, name: '' }), 'bad_name');
  assert.equal(validateManifest({ ...GOOD, scopes: [] }), 'no_scopes');
  assert.equal(validateManifest({ ...GOOD, scopes: ['*'] }), 'wildcard_refused');
  assert.equal(validateManifest({ ...GOOD, scopes: ['made.up.scope'] }), 'unknown_scope:made.up.scope');
  assert.equal(validateManifest({ ...GOOD, scopes: ['credentials.read'] }), 'forbidden_scope:credentials.read');
  assert.equal(validateManifest({ ...GOOD, scopes: ['shell.exec'] }), 'forbidden_scope:shell.exec');
  assert.equal(validateManifest({ ...GOOD, scopes: ['calendar.read', 'calendar.read'] }), 'duplicate_scope');
  assert.equal(validateManifest(GOOD), null);
});

test('registration is explicit, frozen, audited and unique per id; nothing auto-connects', () => {
  const r = reg();
  assert.deepEqual(r.list(), [], 'the registry ships empty');
  const first = r.register(GOOD);
  assert.equal(first.ok, true);
  assert.equal(Object.isFrozen(first.manifest), true);
  assert.equal(Object.isFrozen(first.manifest.scopes), true);
  assert.equal(first.audit.action, 'integrations.registered');
  assert.deepEqual(first.audit.declaredScopes, ['calendar.read']);
  assert.equal(r.list()[0].connected, false, 'a registered manifest is never connected on its own');
  assert.equal(r.register(GOOD).reason, 'id_already_registered');
  assert.equal(r.register({ ...GOOD, id: 'demo-integration', version: '2.0.0' }).reason, 'id_already_registered', 'a new version is a new review, never a silent swap');
});

test('connect grants only a declared, non-empty subset and records consent', () => {
  const r = reg();
  const m = { id: 'multi', name: 'Multi', version: '0.1.0', scopes: ['calendar.read', 'notes.write'] };
  r.register(m);
  assert.equal(r.connect('multi', { scopes: [] }).reason, 'no_scopes');
  assert.equal(r.connect('multi', { scopes: ['calendar.write'] }).reason, 'scope_not_declared:calendar.write', 'a scope the manifest did not declare is never granted');
  assert.equal(r.connect('multi', { scopes: ['credentials.read'] }).reason, 'scope_not_declared:credentials.read', 'the manifest could never have declared a forbidden scope, so the subset rule names the miss');
  const ok = r.connect('multi', { scopes: ['calendar.read'] });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.granted, ['calendar.read']);
  assert.equal(ok.audit.action, 'integrations.connected');
  assert.equal(r.list()[0].grantedScopes.join(','), 'calendar.read');
  assert.equal(r.connect('multi', { scopes: ['notes.write'] }).reason, 'already_connected', 'grants are never widened in place');
});

test('disconnect clears every grant and is idempotent-checked', () => {
  const r = reg();
  r.register(GOOD);
  assert.equal(r.disconnect('demo-integration').reason, 'not_connected');
  r.connect('demo-integration', { scopes: ['calendar.read'] });
  const d = r.disconnect('demo-integration');
  assert.equal(d.ok, true);
  assert.deepEqual(d.audit.clearedScopes, ['calendar.read']);
  const row = r.list()[0];
  assert.equal(row.connected, false);
  assert.deepEqual(row.grantedScopes, []);
});

test('revocation is stronger than disconnect and blocks reconnect until readmission', () => {
  const r = reg();
  r.register(GOOD);
  r.connect('demo-integration', { scopes: ['calendar.read'] });
  const rev = r.revoke('demo-integration');
  assert.equal(rev.ok, true);
  assert.deepEqual(rev.audit.clearedScopes, ['calendar.read']);
  assert.equal(r.connect('demo-integration', { scopes: ['calendar.read'] }).reason, 'revoked');
  assert.equal(r.readmit('demo-integration').ok, true);
  assert.equal(r.connect('demo-integration', { scopes: ['calendar.read'] }).ok, true, 'reconnection after readmission is still an explicit connect');
  assert.equal(r.readmit('demo-integration').reason, 'not_revoked');
  assert.equal(r.revoke('nope').reason, 'unknown_integration');
});

test('authorizeCall is the only door; no wildcard, no scope inheritance', () => {
  const r = reg();
  assert.equal(r.authorizeCall('demo-integration', 'calendar.read').reason, 'unknown_integration');
  r.register(GOOD);
  assert.equal(r.authorizeCall('demo-integration', 'calendar.read').reason, 'not_connected');
  r.connect('demo-integration', { scopes: ['calendar.read'] });
  assert.equal(r.authorizeCall('demo-integration', '*').allowed, false);
  assert.equal(r.authorizeCall('demo-integration', 'notes.write').reason, 'scope_not_granted');
  const ok = r.authorizeCall('demo-integration', 'calendar.read');
  assert.deepEqual(ok, { allowed: true, capability: 'read_only' });
  r.revoke('demo-integration');
  assert.equal(r.authorizeCall('demo-integration', 'calendar.read').reason, 'revoked');
});

test('the scope catalog is least-privilege and the forbidden class can never be granted', () => {
  assert.equal(SCOPES['shell.exec'], 'forbidden');
  assert.equal(SCOPES['credentials.read'], 'forbidden');
  assert.ok(!GRANTABLE.includes('shell.exec'));
  assert.ok(!GRANTABLE.includes('credentials.read'));
  assert.ok(GRANTABLE.includes('calendar.read'));
  assert.equal(GRANTABLE.length, Object.keys(SCOPES).length - 2, 'exactly the two forbidden scopes are ungrantable');
});

test('unknown integrations are refused everywhere; audits carry ids and scopes only', () => {
  const r = reg();
  assert.equal(r.connect('nope', { scopes: ['calendar.read'] }).reason, 'unknown_integration');
  const a = r.register(GOOD).audit;
  assert.deepEqual(Object.keys(a).sort(), ['action', 'at', 'declaredScopes', 'id', 'version']);
  assert.equal(typeof a.at, 'number');
});
