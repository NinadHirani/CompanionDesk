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

// ---- batch 2 (27 Nov 2026): provider-specific read actions --------------

test('github get_issue builds the REST url for one issue', () => {
  const r = adapters.buildRequest('github', 'get_issue', { owner: 'octo', repo: 'repo', number: '42' }, 'tok');
  assert.equal(r.ok, true);
  assert.equal(r.request.url, 'https://api.github.com/repos/octo/repo/issues/42');
  assert.equal(r.request.method, 'GET');
  const bad = adapters.buildRequest('github', 'get_issue', { owner: 'o', repo: 'r', number: 'x!y' }, 'tok');
  assert.equal(bad.ok, false, 'a non-numeric issue number never reaches a URL');
});

test('slack get_channel targets conversations.info only', () => {
  const r = adapters.buildRequest('slack', 'get_channel', { channel: 'C123' }, 'tok');
  assert.equal(r.ok, true);
  assert.equal(r.request.url, 'https://slack.com/api/conversations.info?channel=C123');
});

test('google-drive get_file_meta reads metadata by id', () => {
  const blob = JSON.stringify({ client_id: 'c', access_token: 'at', refresh_token: 'rt', expires_at: 9e12 });
  const r = adapters.buildRequest('google-drive', 'get_file_meta', { file_id: 'abc123' }, blob);
  assert.equal(r.ok, true);
  assert.equal(r.request.url, 'https://www.googleapis.com/drive/v3/files/abc123?fields=id,name,mimeType,size,modifiedTime');
});

test('gmail and outlook search actions build search queries', () => {
  const blob = JSON.stringify({ client_id: 'c', access_token: 'at', refresh_token: 'rt', expires_at: 9e12 });
  const g = adapters.buildRequest('gmail', 'search_messages', { query: 'from:boss' }, blob);
  assert.equal(g.ok, true);
  assert.equal(g.request.url, 'https://gmail.googleapis.com/gmail/v1/users/me/messages?q=from%3Aboss');
  const o = adapters.buildRequest('microsoft-outlook', 'search_messages', { query: 'quarterly' }, blob);
  assert.equal(o.ok, true);
  assert.equal(o.request.url.indexOf('https://graph.microsoft.com/v1.0/me/messages?$search='), 0);
});

test('calendar get_event actions read one event by id', () => {
  const blob = JSON.stringify({ client_id: 'c', access_token: 'at', refresh_token: 'rt', expires_at: 9e12 });
  const g = adapters.buildRequest('google-calendar', 'get_event', { event_id: 'ev1' }, blob);
  assert.equal(g.ok, true);
  assert.equal(g.request.url, 'https://www.googleapis.com/calendar/v3/calendars/primary/events/ev1');
  const m = adapters.buildRequest('microsoft-calendar', 'get_event', { event_id: 'ev2' }, blob);
  assert.equal(m.ok, true);
  assert.equal(m.request.url, 'https://graph.microsoft.com/v1.0/me/events/ev2');
});

test('onedrive get_file_meta reads one drive item', () => {
  const blob = JSON.stringify({ client_id: 'c', access_token: 'at', refresh_token: 'rt', expires_at: 9e12 });
  const r = adapters.buildRequest('microsoft-onedrive', 'get_file_meta', { item_id: 'itm1' }, blob);
  assert.equal(r.ok, true);
  assert.equal(r.request.url.indexOf('https://graph.microsoft.com/v1.0/me/drive/items/itm1?select='), 0);
});

test('listActions passes required parameter names through', () => {
  const acts = adapters.listActions('github');
  const getIssue = acts.find((a) => a.id === 'get_issue');
  assert.deepEqual(getIssue.params, [{ name: 'owner', required: true }, { name: 'repo', required: true }, { name: 'number', required: true }]);
  const list = acts.find((a) => a.id === 'repo_read');
  assert.deepEqual(list.params, [{ name: 'owner', required: true }, { name: 'repo', required: true }]);
});

test('every action scope stays declared on its catalog entry', () => {
  const catalog = require('../src/connectors.js').createConnectorCatalog({ clock: () => 0 });
  for (const id of adapters.ADAPTER_IDS) {
    const acts = adapters.listActions(id) || [];
    for (const a of acts) {
      const desc = catalog.describe(id);
      assert.ok(desc, id + ' must exist in the catalog');
      const names = (desc.scopes || []).map((s) => s.name);
      assert.ok(names.indexOf(a.scope) !== -1, id + '.' + a.id + ' scope ' + a.scope + ' must be declared');
    }
  }
});

// ---- batch 3 (27 Nov 2026): write actions, low-risk create only ----

test('write actions build safe create requests with validated params', () => {
  const gh = adapters.buildRequest('github', 'create_issue', { owner: 'own er', repo: 'r', title: 'T', body: 'B' }, 'ghp-tok');
  assert.equal(gh.ok, true);
  assert.equal(gh.request.method, 'POST');
  assert.equal(gh.request.url, 'https://api.github.com/repos/own%20er/r/issues');
  assert.deepEqual(JSON.parse(gh.request.body), { title: 'T', body: 'B' });
  const ghNoBody = adapters.buildRequest('github', 'create_issue', { owner: 'o', repo: 'r', title: 'T' }, 'ghp-tok');
  assert.deepEqual(JSON.parse(ghNoBody.request.body), { title: 'T' });

  const np = adapters.buildRequest('notion', 'create_page', { parent_id: 'p1', title: 'T', content: 'C' }, 'secret');
  assert.equal(np.ok, true);
  assert.equal(np.request.method, 'POST');
  assert.equal(np.request.url, 'https://api.notion.com/v1/pages');
  const npBody = JSON.parse(np.request.body);
  assert.equal(npBody.parent.page_id, 'p1');
  assert.equal(npBody.children[0].paragraph.rich_text[0].text.content, 'C');
  const npNoContent = adapters.buildRequest('notion', 'create_page', { parent_id: 'p1', title: 'T' }, 'secret');
  assert.equal(JSON.parse(npNoContent.request.body).children, undefined);

  const df = adapters.buildRequest('google-drive', 'create_file', { name: 'notes.txt', content: 'hello' }, JSON.stringify({ client_id: 'c', access_token: 'at' }));
  assert.equal(df.ok, true);
  assert.equal(df.request.method, 'POST');
  assert.ok(df.request.url.startsWith('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart'));
  assert.ok(df.request.body.indexOf('notes.txt') !== -1 && df.request.body.indexOf('hello') !== -1);
  assert.ok(/multipart\/related; boundary=/.test(df.request.headers['Content-Type']), 'multipart content type carries the boundary');

  const of = adapters.buildRequest('microsoft-onedrive', 'create_file', { name: 'a b.txt', content: 'hi' }, JSON.stringify({ client_id: 'c', access_token: 'at' }));
  assert.equal(of.ok, true);
  assert.equal(of.request.method, 'PUT', 'Graph simple upload is a PUT');
  assert.equal(of.request.url, 'https://graph.microsoft.com/v1.0/me/drive/root:/a%20b.txt:/content');
  assert.equal(of.request.body, 'hi');
  assert.equal(of.request.headers['Content-Type'], 'text/plain; charset=UTF-8');
});

test('the new write actions are declared with write scopes and required params', () => {
  const checks = [
    ['github', 'create_issue', 'issues.write', 'owner,repo,title'],
    ['notion', 'create_page', 'pages.write', 'parent_id,title'],
    ['google-drive', 'create_file', 'files.write', 'name,content'],
    ['microsoft-onedrive', 'create_file', 'files.write', 'name,content'],
  ];
  for (const [id, actionId, scope, required] of checks) {
    const a = adapters.listActions(id).find((x) => x.id === actionId);
    assert.ok(a, id + ' exposes ' + actionId);
    assert.equal(a.kind, 'write', actionId + ' is write kind');
    assert.equal(a.scope, scope, actionId + ' uses its declared write scope');
    assert.equal(a.params.filter((p) => p.required).map((p) => p.name).join(','), required, actionId + ' required params');
  }
});

test('validateOnly checks params without parsing any credential', () => {
  assert.equal(adapters.validateOnly('github', 'create_issue', { owner: 'o', repo: 'r' }), 'param_missing', 'missing title refuses');
  assert.equal(adapters.validateOnly('github', 'create_issue', { owner: 'o', repo: 'r', title: 'T', junk: 'x' }), 'param_invalid', 'unknown param refuses');
  assert.equal(adapters.validateOnly('github', 'create_issue', { owner: 'o', repo: 'r', title: 'x'.repeat(201) }), 'param_invalid', 'over-length title refuses');
  assert.equal(adapters.validateOnly('github', 'create_issue', { owner: 'o', repo: 'r', title: 'T' }), null, 'valid params pass with NO credential at all');
});

// ---- batch 4 (27 Nov 2026): calendar create_event write parity ----

test('google-calendar create_event builds a safe create-only POST', () => {
  const cred = JSON.stringify({ client_id: 'c', access_token: 'at' });
  const r = adapters.buildRequest('google-calendar', 'create_event', { summary: 'Focus block', start: '2026-12-01T10:00:00Z', end: '2026-12-01T11:00:00Z' }, cred);
  assert.equal(r.ok, true);
  assert.equal(r.request.method, 'POST');
  assert.equal(r.request.url, 'https://www.googleapis.com/calendar/v3/calendars/primary/events');
  const body = JSON.parse(r.request.body);
  assert.equal(body.summary, 'Focus block');
  assert.equal(body.start.dateTime, '2026-12-01T10:00:00Z');
  assert.equal(body.end.dateTime, '2026-12-01T11:00:00Z');
  assert.equal(body.description, undefined, 'create-only: no fields beyond the declared params');
  assert.equal(adapters.buildRequest('google-calendar', 'create_event', { summary: 'x', start: 'bad', end: '2026-12-01T11:00:00Z' }, cred).reason, 'param_invalid');
  assert.equal(adapters.buildRequest('google-calendar', 'create_event', { start: '2026-12-01T10:00:00Z', end: '2026-12-01T11:00:00Z' }, cred).reason, 'param_missing');
});

test('microsoft-calendar create_event builds a safe create-only POST pinned to UTC', () => {
  const cred = JSON.stringify({ client_id: 'c', access_token: 'at' });
  const r = adapters.buildRequest('microsoft-calendar', 'create_event', { subject: 'Standup', start: '2026-12-02T09:00:00Z', end: '2026-12-02T09:30:00Z' }, cred);
  assert.equal(r.ok, true);
  assert.equal(r.request.method, 'POST');
  assert.equal(r.request.url, 'https://graph.microsoft.com/v1.0/me/events');
  const body = JSON.parse(r.request.body);
  assert.equal(body.subject, 'Standup');
  assert.equal(body.start.timeZone, 'UTC');
  assert.equal(body.end.timeZone, 'UTC');
  assert.equal(adapters.buildRequest('microsoft-calendar', 'create_event', { subject: 'x', start: 'bad', end: '2026-12-02T09:30:00Z' }, cred).reason, 'param_invalid');
  assert.equal(adapters.buildRequest('microsoft-calendar', 'create_event', { subject: 'x', start: '2026-12-02T09:00:00Z' }, cred).reason, 'param_missing');
});

test('both calendar providers declare create_event identically as a gated write', () => {
  for (const id of ['google-calendar', 'microsoft-calendar']) {
    const a = adapters.listActions(id).find((x) => x.id === 'create_event');
    assert.ok(a, id + ' exposes create_event');
    assert.equal(a.kind, 'write');
    assert.equal(a.scope, 'events.write');
    assert.equal(a.params.filter((p) => p.required).length, 3);
    assert.equal(adapters.validateOnly(id, 'create_event', {}), 'param_missing', 'validateOnly works with no credential at all');
  }
});
