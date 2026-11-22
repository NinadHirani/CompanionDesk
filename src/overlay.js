'use strict';

// The companion overlay: a small always-on-top window summoned by a global
// shortcut. It is created hidden at start so showing it is instant, hidden
// from screen capture where the OS allows, and independent of the dashboard.
// Electron-only; the maths and validation live in overlay-layout.js and
// hotkey.js so they can be tested without it.

const { BrowserWindow, globalShortcut, screen } = require('electron');
const { overlayBounds, DEFAULT_SIZE } = require('./overlay-layout');

function createOverlayController({ preloadPath, htmlPath, iconPath }) {
  let win = null;
  let registered = null; // the accelerator currently held, or null

  function ensure() {
    if (win && !win.isDestroyed()) return win;
    win = new BrowserWindow({
      ...DEFAULT_SIZE,
      show: false,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      title: 'CompanionDesk overlay',
      ...(iconPath ? { icon: iconPath } : {}),
      backgroundColor: '#1f2523',
      webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    // Keep the overlay itself out of screenshots and screen sharing (macOS, Windows).
    win.setContentProtection(true);
    win.loadFile(htmlPath);
    win.on('closed', () => { win = null; });
    return win;
  }

  function isVisible() {
    return Boolean(win && !win.isDestroyed() && win.isVisible());
  }

  // reset:false brings the window back without clearing what the user typed
  // (used after a screenshot hid it).
  function show({ reset = true } = {}) {
    const w = ensure();
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    w.setBounds(overlayBounds(display.workArea));
    w.setAlwaysOnTop(true, 'floating');
    try { w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch { /* not supported everywhere */ }
    w.show();
    w.focus();
    if (reset) w.webContents.send('overlay:reset');
  }

  function hide() {
    if (win && !win.isDestroyed()) win.hide();
  }

  function toggle() {
    if (isVisible()) hide();
    else show();
  }

  function send(channel, payload) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  }

  // Try to take `accelerator`. On failure the previous shortcut is kept.
  function register(accelerator) {
    const previous = registered;
    if (previous) globalShortcut.unregister(previous);
    let ok = false;
    try { ok = globalShortcut.register(accelerator, toggle); } catch { ok = false; }
    if (ok) { registered = accelerator; return { ok: true }; }
    if (previous) { try { globalShortcut.register(previous, toggle); registered = previous; } catch { registered = null; } }
    else registered = null;
    return { ok: false, error: 'hotkey_unavailable' };
  }

  function unregisterAll() {
    globalShortcut.unregisterAll();
    registered = null;
  }

  return { ensure, show, hide, toggle, send, register, unregisterAll, isVisible, getWindow: () => win, getHotkey: () => registered };
}

module.exports = { createOverlayController };
