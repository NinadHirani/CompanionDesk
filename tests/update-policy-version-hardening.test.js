'use strict';

// M8 batch 58 (28 Nov 2026, standing authorization): update-policy hardening.
// Two real contract gaps, caught red-first:
//   1. parseVersion accepted semver-invalid versions that electron-updater's
//      own semver parser rejects: leading zeros in core numbers
//      ('1.02.3'), empty prerelease identifiers ('1.0.0-alpha.') and
//      leading-zero numeric prerelease identifiers ('1.0.0-alpha.01').
//      The policy's verdict could then say "update available" for a feed
//      version the updater itself can never install.
//   2. modeFor had no platform whitelist: any non-darwin/win32/linux
//      platform (the Android/Capacitor shell, an unknown platform) fell
//      through to the Windows/Linux branch and got mode 'auto' with
//      in-app install offered, which cannot work there.
// Test-only until each fails. Pure module: no Electron, no network.

const test = require('node:test');
const assert = require('node:assert');
const policy = require('../src/update-policy.js');

test('a version semver rejects is not silently treated as a comparable version', () => {
  // electron-updater validates feed versions with the semver package:
  // these are semver.invalid, so the policy must return null too, never
  // a verdict that claims the version is comparable.
  assert.equal(policy.parseVersion('1.02.3'), null, 'leading zero in the minor is invalid semver');
  assert.equal(policy.parseVersion('01.2.3'), null, 'leading zero in the major is invalid semver');
  assert.equal(policy.parseVersion('1.0.0-alpha.'), null, 'an empty prerelease identifier is invalid semver');
  assert.equal(policy.parseVersion('1.0.0-alpha..1'), null, 'an empty middle identifier is invalid semver');
  assert.equal(policy.parseVersion('1.0.0-alpha.01'), null, 'a leading-zero numeric prerelease identifier is invalid semver');
});

test('comparisons involving a semver-invalid side are null, not a false verdict', () => {
  assert.equal(policy.compareVersions('1.02.3', '1.2.3'), null, 'must not report equal for a version semver rejects');
  assert.equal(policy.isNewerVersion('1.0.0', '1.0.0-alpha.'), false, 'an unparseable candidate must not look newer');
  assert.equal(policy.isNewerVersion('1.0.0-alpha.01', '1.0.0-alpha.1'), false, 'an unparseable current must not yield a verdict');
  // semver-VALID neighbours keep working exactly as before
  assert.deepEqual(policy.parseVersion('0.1.0'), { major: 0, minor: 1, patch: 0, pre: [] });
  assert.deepEqual(policy.parseVersion('1.0.0-alpha-1'), { major: 1, minor: 0, patch: 0, pre: ['alpha-1'] });
  assert.deepEqual(policy.parseVersion('1.0.0-a0'), { major: 1, minor: 0, patch: 0, pre: ['a0'] });
  assert.equal(policy.compareVersions('0.1.0-ci.10', '0.1.0-ci.9'), 1);
  assert.equal(policy.compareVersions('1.0.0-0', '1.0.0-1'), -1, 'the zero identifier is valid semver');
});

test('modeFor fails closed on a platform the updater is not wired for', () => {
  for (const platform of ['android', 'unknown', 'freebsd']) {
    const m = policy.modeFor({ platform, isPackaged: true, macSigning: 'developer-id' });
    assert.equal(m.mode, 'disabled', platform + ' must not get the Windows/Linux auto branch');
    assert.equal(m.canCheck, false, platform + ' must not offer an update check');
    assert.equal(m.canInstallInApp, false, platform + ' must not offer in-app install');
    assert.equal(typeof m.reason, 'string', 'the refusal names why');
  }
});

test('the three wired platforms are unaffected by the fail-closed gate', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    const m = policy.modeFor({ platform, isPackaged: true, macSigning: 'developer-id' });
    assert.equal(m.mode, 'auto', platform + ' keeps its wired mode');
  }
  assert.equal(policy.modeFor({ platform: 'darwin', isPackaged: true, macSigning: 'unsigned' }).mode, 'manual-download');
});
