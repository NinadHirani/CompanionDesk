'use strict';

// Wires electron-updater to the app under the same fail-closed rules as the
// rest of CompanionDesk: nothing is downloaded or installed unless the user
// clicks the button for exactly that step, and every state change is pushed
// to the renderer as a plain, renderable snapshot.
//
// All Electron and electron-updater dependencies arrive via `deps`, so the
// decision logic can be tested without running Electron (see
// tests/updater.test.js).

const { ipcMain } = require('electron');
const policy = require('./update-policy');

const RELEASES_URL = 'https://github.com/NinadHirani/CompanionDesk/releases';

const IDLE = { phase: 'idle', version: null, progress: null, error: null };

function createUpdateController(deps) {
  const {
    ipcMain: ipc = ipcMain,
    autoUpdater,
    app,
    settings,
    broadcast, // (state) => void : deliver a state snapshot to every window
    openExternal,
    platform,
    appVersion,
    isPackaged,
    macSigning,
  } = deps;

  const channel = policy.resolveChannel(settings && settings.update_channel);
  const mode = policy.modeFor({ platform, isPackaged, macSigning });

  let state = {
    ...IDLE,
    appVersion,
    channel,
    mode: mode.mode,
    canInstallInApp: mode.canInstallInApp,
    reason: mode.reason,
  };

  function push(extra) {
    if (extra) state = { ...state, ...extra };
    const described = policy.describeState(state);
    broadcast({ ...state, text: described.text, action: described.action });
  }

  function setPhase(phase, extra) {
    push({ phase, error: null, ...(extra || {}) });
  }

  if (!mode.canCheck) {
    // Disabled (development builds): the renderer can still ask for status
    // and learn it is off; nothing else is wired.
    ipc.handle('update:status', () => state);
    push();
    return { state: () => state, mode };
  }

  autoUpdater.autoDownload = false; // the user clicks Download first
  autoUpdater.allowPrerelease = policy.allowPrereleaseFor({ appVersion, channel });
  autoUpdater.autoInstallOnAppQuit = false; // installing is an explicit click

  autoUpdater.on('checking-for-update', () => setPhase('checking'));
  autoUpdater.on('update-available', (info) => {
    const newer = policy.isNewerVersion(appVersion, info && info.version);
    if (!newer) {
      push({ phase: 'none' });
      return;
    }
    if (mode.canDownload && autoUpdater.autoDownload) {
      setPhase('downloading', { version: info.version });
    } else {
      setPhase('available', { version: info.version, releaseNotes: info.releaseNotes || null });
    }
  });
  autoUpdater.on('update-not-available', () => push({ phase: 'none' }));
  autoUpdater.on('download-progress', (p) => {
    push({ phase: 'downloading', progress: p && p.percent });
  });
  autoUpdater.on('update-downloaded', (info) => {
    setPhase('downloaded', { version: info && info.version });
  });
  autoUpdater.on('error', (err) => {
    // A failed update never leaves the running install touched.
    push({ phase: 'error', error: err ? String(err.message || err) : 'Unknown error' });
  });

  ipc.handle('update:status', () => state);
  ipc.handle('update:check', async () => {
    try {
      autoUpdater.autoDownload = false; // a plain check never downloads, even
      // after a failed download attempt left the switch armed.
      setPhase('checking');
      await autoUpdater.checkForUpdates();
    } catch (err) {
      push({ phase: 'error', error: err ? String(err.message || err) : 'Unknown error' });
    }
    return state;
  });
  ipc.handle('update:download', async () => {
    if (!mode.canDownload) return state;
    try {
      autoUpdater.autoDownload = true;
      setPhase('checking');
      await autoUpdater.checkForUpdates();
    } catch (err) {
      push({ phase: 'error', error: err ? String(err.message || err) : 'Unknown error' });
    }
    return state;
  });
  ipc.handle('update:install', () => {
    if (!mode.canInstallInApp || state.phase !== 'downloaded') return state;
    app.quitAndInstall();
    return state;
  });
  ipc.handle('update:openReleases', () => {
    if (deps.shell) deps.shell.openExternal(RELEASES_URL);
    return state;
  });

  push();
  return { state: () => state, mode };
}

module.exports = { createUpdateController, RELEASES_URL };
