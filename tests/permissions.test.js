'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { isOverlayUrl, requestAllowed, checkAllowed } = require('../src/permissions');

const OVERLAY = 'file:///Applications/CompanionDesk.app/Contents/Resources/app/renderer/overlay.html';
const DASH = 'file:///Applications/CompanionDesk.app/Contents/Resources/app/renderer/index.html';

test('only the overlay page counts as the overlay', () => {
  assert.equal(isOverlayUrl(OVERLAY), true);
  assert.equal(isOverlayUrl(OVERLAY + '?x=1#y'), true, 'query and hash do not change the path');
  for (const bad of [DASH, 'https://evil.example/renderer/overlay.html', 'file:///tmp/overlay.html', 'file:///x/renderer/overlay.html.evil', 'file:///x/renderer/overlay.htm', '', 'not a url', null, undefined]) {
    assert.equal(isOverlayUrl(bad), false, String(bad));
  }
});

test('the overlay may ask for audio, and only audio', () => {
  assert.equal(requestAllowed({ permission: 'media', mediaTypes: ['audio'], url: OVERLAY }), true);
  assert.equal(requestAllowed({ permission: 'media', mediaTypes: ['video'], url: OVERLAY }), false);
  assert.equal(requestAllowed({ permission: 'media', mediaTypes: ['audio', 'video'], url: OVERLAY }), false);
  assert.equal(requestAllowed({ permission: 'media', mediaTypes: [], url: OVERLAY }), false);
  assert.equal(requestAllowed({ permission: 'media', url: OVERLAY }), false, 'unspecified is refused, not assumed');
});

test('the dashboard and any other page are refused the microphone', () => {
  assert.equal(requestAllowed({ permission: 'media', mediaTypes: ['audio'], url: DASH }), false);
  assert.equal(requestAllowed({ permission: 'media', mediaTypes: ['audio'], url: 'https://evil.example/renderer/overlay.html' }), false);
});

test('no other permission is ever granted, even to the overlay', () => {
  for (const p of ['geolocation', 'notifications', 'clipboard-read', 'display-capture', 'midi', 'openExternal', 'fullscreen', 'camera']) {
    assert.equal(requestAllowed({ permission: p, mediaTypes: ['audio'], url: OVERLAY }), false, p);
    assert.equal(checkAllowed({ permission: p, mediaType: 'audio', url: OVERLAY }), false, p);
  }
});

test('permission checks follow the same rules', () => {
  assert.equal(checkAllowed({ permission: 'media', mediaType: 'audio', url: OVERLAY }), true);
  assert.equal(checkAllowed({ permission: 'media', mediaType: 'video', url: OVERLAY }), false);
  assert.equal(checkAllowed({ permission: 'media', mediaType: 'unknown', url: OVERLAY }), false);
  assert.equal(checkAllowed({ permission: 'media', mediaType: 'audio', url: DASH }), false);
});
