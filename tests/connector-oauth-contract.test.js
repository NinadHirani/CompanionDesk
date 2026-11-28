'use strict';

// M8 batch 54 (28 Nov 2026, standing authorization): one uniform mocked
// contract sweep over every OAuth-backed adapter (authShape 'oauth_json').
// Nothing here connects an account, sends a request or touches a real
// credential: every call is a pure request builder invoked with fake
// config values, and the tests only assert the shape of what WOULD go out.
// The contract it pins: (1) every OAuth adapter exposes authorizeUrl,
// tokenRequest and refreshRequest; (2) the token and refresh POSTs carry
// client_id/client_secret/refresh_token in the form body, never in the
// URL; (3) grant_type is exact; (4) the authorize URL never contains a
// client secret and each adapter's consent scope is pinned to the exact
// least-privilege string the catalog row promises.

const test = require('node:test');
const assert = require('node:assert');
const adapters = require('../src/connector-adapters.js');

const CFG = { client_id: 'cid', client_secret: 'csecret', redirect_uri: 'https://example.org/cb' };
const CODE = 'auth-code-1';
const RT = 'refresh-token-1';

const EXPECTED = {
  'google-docs': { provider: 'google', scope: 'https://www.googleapis.com/auth/documents.readonly' },
  'google-sheets': { provider: 'google', scope: 'https://www.googleapis.com/auth/spreadsheets.readonly' },
  'google-drive': { provider: 'google', scope: 'https://www.googleapis.com/auth/drive' },
  'gmail': { provider: 'google', scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send' },
  'google-calendar': { provider: 'google', scope: 'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events' },
  'microsoft-excel': { provider: 'microsoft', scope: 'Files.Read offline_access' },
  'microsoft-word': { provider: 'microsoft', scope: 'Files.Read offline_access' },
  'microsoft-teams': { provider: 'microsoft', scope: 'Chat.Read offline_access' },
  'microsoft-onedrive': { provider: 'microsoft', scope: 'Files.ReadWrite offline_access' },
  'microsoft-outlook': { provider: 'microsoft', scope: 'Mail.Read Mail.Send offline_access' },
  'microsoft-calendar': { provider: 'microsoft', scope: 'Calendars.Read Calendars.ReadWrite offline_access' },
};

const ENDPOINT = {
  google: 'https://oauth2.googleapis.com/token',
  microsoft: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
};

// adapters whose catalog row promises read-only consent only: the authorize
// scope must equal the exact least-privilege read scope, never wider
const READ_ONLY_ONLY = {
  'google-docs': 'https://www.googleapis.com/auth/documents.readonly',
  'google-sheets': 'https://www.googleapis.com/auth/spreadsheets.readonly',
  'microsoft-excel': 'Files.Read offline_access',
  'microsoft-word': 'Files.Read offline_access',
};

const IDS = Object.keys(EXPECTED);

test('every OAuth-backed adapter exposes the full authorize/token/refresh surface', () => {
  for (const id of IDS) {
    const a = adapters.get(id);
    assert.ok(a, id + ' adapter exists');
    assert.equal(a.authShape, 'oauth_json', id + ' is an OAuth adapter');
    assert.equal(typeof a.oauth.authorizeUrl, 'function', id + ' authorizeUrl');
    assert.equal(typeof a.oauth.tokenRequest, 'function', id + ' tokenRequest');
    assert.equal(typeof a.oauth.refreshRequest, 'function', id + ' refreshRequest');
  }
});

test('authorize URLs pin the exact consent scope and never carry a secret', () => {
  for (const id of IDS) {
    const e = EXPECTED[id];
    const url = adapters.get(id).oauth.authorizeUrl(CFG, 'state-1');
    assert.equal(typeof url, 'string', id + ' authorize url');
    assert.match(url, /response_type=code/);
    assert.ok(url.includes('client_id=cid'), id + ' client_id in url');
    assert.ok(url.includes('redirect_uri=' + encodeURIComponent(CFG.redirect_uri)), id + ' redirect_uri in url');
    assert.ok(url.includes('scope=' + encodeURIComponent(e.scope)), id + ' exact consent scope');
    assert.ok(url.includes('state=state-1'), id + ' state in url');
    assert.equal(url.indexOf('client_secret'), -1, id + ' no client secret in authorize url');
    if (e.provider === 'google') {
      assert.ok(url.includes('access_type=offline') && url.includes('prompt=consent'), id + ' offline refresh consent');
    } else {
      assert.ok(e.scope.includes('offline_access'), id + ' microsoft scope asks for offline_access');
    }
  }
});

test('token requests POST form bodies to the provider token endpoint, secrets in the body only', () => {
  for (const id of IDS) {
    const e = EXPECTED[id];
    const r = adapters.get(id).oauth.tokenRequest(CFG, CODE);
    assert.equal(r.method, 'POST', id + ' token POST');
    assert.equal(r.url, ENDPOINT[e.provider], id + ' token endpoint');
    assert.equal(r.headers['Content-Type'], 'application/x-www-form-urlencoded', id + ' form content type');
    assert.equal(r.url.indexOf('client_secret'), -1, id + ' no secret in token url');
    const p = new URLSearchParams(r.body);
    assert.equal(p.get('grant_type'), 'authorization_code', id + ' grant type');
    assert.equal(p.get('code'), CODE, id + ' code');
    assert.equal(p.get('client_id'), 'cid', id + ' client_id');
    assert.equal(p.get('client_secret'), 'csecret', id + ' client_secret');
    assert.equal(p.get('redirect_uri'), CFG.redirect_uri, id + ' redirect_uri');
  }
});

test('refresh requests POST the refresh grant with the rotation token in the body only', () => {
  for (const id of IDS) {
    const e = EXPECTED[id];
    const r = adapters.get(id).oauth.refreshRequest(CFG, RT);
    assert.equal(r.method, 'POST', id + ' refresh POST');
    assert.equal(r.url, ENDPOINT[e.provider], id + ' refresh endpoint');
    assert.equal(r.url.indexOf('refresh_token'), -1, id + ' no refresh token in url');
    assert.equal(r.url.indexOf('client_secret'), -1, id + ' no secret in refresh url');
    const p = new URLSearchParams(r.body);
    assert.equal(p.get('grant_type'), 'refresh_token', id + ' refresh grant');
    assert.equal(p.get('refresh_token'), RT, id + ' refresh token rides the body');
    assert.equal(p.get('client_id'), 'cid', id + ' client_id');
    assert.equal(p.get('client_secret'), 'csecret', id + ' client_secret');
  }
});

test('read-only-only adapters never widen their consent beyond read scopes', () => {
  for (const [id, exact] of Object.entries(READ_ONLY_ONLY)) {
    const url = adapters.get(id).oauth.authorizeUrl(CFG, 's');
    const scope = decodeURIComponent((url.match(/scope=([^&]+)/) || [])[1] || '');
    assert.equal(scope, exact, id + ' consent scope stays exactly the read-only set');
  }
});

test('the OAuth adapter set is exactly the pinned set (new OAuth adapters must join this contract)', () => {
  // every bracket-style oauth_json adapter in the module is in EXPECTED
  const all = ['better-stack', 'backblaze-b2', 'zerodha-kite', 'google-maps', 'stability-ai', 'together-ai',
    'new-relic', 'docker-hub', 'internet-archive', 'lm-studio', 'open-meteo', 'brave-search', 'google-gemini',
    'gmail', 'google-docs', 'google-sheets', 'google-drive', 'google-calendar', 'microsoft-excel', 'microsoft-word',
    'microsoft-teams', 'microsoft-onedrive', 'microsoft-outlook', 'microsoft-calendar'];
  const oauthIds = all.filter(id => { const a = adapters.get(id); return a && a.authShape === 'oauth_json'; });
  assert.deepEqual(oauthIds.sort(), IDS.slice().sort(), 'oauth adapter set matches the contract table');
});
