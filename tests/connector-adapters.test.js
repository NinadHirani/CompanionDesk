'use strict';
// Connector adapter tests (27 Nov 2026, Ninad's integration go-ahead,
// batch 1). The adapter layer is pure: it BUILDS requests and never sends
// them, so these tests pin the request shapes, the param validation, the
// OAuth setup builders and, most importantly, the invariant that every
// adapter action maps to a scope the catalog itself declares with the
// matching class. authorizeCall stays the single consent gate; nothing
// here can widen it.

const { test } = require('node:test');
const assert = require('node:assert');
const adapters = require('../src/connector-adapters.js');
const { createConnectorCatalog } = require('../src/connectors.js');

const IMPLEMENTED = ['anthropic', 'discord', 'github', 'gmail', 'google-calendar', 'google-drive', 'google-gemini', 'microsoft-calendar', 'microsoft-onedrive', 'microsoft-outlook', 'notion', 'openai', 'slack', 'telegram'];
const OAUTH = ['gmail', 'google-calendar', 'google-drive', 'microsoft-calendar', 'microsoft-onedrive', 'microsoft-outlook'];

test('the adapter registry covers exactly the implemented catalog entries', () => {
  assert.deepEqual(adapters.ADAPTER_IDS, IMPLEMENTED.slice().sort(), 'adapters and catalog agree on the implemented set');
  const c = createConnectorCatalog({});
  const impl = c.list().filter((e) => e.integrationImplemented === true).map((e) => e.id).sort();
  assert.deepEqual(impl, IMPLEMENTED.slice().sort(), 'the catalog marks exactly these entries implemented');
});

test('every adapter action maps to a declared catalog scope with the matching class', () => {
  const c = createConnectorCatalog({});
  for (const id of IMPLEMENTED) {
    const entry = c.describe(id);
    const actions = adapters.listActions(id);
    assert.ok(Array.isArray(actions) && actions.length >= 1, id + ' has actions');
    for (const a of actions) {
      const s = entry.scopes.find((x) => x.name === a.scope);
      assert.ok(s, id + '.' + a.id + ' uses a declared scope (' + a.scope + ')');
      assert.equal(s.class, a.kind, id + '.' + a.id + ' kind matches the scope class');
      assert.ok(['read_only', 'write', 'send'].includes(a.kind), id + '.' + a.id + ' kind is a known class');
      assert.ok(a.label && a.label.length >= 8, id + '.' + a.id + ' has a human label');
    }
  }
});

test('token providers build https requests with the secret only in headers', () => {
  const r = adapters.buildRequest('slack', 'post_message', { channel: 'C123', text: 'hello' }, 'xoxb-secret');
  assert.equal(r.ok, true);
  assert.equal(r.request.method, 'POST');
  assert.ok(r.request.url.startsWith('https://slack.com/api/chat.postMessage'));
  assert.ok(r.request.url.indexOf('xoxb-secret') === -1, 'the token never rides the URL');
  assert.equal(r.request.headers.Authorization, 'Bearer xoxb-secret');
  assert.equal(r.request.urlContainsSecret, false);
  const d = adapters.buildRequest('discord', 'send_message', { channel_id: '1', content: 'hi' }, 'discord-token');
  assert.equal(d.ok, true);
  assert.equal(d.request.headers.Authorization, 'Bot discord-token');
  const g = adapters.buildRequest('github', 'repo_read', { owner: 'octo', repo: 'cat' }, 'ghp_test');
  assert.equal(g.ok, true);
  assert.ok(g.request.headers['User-Agent'], 'github requests carry a User-Agent');
  const o = adapters.buildRequest('openai', 'chat', { model: 'gpt-4o-mini', messages: '[{"role":"user","content":"hi"}]' }, 'sk-test');
  assert.equal(o.ok, true);
  assert.equal(o.request.url, 'https://api.openai.com/v1/chat/completions');
  const a = adapters.buildRequest('anthropic', 'message', { model: 'claude-3-5-haiku-20241022', messages: '[{"role":"user","content":"hi"}]' }, 'ak-test');
  assert.equal(a.ok, true);
  assert.equal(a.request.headers['x-api-key'], 'ak-test');
});

test('url_token providers are flagged so the executor can redact', () => {
  const t = adapters.buildRequest('telegram', 'get_me', {}, '123456:ABC-secret');
  assert.equal(t.ok, true);
  assert.equal(t.request.urlContainsSecret, true, 'telegram token rides the URL');
  const m = adapters.buildRequest('google-gemini', 'list_models', {}, 'AIza-secret');
  assert.equal(m.ok, true);
  assert.equal(m.request.urlContainsSecret, true);
  assert.ok(m.request.url.includes('key=AIza-secret'), 'the gemini key is the documented query param');
});

test('param validation is strict: declared names, string types, length caps, no control chars', () => {
  assert.equal(adapters.buildRequest('github', 'repo_read', {}, 'tok').reason, 'param_missing');
  assert.equal(adapters.buildRequest('github', 'repo_read', { owner: 'a', repo: 'b', extra: 'x' }, 'tok').reason, 'param_invalid');
  assert.equal(adapters.buildRequest('github', 'repo_read', { owner: 'a', repo: 'b\r\nX: y' }, 'tok').reason, 'param_invalid');
  assert.equal(adapters.buildRequest('slack', 'post_message', { channel: 'C1', text: 'x'.repeat(4001) }, 'tok').reason, 'param_invalid');
  assert.equal(adapters.buildRequest('slack', 'post_message', { channel: 'C1', text: 42 }, 'tok').reason, 'param_invalid');
  assert.equal(adapters.buildRequest('openai', 'chat', { model: 'm', messages: 'not json' }, 'tok').reason, 'param_invalid');
});

test('oauth providers build authorize and token requests from the USER OWN client only', () => {
  for (const id of OAUTH) {
    const u = adapters.authorizeUrl(id, { client_id: 'my-client', redirect_uri: 'http://127.0.0.1:53535' }, 'state-1');
    assert.equal(u.ok, true, id + ' authorize url');
    assert.ok(u.url.startsWith('https://'), id + ' authorize is https');
    assert.ok(u.url.includes('client_id=my-client'), id + ' uses the user own client id');
    assert.ok(u.url.includes('state=state-1'), id + ' carries the state');
    const t = adapters.tokenRequest(id, { client_id: 'my-client', client_secret: 'my-secret', redirect_uri: 'http://127.0.0.1:53535' }, 'the-code');
    assert.equal(t.ok, true, id + ' token request');
    assert.equal(t.request.method, 'POST');
    assert.ok(t.request.url.indexOf('my-secret') === -1 && t.request.url.indexOf('the-code') === -1, id + ' keeps secrets out of the token URL');
    assert.ok(t.request.body.includes('grant_type=authorization_code'), id + ' exchanges the code');
    assert.ok(t.request.headers['Content-Type'].includes('x-www-form-urlencoded'), id + ' form-encoded token exchange');
  }
});

test('redirects are locked to https or loopback and config is validated', () => {
  assert.equal(adapters.authorizeUrl('gmail', { client_id: 'c', redirect_uri: 'http://evil.example.com/cb' }, '').ok, false);
  assert.equal(adapters.authorizeUrl('gmail', { client_id: 'c', redirect_uri: 'http://127.0.0.1:0/cb?extra=1' }, '').ok, false);
  assert.equal(adapters.authorizeUrl('gmail', { client_id: 'c', redirect_uri: 'https://app.example.com/cb' }, '').ok, true);
  assert.equal(adapters.authorizeUrl('gmail', { redirect_uri: 'http://127.0.0.1/cb' }, '').ok, false);
  assert.equal(adapters.authorizeUrl('spotify', {}, '').reason, 'no_oauth', 'definition-only entries have no oauth surface');
});

test('oauth credentials are parsed fail-closed and never returned raw', () => {
  assert.equal(adapters.buildRequest('gmail', 'list_messages', {}, null).reason, 'credential_missing');
  assert.equal(adapters.buildRequest('gmail', 'list_messages', {}, 'not-json').reason, 'credential_invalid');
  assert.equal(adapters.buildRequest('gmail', 'list_messages', {}, JSON.stringify({ client_id: 'c', refresh_token: 'r' })).reason, 'credential_invalid', 'no access token, no request');
  const ok = adapters.buildRequest('gmail', 'list_messages', { max_results: '3' }, JSON.stringify({ client_id: 'c', access_token: 'at' }));
  assert.equal(ok.ok, true);
  assert.equal(ok.request.headers.Authorization, 'Bearer at');
});

test('mail and calendar writes build honest payloads and validate inputs', () => {
  assert.equal(adapters.buildRequest('gmail', 'send_message', { to: 'a@b.com', subject: 'Sub\r\nject', text: 'hi' }, JSON.stringify({ client_id: 'c', access_token: 'at' })).reason, 'param_invalid', 'control chars are rejected outright, not stripped');
  const g = adapters.buildRequest('gmail', 'send_message', { to: 'a@b.com', subject: 'Subject line', text: 'hi' }, JSON.stringify({ client_id: 'c', access_token: 'at' }));
  assert.equal(g.ok, true);
  assert.ok(g.request.body.includes('"raw"'), 'the gmail send builds the base64url MIME raw');
  assert.equal(adapters.buildRequest('gmail', 'send_message', { to: 'not-an-email', subject: 's', text: 'x' }, JSON.stringify({ client_id: 'c', access_token: 'at' })).reason, 'param_invalid');
  const cal = adapters.buildRequest('google-calendar', 'create_event', { summary: 'Focus', start: '2026-12-01T10:00:00Z', end: '2026-12-01T11:00:00Z' }, JSON.stringify({ client_id: 'c', access_token: 'at' }));
  assert.equal(cal.ok, true);
  assert.ok(cal.request.body.includes('2026-12-01T10:00:00Z'));
  assert.equal(adapters.buildRequest('google-calendar', 'create_event', { summary: 'x', start: 'tomorrow', end: 'later' }, JSON.stringify({ client_id: 'c', access_token: 'at' })).reason, 'param_invalid');
  const mc = adapters.buildRequest('microsoft-calendar', 'list_events', {}, JSON.stringify({ client_id: 'c', access_token: 'at' }));
  assert.equal(mc.ok, true);
  assert.ok(mc.request.url.startsWith('https://graph.microsoft.com/v1.0/me/calendarview'));
});

test('definition-only and unknown entries get no adapter at all', () => {
  assert.equal(adapters.get('spotify'), null);
  assert.equal(adapters.listActions('spotify'), null);
  assert.equal(adapters.buildRequest('spotify', 'anything', {}, 'tok').reason, 'no_adapter');
  assert.equal(adapters.buildRequest('no-such-connector', 'x', {}, 'tok').reason, 'no_adapter');
  assert.equal(adapters.buildRequest('rss', 'feed.read', {}, 'tok').reason, 'no_adapter', 'legacy tier stays honest: no adapter, no fake execution');
});
