'use strict';
// Red-first hardening (28 Nov 2026, batch-60 parallel lane): a provider
// token response with a non-positive or non-numeric expires_in must be
// treated as an UNKNOWN expiry, never as an absolute time in the past or
// zero seconds away. A negative/zero expires_in reaching applyRefresh would
// mint a credential that is born expired and can push a caller into a
// refresh loop.
const test = require('node:test');
const assert = require('node:assert');
const tokens = require('../src/connector-tokens.js');

test('a zero or negative expires_in is an unknown expiry, never a past expiry', () => {
  for (const bad of [0, -1, -3600, Number.POSITIVE_INFINITY, NaN]) {
    const r = tokens.parseTokenResponse({ access_token: 'at-bad', expires_in: bad });
    assert.ok(r.ok, 'the response itself is parseable');
    assert.equal(r.token.expires_in, null, 'expires_in ' + String(bad) + ' is not a usable lifetime');
    const merged = tokens.applyRefresh({ access_token: 'a', refresh_token: 'rt', client_id: 'c', client_secret: 's', expires_at: 1000 }, r.token, 5000);
    assert.ok(merged.ok);
    assert.equal(merged.blob.expires_at, 1000, 'the stored expiry is kept, never computed from a non-positive lifetime');
  }
});
