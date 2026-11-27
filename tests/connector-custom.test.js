'use strict';

// Red-first tests for the custom-connector surface (27 Nov 2026, Ninad's
// connector marketplace instruction): a user may add a connector for an
// app/website that is not in the built-in catalog. Fail-closed rules:
//  - adding and removing are explicit user actions (userInitiated:true),
//  - the auth type comes from a safe allowlist and every unsupported or
//    unimplemented integration is LABELLED, never faked (authorizeCall
//    refuses custom connectors with integration_not_implemented),
//  - URLs are https-only (http accepted for loopback hosts only), refuse
//    userinfo and query strings so secrets can never ride in the URL,
//  - scopes follow the exact declared-scope rules, custom entries are
//    bounded, removal requires the user and refuses connected entries,
//  - snapshot/restore round-trips custom definitions strictly and never
//    writes an URL, secret or credential material into the audit log.

const { test } = require('node:test');
const assert = require('node:assert');
const { createConnectorCatalog } = require('../src/connectors');

function mk(overrides) {
  return Object.assign({
    userInitiated: true,
    id: 'my-service',
    name: 'My Service',
    authType: 'webhook',
    url: 'https://example.com/hook',
    scopes: [{ name: 'events.read', class: 'read_only' }, { name: 'events.write', class: 'write' }],
  }, overrides || {});
}

test('adding a custom connector requires an explicit user action', () => {
  const c = createConnectorCatalog({});
  const r = c.addCustomConnector(mk({ userInitiated: false }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'requires_user_action');
});

test('a valid custom connector registers as discovered and is labelled honestly', () => {
  const c = createConnectorCatalog({});
  const r = c.addCustomConnector(mk(null));
  assert.equal(r.ok, true);
  assert.equal(c.state('my-service'), 'discovered');
  const e = c.describe('my-service');
  assert.equal(e.custom, true);
  assert.equal(e.integrationImplemented, false);
  assert.ok(/not implemented/i.test(e.readinessNote));
  const listed = c.list().find((x) => x.id === 'my-service');
  assert.equal(listed.custom, true);
  assert.equal(listed.integrationImplemented, false);
});

test('http URLs are refused except loopback hosts', () => {
  const c = createConnectorCatalog({});
  assert.equal(c.addCustomConnector(mk({ url: 'http://example.com/hook' })).reason, 'url_invalid');
  const loop = c.addCustomConnector(mk({ id: 'local-thing', url: 'http://localhost:8080/api' }));
  assert.equal(loop.ok, true);
  const ip = c.addCustomConnector(mk({ id: 'local-ip', url: 'http://127.0.0.1:3000/api' }));
  assert.equal(ip.ok, true);
});

test('URLs carrying userinfo or query strings are refused', () => {
  const c = createConnectorCatalog({});
  assert.equal(c.addCustomConnector(mk({ url: 'https://user:pass@example.com/' })).reason, 'url_invalid');
  assert.equal(c.addCustomConnector(mk({ url: 'https://example.com/?api_key=SECRET' })).reason, 'url_invalid');
});

test('url is required for oauth2, webhook and website types; api_key needs none', () => {
  const c = createConnectorCatalog({});
  assert.equal(c.addCustomConnector(mk({ authType: 'oauth2', url: undefined })).reason, 'url_required');
  assert.equal(c.addCustomConnector(mk({ authType: 'website', url: undefined })).reason, 'url_required');
  const key = c.addCustomConnector(mk({ id: 'keyed', authType: 'api_key', url: undefined }));
  assert.equal(key.ok, true);
});

test('unknown auth types are refused', () => {
  const c = createConnectorCatalog({});
  assert.equal(c.addCustomConnector(mk({ authType: 'magic' })).reason, 'auth_type_invalid');
});

test('ids must be new and well-formed', () => {
  const c = createConnectorCatalog({});
  assert.equal(c.addCustomConnector(mk({ id: 'rss' })).reason, 'id_taken');
  assert.equal(c.addCustomConnector(mk({ id: 'Bad Id' })).reason, 'id_invalid');
  const ok = c.addCustomConnector(mk(null));
  assert.equal(c.addCustomConnector(mk({})).reason, 'id_taken');
  assert.equal(ok.ok, true);
});

test('scopes follow the exact declared-scope rules', () => {
  const c = createConnectorCatalog({});
  assert.equal(c.addCustomConnector(mk({ scopes: [] })).reason, 'requires_explicit_scopes');
  assert.equal(c.addCustomConnector(mk({ scopes: [{ name: 'Bad!', class: 'read_only' }] })).reason, 'scope_invalid');
  assert.equal(c.addCustomConnector(mk({ scopes: [{ name: 'thing.write', class: 'nonsense' }] })).reason, 'scope_invalid');
});

test('custom entries are bounded', () => {
  const c = createConnectorCatalog({});
  for (let i = 0; i < 50; i++) {
    const r = c.addCustomConnector(mk({ id: 'custom-' + i }));
    assert.equal(r.ok, true, 'entry ' + i);
  }
  assert.equal(c.addCustomConnector(mk({ id: 'custom-over' })).reason, 'limit_reached');
});

test('the connect gate applies unchanged; authorizeCall refuses custom connectors', () => {
  const c = createConnectorCatalog({});
  c.addCustomConnector(mk(null));
  assert.equal(c.connect('my-service', { userInitiated: false }).reason, 'requires_user_action');
  const r = c.connect('my-service', { userInitiated: true, scopes: ['events.read', 'events.write'], credentialRef: 'vault:my-service-1' });
  assert.equal(r.ok, true);
  assert.equal(c.state('my-service'), 'connected');
  const a = c.authorizeCall('my-service', 'events.read', {});
  assert.equal(a.allowed, false);
  assert.equal(a.reason, 'integration_not_implemented');
  const ap = c.approve('my-service', 'events.write', { userInitiated: true });
  assert.equal(ap.ok, true);
  const a2 = c.authorizeCall('my-service', 'events.write', { approvalId: ap.approvalId });
  assert.equal(a2.allowed, false);
  assert.equal(a2.reason, 'integration_not_implemented');
});

test('removal is user-initiated, refuses connected entries and built-ins', () => {
  const c = createConnectorCatalog({});
  c.addCustomConnector(mk(null));
  assert.equal(c.removeCustomConnector('my-service', { userInitiated: false }).reason, 'requires_user_action');
  assert.equal(c.removeCustomConnector('rss', { userInitiated: true }).reason, 'not_custom');
  assert.equal(c.removeCustomConnector('nope', { userInitiated: true }).reason, 'unknown_connector');
  c.connect('my-service', { userInitiated: true, scopes: ['events.read'], credentialRef: 'vault:my-service-1' });
  assert.equal(c.removeCustomConnector('my-service', { userInitiated: true }).reason, 'disconnect_first');
  assert.equal(c.disconnect('my-service', { userInitiated: true }).ok, true);
  const r = c.removeCustomConnector('my-service', { userInitiated: true });
  assert.equal(r.ok, true);
  assert.equal(c.describe('my-service'), null);
  assert.equal(c.state('my-service'), null);
});

test('snapshot and restore round-trip custom definitions and their connection state', () => {
  const a = createConnectorCatalog({});
  a.addCustomConnector(mk({ authType: 'api_key', url: undefined }));
  a.connect('my-service', { userInitiated: true, scopes: ['events.read'], credentialRef: 'vault:my-service-1' });
  const snap = a.snapshot();
  assert.ok(Array.isArray(snap.customs) && snap.customs.length === 1);
  const b = createConnectorCatalog({});
  const r = b.restore(snap);
  assert.equal(r.ok, true);
  const e = b.describe('my-service');
  assert.equal(e.custom, true);
  assert.equal(b.state('my-service'), 'connected');
  assert.equal(b.authorizeCall('my-service', 'events.read', {}).reason, 'integration_not_implemented');
});

test('restore fails closed on an invalid custom definition', () => {
  const a = createConnectorCatalog({});
  a.addCustomConnector(mk({ authType: 'api_key', url: undefined }));
  const snap = a.snapshot();
  snap.customs[0].url = 'http://example.com/?leak=1';
  const b = createConnectorCatalog({});
  const r = b.restore(snap);
  assert.equal(r.ok, false);
  assert.ok(r.problems.indexOf('bad_custom') !== -1);
  assert.equal(b.describe('my-service'), null);
});

test('the audit log never carries the URL or any definition detail beyond ids, actions and scopes', () => {
  const c = createConnectorCatalog({});
  c.addCustomConnector(mk({ url: 'https://very-secret-host.example/hook' }));
  c.connect('my-service', { userInitiated: true, scopes: ['events.read'], credentialRef: 'vault:my-service-1' });
  const text = JSON.stringify(c.audit());
  assert.ok(text.indexOf('very-secret-host') === -1);
  assert.ok(text.indexOf('https://') === -1);
});
