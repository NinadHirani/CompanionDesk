'use strict';

// Approval-digest presence pin (28 Nov 2026): authorize() treated any
// string as a present approval digest, so an empty string satisfied the
// approval requirement for sensitive/reversible_write capabilities. The
// module's own contract is fail closed ("a fresh approval digest for the
// exact action"); an empty string is no digest. Absence and emptiness
// refuse alike; a real digest still authorizes.

const test = require('node:test');
const assert = require('node:assert');
const { createDeviceAccessCentre } = require('../src/device-access');

test('an empty approval digest never satisfies the approval requirement', () => {
  const c = createDeviceAccessCentre({ clock: () => 1732783200000, platform: 'darwin' });
  const g = c.grant('appA', 'files_write', { scopes: ['~/notes'], userInitiated: true });
  assert.equal(g.ok, true, 'a user-initiated grant on a supported capability must succeed');
  assert.equal(c.authorize('appA', 'files_write', { scope: '~/notes' }).reason, 'approval_required');
  assert.equal(c.authorize('appA', 'files_write', { scope: '~/notes', approvalDigest: '' }).reason, 'approval_required');
  assert.equal(c.authorize('appA', 'files_write', { scope: '~/notes', approvalDigest: 'd1' }).allowed, true);
});
