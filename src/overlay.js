'use strict';

// The companion overlay: a small always-on-top window summoned by a global
// shortcut. It is created hidden at start so showing it is instant, hidden
// from screen capture where the OS allows, and independent of the dashboard.
// M8 slice 4: the window is movable and resizable, and the last user
// placement is remembered across restarts. Electron-only; the maths and
// validation live in overlay-layout.js, companion-window-state.js and
// hotkey.js so they can be tested without it.

const { BrowserWindow, globalShortcut, screen } = require('electron');
const { overlayBounds, DEFAULT_SIZE } = require('./overlay-layout');
const { restoreBounds, captureBounds } = require('./companion-window-state');

const SAVE_DEBOUNCE_MS = 250;

function createOverlayController({ preloadPath, htmlPath, iconPath, loadSavedBounds, saveBounds, alwaysOnTop }) {
  let win = null;
  let registered = null; // the accelerator currently held, or null
  // remembered: a saved placement or a user move/resize is in charge of the
  // window position. Until then the window keeps the old behaviour of
  // appearing on the display the cursor is on, so nothing changes for a
  // user who never drags the companion.
  let remembered = false;
  let placing = false; // a programmatic setBounds is in flight, not a user move
  // M8 customization: the companion floats above other windows by default
  // (today's behavior); the About toggle can turn the float off. True means
  // today's always-on-top companion, unchanged for anyone who never touches
  // the toggle.
  let floatOn = alwaysOnTop !== false;
  let saveTimer = null;

  function boundsWorkAreas() {
    try { return screen.getAllDisplays().map((d) => d.workArea); } catch { return null; }
  }

  function persistBounds() {
    saveTimer = null;
    if (!saveBounds || !win || win.isDestroyed()) return;
    const clean = captureBounds(win.getBounds());
    if (!clean) return;
    try { saveBounds(JSON.stringify(clean)); } catch { /* a failed save keeps this session's placement only */ }
  }

  function schedulePersistBounds() {
    if (placing || !saveBounds) return;
    remembered = true;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(persistBounds, SAVE_DEBOUNCE_MS);
  }

  function applyBounds(bounds) {
    if (!win || win.isDestroyed() || !bounds) return;
    placing = true;
    try { win.setBounds(bounds); } finally { placing = false; }
  }

  function ensure() {
    if (win && !win.isDestroyed()) return win;
    win = new BrowserWindow({
      ...DEFAULT_SIZE,
      show: false,
      frame: false,
      resizable: true,
      minWidth: 240,
      minHeight: 160,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: floatOn,
      title: 'CompanionDesk overlay',
      ...(iconPath ? { icon: iconPath } : {}),
      backgroundColor: '#1f2523',
      webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    // Keep the overlay itself out of screenshots and screen sharing (macOS, Windows).
    win.setContentProtection(true);
    win.loadFile(htmlPath);
    // Bring back the last user placement, clamped fail-closed into a real
    // display (an unplugged monitor folds the window onto the nearest one).
    // Anything unusable keeps the default placement below.
    if (loadSavedBounds) {
      try {
        const restored = restoreBounds(loadSavedBounds(), boundsWorkAreas());
        if (restored) { applyBounds(restored); remembered = true; }
      } catch { /* a failing settings read never blocks the overlay */ }
    }
    win.on('move', schedulePersistBounds);
    win.on('resize', schedulePersistBounds);
    win.on('close', () => {
      if (saveTimer) { clearTimeout(saveTimer); persistBounds(); }
    });
    win.on('closed', () => { win = null; });
    return win;
  }

  // One place decides what "floats above other windows" means, so the
  // constructor, show() and a live settings change can never disagree.
  function applyFloat(w) {
    w.setAlwaysOnTop(floatOn, 'floating');
    try { w.setVisibleOnAllWorkspaces(floatOn, { visibleOnFullScreen: true }); } catch { /* not supported everywhere */ }
  }

  // M8 customization: apply a changed float choice. A live change reaches
  // the open window immediately; the next ensure() picks it up too.
  function setAlwaysOnTop(enabled) {
    floatOn = enabled !== false;
    if (win && !win.isDestroyed()) applyFloat(win);
    return { ok: true, alwaysOnTop: floatOn };
  }

  function isVisible() {
    return Boolean(win && !win.isDestroyed() && win.isVisible());
  }

  // reset:false brings the window back without clearing what the user typed
  // (used after a screenshot hid it).
  function show({ reset = true } = {}) {
    const w = ensure();
    if (!remembered) {
      const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      applyBounds(overlayBounds(display.workArea));
      remembered = true;
    }
    applyFloat(w);
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

  return { ensure, show, hide, toggle, send, register, unregisterAll, isVisible, setAlwaysOnTop, getWindow: () => win, getHotkey: () => registered };
}

module.exports = { createOverlayController };
