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
