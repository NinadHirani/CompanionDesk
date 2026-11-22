'use strict';

// Which windows may use which device permissions. Only the overlay page may
// use the microphone, and only audio: never video, never any other permission.
// Pure, so the policy is tested directly instead of through hardware.

function isOverlayUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'file:' && u.pathname.endsWith('/renderer/overlay.html');
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
