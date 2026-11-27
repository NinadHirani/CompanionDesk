'use strict';
// Token lifecycle tests (27 Nov 2026, Ninad's batch-2 go-ahead). The
// helpers decide refresh need, refreshability, response merging (rotation
// honoured) and failure classification. Pure: no fs, no network, no
// secrets leave any blob here.

const { test } = require('node:test');
const assert = require('node:assert');
const tokens = require('../src/connector-tokens.js');

function blob(overrides) {
  return Object.assign({
    client_id: 'cid', client_secret: 'secret', access_token: 'at-1',
    refresh_token: 'rt-1', expires_at: 1000,
  }, overrides || {});
}

test('parseBlob accepts a well-formed oauth blob and refuses junk', () => {
  assert.equal(tokens.parseBlob(JSON.stringify(blob())).ok, true);
  assert.equal(tokens.parseBlob('not json').ok, false);
  assert.equal(tokens.parseBlob('').reason, 'credential_missing');
  assert.equal(tokens.parseBlob(JSON.stringify({ client_id: 'c' })).reason, 'credential_invalid');
  assert.equal(tokens.parseBlob('x'.repeat(5000)).reason, 'credential_invalid');
});

test('needsRefresh fires inside the skew window and never on a missing expiry', () => {
  assert.equal(tokens.needsRefresh(blob({ expires_at: 200000 }), 200000), true, 'at expiry');
  assert.equal(tokens.needsRefresh(blob({ expires_at: 200000 }), 140000), true, 'inside the 60s skew');
  assert.equal(tokens.needsRefresh(blob({ expires_at: 200000 }), 139999), false, 'just outside the skew');
  assert.equal(tokens.needsRefresh(blob({ expires_at: null }), 990), false, 'no known expiry, no proactive refresh');
  assert.equal(tokens.needsRefresh(null, 1000), false);
});

test('canRefresh demands refresh token AND the user client credentials', () => {
  assert.equal(tokens.canRefresh(blob()), true);
  assert.equal(tokens.canRefresh(blob({ refresh_token: null })), false);
  assert.equal(tokens.canRefresh(blob({ refresh_token: '' })), false);
  assert.equal(tokens.canRefresh(blob({ client_secret: null })), false, 'no shared client exists');
  assert.equal(tokens.canRefresh(blob({ client_id: '' })), false);
});

test('applyRefresh merges the new access token and honours rotation', () => {
  const r = tokens.applyRefresh(blob(), { access_token: 'at-2', expires_in: 3600, refresh_token: 'rt-2' }, 5000);
  assert.equal(r.ok, true);
  assert.equal(r.blob.access_token, 'at-2');
  assert.equal(r.blob.refresh_token, 'rt-2', 'a rotated refresh token replaces the old one');
  assert.equal(r.blob.expires_at, 3605000, 'expires_in seconds become an absolute expiry (now 5000 + 3600s)');
  assert.equal(r.blob.client_secret, 'secret', 'client credentials survive for the next refresh');
});

test('applyRefresh keeps the old refresh token when none is returned and preserves expiry when unknown', () => {
  const r = tokens.applyRefresh(blob(), { access_token: 'at-2' }, 5000);
  assert.equal(r.ok, true);
  assert.equal(r.blob.refresh_token, 'rt-1', 'no rotation means keep the old token');
  assert.equal(r.blob.expires_at, 1000, 'no expires_in means keep the stored expiry, never guess');
  const bad = tokens.applyRefresh(blob(), { access_token: '' }, 0);
  assert.equal(bad.ok, false);
});

test('parseTokenResponse refuses bodies without an access token and accepts objects', () => {
  assert.equal(tokens.parseTokenResponse('{"error":"nope"}').ok, false);
  assert.equal(tokens.parseTokenResponse('garbage').ok, false);
  const ok = tokens.parseTokenResponse('{"access_token":"t","expires_in":100}');
  assert.equal(ok.ok, true);
  assert.equal(ok.token.expires_in, 100);
  assert.equal(tokens.parseTokenResponse({ access_token: 't' }).ok, true);
});

test('refresh failures classify: dead grants want re-auth, everything else is transient', () => {
  assert.equal(tokens.classifyRefreshFailure(400), 'reauth_required');
  assert.equal(tokens.classifyRefreshFailure(401), 'reauth_required');
  assert.equal(tokens.classifyRefreshFailure(429), 'refresh_failed');
  assert.equal(tokens.classifyRefreshFailure(500), 'refresh_failed');
  assert.equal(tokens.classifyRefreshFailure(503), 'refresh_failed');
});
