'use strict';

const test = require('node:test');
const assert = require('node:assert');
const policy = require('../src/update-policy');

test('build config with identity null means unsigned', () => {
  assert.equal(policy.macSigningFromBuildConfig(null), 'unsigned');
  assert.equal(policy.macSigningFromBuildConfig(undefined), 'unsigned');
  assert.equal(policy.macSigningFromBuildConfig('Developer ID Application: X'), 'developer-id');
});

test('a development build never updates', () => {
  const m = policy.modeFor({ platform: 'darwin', isPackaged: false, macSigning: 'unsigned' });
  assert.equal(m.mode, 'disabled');
  assert.equal(m.canCheck, false);
  assert.equal(m.canInstallInApp, false);
});

test('an unsigned mac build checks and points to the download page, never installs in-app', () => {
  const m = policy.modeFor({ platform: 'darwin', isPackaged: true, macSigning: 'unsigned' });
  assert.equal(m.mode, 'manual-download');
  assert.equal(m.canCheck, true);
  assert.equal(m.canDownload, false);
  assert.equal(m.canInstallInApp, false);
  assert.equal(m.openDownloadPage, true);
  assert.match(m.reason, /not code-signed/);
});

test('a signed mac build can update in-app', () => {
  const m = policy.modeFor({ platform: 'darwin', isPackaged: true, macSigning: 'developer-id' });
  assert.equal(m.mode, 'auto');
  assert.equal(m.canDownload, true);
  assert.equal(m.canInstallInApp, true);
});

test('windows and linux can update in-app without signing', () => {
  for (const platform of ['win32', 'linux']) {
    const m = policy.modeFor({ platform, isPackaged: true, macSigning: 'unsigned' });
    assert.equal(m.mode, 'auto');
    assert.equal(m.canInstallInApp, true);
    assert.equal(m.canDownload, true);
  }
});

test('channel resolution: anything unexpected is stable', () => {
  assert.equal(policy.resolveChannel('stable'), 'stable');
  assert.equal(policy.resolveChannel('continuous'), 'continuous');
  assert.equal(policy.resolveChannel(undefined), 'stable');
  assert.equal(policy.resolveChannel('hotdog'), 'stable');
});

test('prerelease rule: continuous builds and prerelease versions follow prereleases', () => {
  assert.equal(policy.allowPrereleaseFor({ appVersion: '0.1.0', channel: 'stable' }), false);
  assert.equal(policy.allowPrereleaseFor({ appVersion: '0.1.0', channel: 'continuous' }), true);
  assert.equal(policy.allowPrereleaseFor({ appVersion: '0.1.0-ci.4', channel: 'stable' }), true);
  assert.equal(policy.allowPrereleaseFor({ appVersion: '0.1.0-ci.4', channel: 'continuous' }), true);
});

test('version comparison handles prereleases the way semver does', () => {
  assert.equal(policy.compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(policy.compareVersions('1.0.1', '1.0.0'), 1);
  assert.equal(policy.compareVersions('0.1.0-ci.5', '0.1.0-ci.4'), 1);
  assert.equal(policy.compareVersions('0.1.0-ci.10', '0.1.0-ci.9'), 1);
  assert.equal(policy.compareVersions('0.1.0', '0.1.0-ci.9'), 1); // release outranks prerelease
  assert.equal(policy.compareVersions('0.1.0-ci.9', '0.1.0'), -1);
  assert.equal(policy.compareVersions('0.2.0-ci.1', '0.1.9'), 1);
  assert.equal(policy.compareVersions('garbage', '1.0.0'), null);
  assert.equal(policy.isNewerVersion('0.1.0-ci.4', '0.1.0-ci.5'), true);
  assert.equal(policy.isNewerVersion('0.1.0-ci.5', '0.1.0-ci.4'), false);
  assert.equal(policy.isNewerVersion('0.1.0', '0.1.0'), false);
  assert.equal(policy.isNewerVersion('0.1.0', '0.1.1'), true);
});

test('the banner says the right thing in every phase', () => {
  const mode = policy.modeFor({ platform: 'win32', isPackaged: true, macSigning: 'unsigned' });
  const base = { ...mode, appVersion: '0.1.0' };

  assert.deepEqual(policy.describeState({ ...base, phase: 'idle' }).action, null);
  assert.match(policy.describeState({ ...base, phase: 'checking' }).text, /Checking/);

  const avail = policy.describeState({ ...base, phase: 'available', version: '0.2.0' });
  assert.equal(avail.action.kind, 'download');
  assert.match(avail.text, /0\.2\.0 is available/);

  const prog = policy.describeState({ ...base, phase: 'downloading', version: '0.2.0', progress: 42.4 });
  assert.match(prog.text, /42%/);
  assert.equal(prog.action, null);

  const done = policy.describeState({ ...base, phase: 'downloaded', version: '0.2.0' });
  assert.equal(done.action.kind, 'install');
  assert.match(done.text, /Restart to install/);

  const manual = policy.modeFor({ platform: 'darwin', isPackaged: true, macSigning: 'unsigned' });
  const manualAvail = policy.describeState({ ...manual, appVersion: '0.1.0', phase: 'available', version: '0.2.0' });
  assert.equal(manualAvail.action.kind, 'open-download-page');

  const err = policy.describeState({ ...base, phase: 'error', error: 'ENOTFOUND releases.github.com' });
  assert.equal(err.action.kind, 'check');
  assert.match(err.text, /internet connection/);

  const disabled = policy.describeState({ ...policy.modeFor({ platform: 'darwin', isPackaged: false }), phase: 'idle' });
  assert.equal(disabled.text, null);
});

test('known failure modes map to honest messages', () => {
  assert.match(policy.friendlyUpdateError({ code: 'ENOTFOUND' }), /internet connection/);
  assert.match(policy.friendlyUpdateError('sha512 mismatch'), /checksum.*Nothing was installed/);
  assert.match(policy.friendlyUpdateError('ERR_UPDATER_INVALID_SIGNATURE bad sig'), /signature.*Nothing was installed/);
  assert.match(policy.friendlyUpdateError('404 not found'), /No update feed/);
  assert.match(policy.friendlyUpdateError('weird failure'), /weird failure/);
});

test('set-ci-version builds a valid strictly-ordered prerelease', () => {
  const { setContinuousVersion } = require('../scripts/set-ci-version');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const tmp = path.join(os.tmpdir(), `cd-ver-${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify({ version: '0.1.0' }));
  const v1 = setContinuousVersion({ baseVersion: '0.1.0', id: 4, file: tmp });
  assert.equal(v1, '0.1.0-ci.4');
  assert.equal(JSON.parse(fs.readFileSync(tmp)).version, '0.1.0-ci.4');
  assert.throws(() => setContinuousVersion({ baseVersion: '0.1.0', id: 'abc', file: tmp }));
  assert.throws(() => setContinuousVersion({ baseVersion: 'not-semver', id: 4, file: tmp }));
  assert.equal(policy.isNewerVersion('0.1.0-ci.4', setContinuousVersion({ baseVersion: '0.1.0', id: 5, file: tmp })), true);
});

test('publish config: continuous is a prerelease on a fixed tag, stable is a draft', () => {
  const { publishConfig } = require('../scripts/build-dist');
  const cont = publishConfig({ channel: 'continuous', publish: 'always', version: '0.1.0-ci.9' });
  assert.equal(cont.tag, 'continuous');
  assert.equal(cont.releaseType, 'prerelease');
  assert.equal(cont.repo, 'CompanionDesk');

  const built = publishConfig({ channel: 'continuous', publish: 'never', version: '0.1.0-ci.9' });
  assert.equal(built.tag, undefined); // nothing published

  process.env.STABLE_TAG = 'v0.2.0';
  const stable = publishConfig({ channel: 'stable', publish: 'always', version: '0.2.0' });
  assert.equal(stable.tag, 'v0.2.0');
  assert.equal(stable.draft, true); // nothing public until a person publishes
  delete process.env.STABLE_TAG;

  assert.throws(() => publishConfig({ channel: 'stable', publish: 'always', version: '0.2.0' }));
});
