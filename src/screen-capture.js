'use strict';

// Screen questions look at ONE window the user picks, never the whole screen.
// Electron's modules are passed in so the logic can be tested with fakes.
//
//   listWindows   -> what can be picked (titles plus small previews)
//   captureWindow -> one screenshot of the chosen window, in memory only
//
// Window titles are checked before any full-size pixels are requested, and a
// window that looks private (password manager, sign-in form) is never captured.
// That is a title check, not a pixel check: it cannot see inside a web page.

const { sensitiveWindow, isOwnWindow, MAX_EDGE } = require('./screen');

const PREVIEW = { width: 320, height: 200 };
const MAX_LISTED = 12;

function needsPermission({ platform, systemPreferences }) {
  return platform === 'darwin' && systemPreferences.getMediaAccessStatus('screen') !== 'granted';
}

// -> { ok: true, windows: [{ id, name, thumbnail (data URL or null), blocked }] }
//  | { ok: false, error: 'screen_permission' | 'capture_failed' }
async function listWindows({ desktopCapturer, systemPreferences, platform = process.platform }) {
  if (needsPermission({ platform, systemPreferences })) return { ok: false, error: 'screen_permission' };
  try {
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: PREVIEW });
    const windows = sources
      .filter((s) => s.name && s.name.trim() && !isOwnWindow(s.name))
      .slice(0, MAX_LISTED)
      .map((s) => {
        const blocked = sensitiveWindow([s.name]) !== null;
        // A window that looks private gets no preview and cannot be chosen.
        const thumbnail = !blocked && s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : null;
        return { id: s.id, name: s.name, thumbnail, blocked };
      });
    return { ok: true, windows };
  } catch {
    return { ok: false, error: 'capture_failed' };
  }
}

// -> { ok: true, jpegBase64, title }
//  | { ok: false, error: 'bad_request' | 'screen_permission' | 'window_gone' | 'screen_blocked' | 'title_unavailable' | 'capture_failed', detail? }
async function captureWindow({ desktopCapturer, systemPreferences, windowId, platform = process.platform }) {
  if (typeof windowId !== 'string' || !windowId || windowId.length > 200) return { ok: false, error: 'bad_request' };
  if (needsPermission({ platform, systemPreferences })) return { ok: false, error: 'screen_permission' };

  try {
    // Step 1: titles only, no pixels. Refuse before anything is captured.
    const names = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } });
    const target = names.find((s) => s.id === windowId);
    if (!target) return { ok: false, error: 'window_gone' };
    // A window whose title is missing or blank cannot be checked against the
    // private-title rules, so it is refused, the same rule that keeps untitled
    // windows out of the picker list.
    if (!target.name || !String(target.name).trim()) return { ok: false, error: 'title_unavailable' };
    if (isOwnWindow(target.name)) return { ok: false, error: 'bad_request' };
    if (sensitiveWindow([target.name])) return { ok: false, error: 'screen_blocked', detail: target.name };

    // Step 2: pixels of that one window.
    const shots = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: MAX_EDGE, height: MAX_EDGE } });
    const src = shots.find((s) => s.id === windowId);
    if (!src) return { ok: false, error: 'window_gone' };
    // The title can change between the two calls (a tab navigating to a login page).
    if (!src.name || !String(src.name).trim()) return { ok: false, error: 'title_unavailable' };
    if (sensitiveWindow([src.name])) return { ok: false, error: 'screen_blocked', detail: src.name };
    if (!src.thumbnail || src.thumbnail.isEmpty()) return { ok: false, error: 'capture_failed' };
    return { ok: true, jpegBase64: src.thumbnail.toJPEG(80).toString('base64'), title: src.name };
  } catch {
    return { ok: false, error: 'capture_failed' };
  }
}

module.exports = { listWindows, captureWindow };
