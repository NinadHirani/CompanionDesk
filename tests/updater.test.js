'use strict';

// The update controller must stay click-for-click: a plain "check for
// updates" never downloads, and a failed download attempt must not leave the
// auto-download switch armed for a later plain check ("Try again" from the
// error banner calls update:check). Fake deps only: no Electron, no network,
// no real electron-updater, nothing is downloaded or installed here.

const test = require('node:test');
const assert = require('node:assert');
const { createUpdateController, RELEASES_URL } = require('../src/updater');

function fakeDeps(overrides = {}) {
  const handlers = {};
  const listeners = {};
  const au = {
    autoDownload: null,
    allowPrerelease: null,
    autoInstallOnAppQuit: null,
    behavior: null,
    on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    emit(ev, arg) { (listeners[ev] || []).forEach((fn) => fn(arg)); },
    async checkForUpdates() {
      if (typeof this.behavior === 'function') { this.behavior(); return; }
      throw new Error('no behavior configured');
    },
  };
  const installs = [];
  const broadcasts = [];
  const deps = {
    ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } },
    autoUpdater: au,
    app: { quitAndInstall: () => installs.push(1) },
    settings: { update_channel: 'stable' },
    broadcast: (s) => broadcasts.push(s),
    shell: { openExternal: () => opens.push(1) },
    platform: 'win32',
    appVersion: '1.0.0',
    isPackaged: true,
    macSigning: 'developer-id',
    ...overrides,
  };
  const opens = [];
  return { deps, handlers, au, installs, broadcasts, opens };
}

const available1_1 = () => ({});

test('REGRESSION: a failed download attempt does not arm auto-download for a later plain check', async () => {
  const { deps, handlers, au } = fakeDeps();
  createUpdateController(deps);
  // First: a plain check finds 1.1.0 -> the banner offers Download, nothing downloads.
  au.behavior = () => au.emit('update-available', { version: '1.1.0' });
  let s = await handlers['update:check']();
  assert.equal(s.phase, 'available');
  assert.equal(s.version, '1.1.0');
  assert.equal(au.autoDownload, false, 'a check must never arm auto-download');
  // The user clicks Download; the check fails (network error).
  au.behavior = () => { throw new Error('ENOTFOUND feed'); };
  s = await handlers['update:download']();
  assert.equal(s.phase, 'error');
  assert.equal(au.autoDownload, true, 'precondition: the download click armed it');
  // The user clicks Try again (a plain update:check). It must land back on
  // the available banner, NOT silently download.
  au.behavior = () => au.emit('update-available', { version: '1.1.0' });
  s = await handlers['update:check']();
  assert.equal(au.autoDownload, false, 'a check must reset the armed switch');
  assert.equal(s.phase, 'available');
});

test('a check that finds nothing newer reports none, never downloads', async () => {
  const { deps, handlers, au } = fakeDeps();
  createUpdateController(deps);
  au.behavior = () => au.emit('update-available', { version: '1.0.0' });
  const s = await handlers['update:check']();
  assert.equal(s.phase, 'none');
  assert.equal(au.autoDownload, false);
});

test('the Download click arms auto-download and downloads; install is guarded', async () => {
  const { deps, handlers, au, installs } = fakeDeps();
  createUpdateController(deps);
  au.behavior = () => au.emit('update-available', { version: '1.1.0' });
  await handlers['update:check']();
  au.behavior = () => au.emit('update-available', { version: '1.1.0' });
  const s = await handlers['update:download']();
  assert.equal(s.phase, 'downloading');
  au.emit('download-progress', { percent: 50 });
  assert.equal(au.autoInstallOnAppQuit, false);
  handlers['update:install']();
  assert.equal(installs.length, 0, 'install refused while still downloading');
  handlers['update:install']();
  assert.equal(installs.length, 0, 'the second pre-downloaded call still refuses');
  // Now really in the downloaded phase:
  au.emit('update-downloaded', { version: '1.1.0' });
  handlers['update:install']();
  assert.equal(installs.length, 1);
});

test('development builds wire only the status handler and never the updater', () => {
  const { deps, handlers, au } = fakeDeps({ isPackaged: false });
  createUpdateController(deps);
  assert.ok(handlers['update:status']);
  assert.equal(handlers['update:check'], undefined);
  assert.equal(handlers['update:download'], undefined);
  assert.equal(handlers['update:install'], undefined);
  assert.equal(au.autoDownload, null, 'electron-updater is never configured in dev');
});

test('openReleases uses the shell with the fixed releases URL', () => {
  const { deps, handlers, opens } = fakeDeps();
  createUpdateController(deps);
  assert.equal(RELEASES_URL, 'https://github.com/NinadHirani/CompanionDesk/releases');
  handlers['update:openReleases']();
  assert.equal(opens.length, 1);
});
