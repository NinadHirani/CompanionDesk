'use strict';

// Which windows may use which device permissions. Only the overlay page may
// use the microphone, and only audio: never video, never any other permission.
// Pure, so the policy is tested directly instead of through hardware.

function isOverlayUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'file:') return false;
    // The bundled overlay loads from file:// with an empty authority. A file
    // URL carrying a host is a different document (on Windows file://host/path
    // can resolve to a network share), so only empty or localhost hosts are
    // the overlay page (26 Nov 2026 hardening).
    if (u.host !== '' && u.host !== 'localhost') return false;
    return u.pathname.endsWith('/renderer/overlay.html');
  } catch {
    return false;
  }
}

// Used for permission *requests*: mediaTypes is the list the page asked for.
function requestAllowed({ permission, mediaTypes, url }) {
  if (permission !== 'media') return false;
  if (!Array.isArray(mediaTypes) || mediaTypes.length === 0) return false;
  if (!mediaTypes.every((t) => t === 'audio')) return false;
  return isOverlayUrl(url);
}

// Used for permission *checks*: mediaType is a single value.
function checkAllowed({ permission, mediaType, url }) {
  return permission === 'media' && mediaType === 'audio' && isOverlayUrl(url);
}

module.exports = { isOverlayUrl, requestAllowed, checkAllowed };
