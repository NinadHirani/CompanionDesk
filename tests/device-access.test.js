'use strict';
const test = require('node:test');
const assert = require('node:assert');
const da = require('../src/device-access.js');

const T = () => 1000;

test('nothing is possible without explicit grants; no wildcard app ids or scopes', () => {
  const c = da.createDeviceAccessCentre({ clock: T, platform: 'darwin' });
  assert.equal(da.UNRESTRICTED_DEVICE_ACCESS, false);
  assert.equal(c.authorize('appA', 'files_read', { scope: 'downloads' }).allowed, false);
  const g = c.grant('appA', 'files_read', { scopes: ['downloads'], userInitiated: true });
  assert.equal(g.ok, true);
  assert.equal(c.authorize('appA', 'files_read', { scope: '*' }).allowed, false);
  assert.equal(c.authorize('appB', 'files_read', { scope: 'downloads' }).allowed, false);
  assert.equal(c.authorize('appA', 'screen_capture', { scope: 'window' }).allowed, false);
});

test('grants without a user action are refused, whatever the caller says', () => {
  const c = da.createDeviceAccessCentre({ clock: T, platform: 'darwin' });
  assert.equal(c.grant('appA', 'files_read', { scopes: ['x'] }).reason, 'requires_user_action');
  assert.equal(c.enable('ui_automation').reason, 'requires_user_action');
  assert.equal(c.osPermissionRequest('microphone').reason, 'permission_requires_user_action');
  assert.equal(c.list().length, 0);
});

test('least privilege: scopes are exact, wider scopes are refused, grants are per app and capability', () => {
  const c = da.createDeviceAccessCentre({ clock: T, platform: 'android' });
  c.grant('appA', 'files_read', { scopes: ['downloads'], userInitiated: true });
  assert.equal(c.authorize('appA', 'files_read', { scope: 'downloads' }).allowed, true);
  assert.equal(c.authorize('appA', 'files_read', { scope: 'photos' }).reason, 'scope_not_granted');
  assert.equal(c.authorize('appA', 'files_read', { scope: 'downloads/*' }).reason, 'scope_not_granted');
});

test('write-ish capabilities require an approval digest; read-only does not', () => {
  const c = da.createDeviceAccessCentre({ clock: T, platform: 'darwin' });
  c.grant('appA', 'files_write', { scopes: ['~/notes'], userInitiated: true });
  assert.equal(c.authorize('appA', 'files_write', { scope: '~/notes' }).reason, 'approval_required');
  assert.equal(c.authorize('appA', 'files_write', { scope: '~/notes', approvalDigest: 'd1' }).allowed, true);
  c.grant('appB', 'calendar_read', { scopes: ['primary'], userInitiated: true });
  assert.equal(c.authorize('appB', 'calendar_read', { scope: 'primary' }).allowed, true);
});

test('revocation is immediate and per app; the audit log keeps the trail', () => {
  const c = da.createDeviceAccessCentre({ clock: T, platform: 'darwin' });
  c.grant('appA', 'files_read', { scopes: ['downloads'], userInitiated: true });
  c.grant('appA', 'files_write', { scopes: ['~/notes'], userInitiated: true });
  c.grant('appB', 'files_read', { scopes: ['downloads'], userInitiated: true });
  c.revoke('appA', 'files_read');
  assert.equal(c.authorize('appA', 'files_read', { scope: 'downloads' }).allowed, false);
  assert.equal(c.authorize('appA', 'files_write', { scope: '~/notes', approvalDigest: 'd' }).allowed, true);
  assert.equal(c.authorize('appB', 'files_read', { scope: 'downloads' }).allowed, true);
  c.revokeApp('appA');
  assert.equal(c.authorize('appA', 'files_write', { scope: '~/notes', approvalDigest: 'd' }).allowed, false);
  const actions = c.listAudit().map((a) => a.action);
  assert.ok(actions.includes('device_access.granted'));
  assert.ok(actions.includes('device_access.revoked'));
});

test('OS permission requests are per capability, only on user action, never bulk or startup', () => {
  const c = da.createDeviceAccessCentre({ clock: T, platform: 'darwin' });
  const r = c.osPermissionRequest('microphone', { userInitiated: true });
  assert.equal(r.ok, true);
  assert.equal(r.osPermission, 'microphone');
  assert.equal(c.osPermissionRequest('ui_automation', { userInitiated: true }).reason, 'capability_not_enabled');
  c.enable('ui_automation', { userInitiated: true });
  assert.equal(c.osPermissionRequest('ui_automation', { userInitiated: true }).ok, true);
  const n = c.listAudit().filter((a) => a.action === 'device_access.os_permission_request').length;
  assert.equal(n, 2); // microphone once, ui_automation once; each ask is its own logged, user-actioned event
});

test('ui_automation is desktop-only and needs the explicit enable; mobile-only caps refuse on desktop', () => {
  const c = da.createDeviceAccessCentre({ clock: T, platform: 'android' });
  assert.equal(da.supports('ui_automation', 'android'), false);
  assert.equal(c.grant('appA', 'ui_automation', { scopes: ['x'], userInitiated: true }).reason, 'unsupported_platform');
  const mac = da.createDeviceAccessCentre({ clock: T, platform: 'darwin' });
  assert.equal(mac.grant('appA', 'location_read', { scopes: ['x'], userInitiated: true }).reason, 'unsupported_platform');
  assert.equal(mac.grant('appA', 'ui_automation', { scopes: ['x'], userInitiated: true }).reason, 'capability_not_enabled');
  mac.enable('ui_automation', { userInitiated: true });
  assert.equal(mac.grant('appA', 'ui_automation', { scopes: ['x'], userInitiated: true }).ok, true);
});

test('purchase is a sensitive capability needing grant plus approval, never silent', () => {
  const c = da.createDeviceAccessCentre({ clock: T, platform: 'android' });
  c.grant('shop', 'purchase', { scopes: ['companiondesk-store'], userInitiated: true });
  assert.equal(c.authorize('shop', 'purchase', { scope: 'companiondesk-store' }).reason, 'approval_required');
  assert.equal(c.authorize('shop', 'purchase', { scope: 'companiondesk-store', approvalDigest: 'ok' }).allowed, true);
});

test('bad inputs fail closed, catalog is frozen and complete', () => {
  const c = da.createDeviceAccessCentre({ clock: T, platform: 'darwin' });
  assert.equal(c.grant('appA', 'not_real', { scopes: ['x'], userInitiated: true }).reason, 'unknown_capability');
  assert.equal(c.grant('*', 'files_read', { scopes: ['x'], userInitiated: true }).reason, 'bad_app_id');
  assert.equal(c.grant('appA', 'files_read', { scopes: [], userInitiated: true }).reason, 'no_scopes');
  assert.equal(c.grant('appA', 'files_read', { scopes: ['x', 'x'], userInitiated: true }).reason, 'duplicate_scope');
  assert.equal(c.grant('appA', 'files_read', { scopes: ['x'], userInitiated: true }).ok, true);
  assert.throws(() => da.createDeviceAccessCentre({ platform: '' }));
  assert.equal(Object.isFrozen(da.CATALOG), true);
});

test('sensitive capabilities carry a visible indicator requirement', () => {
  assert.equal(da.CATALOG.microphone.indicator, 'visible_while_active');
  assert.equal(da.CATALOG.screen_capture.indicator, 'visible_while_active');
  assert.equal(da.CATALOG.ui_automation.indicator, 'visible_while_active');
  assert.equal(da.CATALOG.files_read.indicator, 'none');
});

test('an explicit enable is reversible: disable needs a user action, kills every grant of the capability first', () => {
  const c = da.createDeviceAccessCentre({ clock: T, platform: 'darwin' });
  assert.equal(c.disable('ui_automation', { userInitiated: true }).reason, 'not_enabled');
  assert.equal(c.enable('ui_automation', { userInitiated: true }).ok, true);
  c.grant('appA', 'ui_automation', { scopes: ['typing'], userInitiated: true });
  c.grant('appB', 'ui_automation', { scopes: ['typing'], userInitiated: true });
  assert.equal(c.disable('ui_automation').reason, 'requires_user_action');
  assert.equal(c.disable('ui_automation', { userInitiated: true }).ok, true);
  assert.equal(c.authorize('appA', 'ui_automation', { scope: 'typing' }).allowed, false);
  assert.equal(c.authorize('appB', 'ui_automation', { scope: 'typing' }).allowed, false);
  assert.equal(c.grant('appA', 'ui_automation', { scopes: ['typing'], userInitiated: true }).reason, 'capability_not_enabled');
  const actions = c.listAudit().map((a) => a.action);
  assert.ok(actions.includes('device_access.disabled'));
  assert.ok(actions.filter((a) => a === 'device_access.revoked').length >= 2);
});

test('grant scopes are typed, non-empty, length-capped, count-capped; nothing is recorded on refusal', () => {
  const c = da.createDeviceAccessCentre({ clock: T, platform: 'darwin' });
  assert.equal(c.grant('appA', 'files_read', { scopes: [42], userInitiated: true }).reason, 'scope_invalid');
  assert.equal(c.grant('appA', 'files_read', { scopes: [''], userInitiated: true }).reason, 'scope_invalid');
  assert.equal(c.grant('appA', 'files_read', { scopes: ['x'.repeat(121)], userInitiated: true }).reason, 'scope_invalid');
  assert.equal(c.grant('appA', 'files_read', { scopes: Array.from({ length: 33 }, (_, i) => 's' + i), userInitiated: true }).reason, 'too_many_scopes');
  assert.equal(c.list().length, 0);
  assert.equal(c.grant('appA', 'files_read', { scopes: ['x'.repeat(120)], userInitiated: true }).ok, true);
  assert.equal(c.authorize('appA', 'files_read', { scope: 'x'.repeat(120) }).allowed, true);
});

test('the audit log is bounded in memory and keeps the newest entries', () => {
  const c = da.createDeviceAccessCentre({ clock: T, platform: 'darwin' });
  let t = 1000;
  const clock = () => ++t;
  const c2 = da.createDeviceAccessCentre({ clock, platform: 'darwin' });
  for (let i = 0; i < da.MAX_AUDIT + 50; i++) c2.grant('app' + (i % 3), 'files_read', { scopes: ['s' + i], userInitiated: true });
  const audit = c2.listAudit();
  assert.equal(audit.length, da.MAX_AUDIT);
  assert.equal(audit[0].action, 'device_access.granted');
  assert.ok(audit[0].at > 1000 + 50);
});
