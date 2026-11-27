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

const IMPLEMENTED = ['anthropic', 'brave-search', 'arxiv', 'crossref', 'discord', 'docker-hub', 'github', 'gitlab', 'gmail', 'google-calendar', 'google-docs', 'google-sheets', 'google-drive', 'google-gemini', 'huggingface', 'internet-archive', 'jira', 'microsoft-calendar', 'microsoft-onedrive', 'microsoft-excel', 'microsoft-outlook', 'microsoft-teams', 'microsoft-word', 'musicbrainz', 'notion', 'npm', 'open-meteo', 'openai', 'openalex', 'openlibrary', 'openstreetmap', 'pypi', 'slack', 'tavily', 'telegram', 'wikimedia'];
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

// ---- batch 5 (27 Nov 2026): read actions for the thin messaging adapters ----

test('slack list_users builds a scoped directory read with a bounded limit', () => {
  const ok = adapters.buildRequest('slack', 'list_users', {}, 'xoxb-tok');
  assert.equal(ok.ok, true);
  assert.equal(ok.request.method, 'GET');
  assert.equal(ok.request.url, 'https://slack.com/api/users.list?limit=50');
  const lim = adapters.buildRequest('slack', 'list_users', { limit: '5' }, 'xoxb-tok');
  assert.equal(lim.request.url, 'https://slack.com/api/users.list?limit=5');
  assert.equal(adapters.buildRequest('slack', 'list_users', { limit: '300' }, 'xoxb-tok').reason, 'param_invalid', 'limit is capped');
  const a = adapters.listActions('slack').find((x) => x.id === 'list_users');
  assert.equal(a.kind, 'read_only');
  assert.equal(a.scope, 'users.read');
});

test('discord channel reads validate snowflake ids and cap the message limit', () => {
  const cred = 'bot-token';
  const lc = adapters.buildRequest('discord', 'list_channels', { guild_id: '123456789012345678' }, cred);
  assert.equal(lc.ok, true);
  assert.equal(lc.request.url, 'https://discord.com/api/v10/guilds/123456789012345678/channels');
  assert.equal(adapters.buildRequest('discord', 'list_channels', { guild_id: 'not-a-snowflake' }, cred).reason, 'param_invalid');
  const gc = adapters.buildRequest('discord', 'get_channel', { channel_id: '123456789012345678' }, cred);
  assert.equal(gc.ok, true);
  assert.equal(gc.request.url, 'https://discord.com/api/v10/channels/123456789012345678');
  const lm = adapters.buildRequest('discord', 'list_channel_messages', { channel_id: '123456789012345678' }, cred);
  assert.equal(lm.request.url, 'https://discord.com/api/v10/channels/123456789012345678/messages?limit=20');
  const lm5 = adapters.buildRequest('discord', 'list_channel_messages', { channel_id: '123456789012345678', limit: '5' }, cred);
  assert.equal(lm5.request.url, 'https://discord.com/api/v10/channels/123456789012345678/messages?limit=5');
  assert.equal(adapters.buildRequest('discord', 'list_channel_messages', { channel_id: '123456789012345678', limit: '300' }, cred).reason, 'param_invalid');
  assert.equal(adapters.buildRequest('discord', 'get_channel', { channel_id: 'drop table' }, cred).reason, 'param_invalid');
  for (const id of ['list_channels', 'get_channel', 'list_channel_messages']) {
    const a = adapters.listActions('discord').find((x) => x.id === id);
    assert.equal(a.kind, 'read_only', id + ' is a read');
  }
  assert.equal(adapters.listActions('discord').find((x) => x.id === 'list_channels').scope, 'guilds.read');
  assert.equal(adapters.listActions('discord').find((x) => x.id === 'list_channel_messages').scope, 'channels.read');
});

test('telegram reads validate ids and cap limits without long-polling', () => {
  const cred = 'bot-token';
  const gu = adapters.buildRequest('telegram', 'get_updates', {}, cred);
  assert.equal(gu.ok, true);
  assert.equal(gu.request.url, 'https://api.telegram.org/bot' + encodeURIComponent(cred) + '/getUpdates?limit=20');
  const gu2 = adapters.buildRequest('telegram', 'get_updates', { limit: '3', offset: '987654321' }, cred);
  assert.equal(gu2.request.url, 'https://api.telegram.org/bot' + encodeURIComponent(cred) + '/getUpdates?limit=3&offset=987654321');
  assert.equal(adapters.buildRequest('telegram', 'get_updates', { offset: 'abc' }, cred).reason, 'param_invalid', 'offset must be numeric');
  assert.equal(adapters.buildRequest('telegram', 'get_updates', { limit: '500' }, cred).reason, 'param_invalid');
  const gc = adapters.buildRequest('telegram', 'get_chat', { chat_id: '-1001234567890' }, cred);
  assert.equal(gc.ok, true, 'group chat ids may be negative');
  assert.equal(gc.request.url, 'https://api.telegram.org/bot' + encodeURIComponent(cred) + '/getChat?chat_id=-1001234567890');
  assert.equal(adapters.buildRequest('telegram', 'get_chat', { chat_id: '@channelname' }, cred).reason, 'param_invalid', 'only numeric chat ids allowed');
  assert.equal(adapters.listActions('telegram').find((x) => x.id === 'get_updates').kind, 'read_only');
  assert.equal(adapters.listActions('telegram').find((x) => x.id === 'get_chat').scope, 'chats.read');
});

// ---- batch 6 (27 Nov 2026): practical reads + one new API-key provider ----

test('github pull-request and commit reads build safe GETs', () => {
  const cred = 'ghp-tok';
  const pr = adapters.buildRequest('github', 'list_pull_requests', { owner: 'NinadHirani', repo: 'CompanionDesk' }, cred);
  assert.equal(pr.ok, true);
  assert.equal(pr.request.method, 'GET');
  assert.equal(pr.request.url, 'https://api.github.com/repos/NinadHirani/CompanionDesk/pulls?state=open&per_page=20');
  const co = adapters.buildRequest('github', 'list_commits', { owner: 'NinadHirani', repo: 'CompanionDesk' }, cred);
  assert.equal(co.ok, true);
  assert.equal(co.request.url, 'https://api.github.com/repos/NinadHirani/CompanionDesk/commits?per_page=20');
  assert.equal(adapters.listActions('github').find((x) => x.id === 'list_pull_requests').scope, 'repos.read');
  assert.equal(adapters.listActions('github').find((x) => x.id === 'list_commits').kind, 'read_only');
});

test('notion page blocks read builds a bounded GET', () => {
  const r = adapters.buildRequest('notion', 'get_page_blocks', { page_id: 'abc-123' }, 'secret');
  assert.equal(r.ok, true);
  assert.equal(r.request.method, 'GET');
  assert.equal(r.request.url, 'https://api.notion.com/v1/blocks/abc-123/children?page_size=100');
  assert.equal(adapters.listActions('notion').find((x) => x.id === 'get_page_blocks').scope, 'pages.read');
});

test('slack channel history read validates the limit and channel param', () => {
  const cred = 'xoxb-tok';
  const r = adapters.buildRequest('slack', 'get_channel_history', { channel: 'C123' }, cred);
  assert.equal(r.ok, true);
  assert.equal(r.request.url, 'https://slack.com/api/conversations.history?channel=C123&limit=20');
  const r5 = adapters.buildRequest('slack', 'get_channel_history', { channel: 'C123', limit: '5' }, cred);
  assert.equal(r5.request.url, 'https://slack.com/api/conversations.history?channel=C123&limit=5');
  assert.equal(adapters.buildRequest('slack', 'get_channel_history', { channel: 'C123', limit: '500' }, cred).reason, 'param_invalid');
  assert.equal(adapters.listActions('slack').find((x) => x.id === 'get_channel_history').scope, 'channels.read');
});

test('the new huggingface adapter reads the Hub with a plain token', () => {
  const cred = 'hf-tok';
  const w = adapters.buildRequest('huggingface', 'whoami', {}, cred);
  assert.equal(w.ok, true);
  assert.equal(w.request.method, 'GET');
  assert.equal(w.request.url, 'https://huggingface.co/api/whoami-v2');
  assert.equal(w.request.headers.Authorization, 'Bearer ' + cred);
  const lm = adapters.buildRequest('huggingface', 'list_models', { search: 'quantum', limit: '5' }, cred);
  assert.equal(lm.request.url, 'https://huggingface.co/api/models?limit=5&search=quantum');
  const lmDefault = adapters.buildRequest('huggingface', 'list_models', {}, cred);
  assert.equal(lmDefault.request.url, 'https://huggingface.co/api/models?limit=20');
  assert.equal(adapters.buildRequest('huggingface', 'list_models', { limit: '500' }, cred).reason, 'param_invalid');
  for (const id of ['whoami', 'list_models']) {
    const a = adapters.listActions('huggingface').find((x) => x.id === id);
    assert.equal(a.kind, 'read_only', id + ' is a read');
    assert.equal(a.scope, 'models.read');
  }
  assert.deepEqual(adapters.validateOnly('huggingface', 'whoami', {}), null, 'validateOnly needs no credential');
});

// ---- batch 7 (27 Nov 2026): public research connectors, read-only ----

test('arxiv search and lookup build safe public GETs with no credential', () => {
  const s = adapters.buildRequest('arxiv', 'search_papers', { query: 'QAOA vehicle routing' });
  assert.equal(s.ok, true);
  assert.equal(s.request.method, 'GET');
  assert.equal(s.request.url, 'https://export.arxiv.org/api/query?search_query=all:' + encodeURIComponent('QAOA vehicle routing') + '&start=0&max_results=20');
  assert.equal(s.request.headers.Authorization, undefined, 'no credential rides a public call');
  const g = adapters.buildRequest('arxiv', 'get_paper', { id: '2310.12345v2' });
  assert.equal(g.ok, true);
  assert.equal(g.request.url, 'https://export.arxiv.org/api/query?id_list=2310.12345v2&max_results=1');
  assert.equal(adapters.buildRequest('arxiv', 'get_paper', { id: 'bad id!' }).reason, 'param_invalid');
  assert.equal(adapters.buildRequest('arxiv', 'search_papers', { query: 'q', limit: '500' }).reason, 'param_invalid');
  assert.equal(adapters.validateOnly('arxiv', 'get_paper', { id: 'ok.id' }), null, 'validateOnly needs no credential');
});

test('crossref work search and DOI lookup validate the DOI shape', () => {
  const s = adapters.buildRequest('crossref', 'search_works', { query: 'quantum annealing', limit: '5' });
  assert.equal(s.ok, true);
  assert.equal(s.request.url, 'https://api.crossref.org/works?query=' + encodeURIComponent('quantum annealing') + '&rows=5');
  const g = adapters.buildRequest('crossref', 'get_work', { doi: '10.1234/abc.def' });
  assert.equal(g.request.url, 'https://api.crossref.org/works/10.1234%2Fabc.def');
  assert.equal(adapters.buildRequest('crossref', 'get_work', { doi: 'not-a-doi' }).reason, 'param_invalid');
  assert.equal(adapters.buildRequest('crossref', 'search_works', {}).reason, 'param_missing');
});

test('openalex search and work lookup accept OpenAlex ids and DOIs', () => {
  const s = adapters.buildRequest('openalex', 'search_works', { search: 'quantum' });
  assert.equal(s.request.url, 'https://api.openalex.org/works?search=quantum&per-page=20');
  const w = adapters.buildRequest('openalex', 'get_work', { work_id: 'W2741809807' });
  assert.equal(w.request.url, 'https://api.openalex.org/works/W2741809807');
  const d = adapters.buildRequest('openalex', 'get_work', { work_id: 'doi:10.1234/x' });
  assert.equal(d.request.url, 'https://api.openalex.org/works/doi%3A10.1234%2Fx');
  assert.equal(adapters.buildRequest('openalex', 'get_work', { work_id: 'javascript:alert(1)' }).reason, 'param_invalid');
  assert.equal(adapters.buildRequest('openalex', 'search_works', { search: 'q', limit: '500' }).reason, 'param_invalid');
});

test('the three research adapters are read-only under declared scopes', () => {
  for (const pair of [['arxiv', 'papers.read'], ['crossref', 'works.read'], ['openalex', 'works.read']]) {
    for (const a of adapters.listActions(pair[0])) {
      assert.equal(a.kind, 'read_only', pair[0] + '.' + a.id + ' is a read');
      assert.equal(a.scope, pair[1]);
    }
  }
});

// ---- batch 8 (27 Nov 2026): Open-Meteo weather + OSM Nominatim, keyless ----

test('open-meteo reads validate coordinates and build plain public GETs', () => {
  const r = adapters.buildRequest('open-meteo', 'get_current_weather', { latitude: '22.3039', longitude: '70.8022' });
  assert.equal(r.ok, true);
  assert.equal(r.request.method, 'GET');
  assert.equal(r.request.url, 'https://api.open-meteo.com/v1/forecast?latitude=22.3039&longitude=70.8022&current=temperature_2m,weather_code,wind_speed_10m');
  assert.equal(r.request.headers.Authorization, undefined, 'no credential rides a public call');
  const f = adapters.buildRequest('open-meteo', 'get_daily_forecast', { latitude: '-33.9', longitude: '151.2', days: '5' });
  assert.equal(f.request.url, 'https://api.open-meteo.com/v1/forecast?latitude=-33.9&longitude=151.2&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code&forecast_days=5');
  for (const bad of [{ latitude: '91', longitude: '10' }, { latitude: 'abc', longitude: '10' }, { latitude: '1e5', longitude: '10' }]) {
    assert.equal(adapters.buildRequest('open-meteo', 'get_current_weather', bad).reason, 'param_invalid');
  }
  assert.equal(adapters.buildRequest('open-meteo', 'get_current_weather', { latitude: '', longitude: '10' }).reason, 'param_missing');
  assert.equal(adapters.buildRequest('open-meteo', 'get_daily_forecast', { latitude: '1', longitude: '1', days: '17' }).reason, 'param_invalid');
  assert.equal(adapters.validateOnly('open-meteo', 'get_current_weather', { latitude: '1', longitude: '2' }), null, 'validateOnly needs no credential');
});

test('openstreetmap Nominatim reads validate params and cap results', () => {
  const s = adapters.buildRequest('openstreetmap', 'search_places', { query: 'Rajkot' });
  assert.equal(s.ok, true);
  assert.equal(s.request.url, 'https://nominatim.openstreetmap.org/search?q=Rajkot&format=jsonv2&limit=10');
  assert.ok(s.request.headers['User-Agent'].indexOf('CompanionDesk') === 0, 'a descriptive User-Agent rides every Nominatim call');
  const rev = adapters.buildRequest('openstreetmap', 'reverse_geocode', { latitude: '22.3039', longitude: '70.8022' });
  assert.equal(rev.request.url, 'https://nominatim.openstreetmap.org/reverse?lat=22.3039&lon=70.8022&format=jsonv2');
  assert.equal(adapters.buildRequest('openstreetmap', 'search_places', { query: 'q', limit: '99' }).reason, 'param_invalid');
  assert.equal(adapters.buildRequest('openstreetmap', 'reverse_geocode', { latitude: '-95', longitude: '10' }).reason, 'param_invalid');
  for (const a of adapters.listActions('openstreetmap')) {
    assert.equal(a.kind, 'read_only');
    assert.equal(a.scope, 'places.read');
  }
  for (const a of adapters.listActions('open-meteo')) {
    assert.equal(a.kind, 'read_only');
    assert.equal(a.scope, 'weather.read');
  }
});

// ---- batch 9 (27 Nov 2026): Wikipedia + Open Library, keyless reads ----

test('wikimedia search and summary build pinned-host public GETs', () => {
  const s = adapters.buildRequest('wikimedia', 'search_pages', { query: 'quantum computing' });
  assert.equal(s.ok, true);
  assert.equal(s.request.method, 'GET');
  assert.equal(s.request.url, 'https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=' + encodeURIComponent('quantum computing') + '&format=json&srlimit=10');
  assert.equal(s.request.headers.Authorization, undefined, 'no credential rides a public call');
  assert.ok(s.request.headers['User-Agent'].indexOf('CompanionDesk') === 0, 'a descriptive User-Agent rides every Wikimedia call');
  const g = adapters.buildRequest('wikimedia', 'get_page_summary', { title: 'Qiskit' });
  assert.equal(g.request.url, 'https://en.wikipedia.org/api/rest_v1/page/summary/Qiskit');
  assert.equal(adapters.buildRequest('wikimedia', 'search_pages', { query: 'q', limit: '99' }).reason, 'param_invalid');
  assert.equal(adapters.buildRequest('wikimedia', 'search_pages', {}).reason, 'param_missing');
  assert.equal(adapters.validateOnly('wikimedia', 'get_page_summary', { title: 'X' }), null, 'validateOnly needs no credential');
});

test('openlibrary search and book lookup validate identifiers', () => {
  const s = adapters.buildRequest('openlibrary', 'search_books', { query: 'quantum algorithms', limit: '5' });
  assert.equal(s.ok, true);
  assert.equal(s.request.url, 'https://openlibrary.org/search.json?q=' + encodeURIComponent('quantum algorithms') + '&limit=5');
  const isbn = adapters.buildRequest('openlibrary', 'get_book', { identifier: '9780262033848' });
  assert.equal(isbn.request.url, 'https://openlibrary.org/isbn/9780262033848.json');
  const isbn10 = adapters.buildRequest('openlibrary', 'get_book', { identifier: '0262033844' });
  assert.equal(isbn10.request.url, 'https://openlibrary.org/isbn/0262033844.json');
  const edition = adapters.buildRequest('openlibrary', 'get_book', { identifier: 'OL1234567M' });
  assert.equal(edition.request.url, 'https://openlibrary.org/books/OL1234567M.json');
  const work = adapters.buildRequest('openlibrary', 'get_book', { identifier: 'OL1234567W' });
  assert.equal(work.request.url, 'https://openlibrary.org/works/OL1234567W.json');
  assert.equal(adapters.buildRequest('openlibrary', 'get_book', { identifier: '../etc/passwd' }).reason, 'param_invalid');
  assert.equal(adapters.buildRequest('openlibrary', 'get_book', { identifier: 'not-an-id' }).reason, 'param_invalid');
  assert.equal(adapters.buildRequest('openlibrary', 'search_books', { query: 'q', limit: '500' }).reason, 'param_invalid');
  for (const a of adapters.listActions('openlibrary')) {
    assert.equal(a.kind, 'read_only');
    assert.equal(a.scope, 'books.read');
  }
  for (const a of adapters.listActions('wikimedia')) {
    assert.equal(a.kind, 'read_only');
    assert.equal(a.scope, 'search.read');
  }
});

// ---- batch 10 (27 Nov 2026): Brave Search + Tavily, key-auth reads ----

test('brave search builds a pinned-host GET with the key only in headers', () => {
  const s = adapters.buildRequest('brave-search', 'web_search', { query: 'qaoa vehicle routing' }, 'brv-test-key-123');
  assert.equal(s.ok, true);
  assert.equal(s.request.method, 'GET');
  assert.equal(s.request.url, 'https://api.search.brave.com/res/v1/web/search?q=' + encodeURIComponent('qaoa vehicle routing') + '&count=10');
  assert.equal(s.request.headers['X-Subscription-Token'], 'brv-test-key-123');
  assert.ok(s.request.url.indexOf('brv-test-key') === -1, 'the key never rides the URL');
  assert.equal(s.request.urlContainsSecret, false);
  assert.equal(adapters.buildRequest('brave-search', 'web_search', { query: 'q', count: '99' }, 'k').reason, 'param_invalid');
  assert.equal(adapters.buildRequest('brave-search', 'web_search', { query: 'q', count: '0' }, 'k').reason, 'param_invalid');
  assert.equal(adapters.buildRequest('brave-search', 'web_search', {}, 'k').reason, 'param_missing');
  assert.equal(adapters.validateOnly('brave-search', 'web_search', { query: 'x' }), null, 'validateOnly needs no credential');
  const [a] = adapters.listActions('brave-search');
  assert.equal(a.kind, 'read_only');
  assert.equal(a.scope, 'search.read');
});

test('tavily builds a pinned POST with the key only in the Authorization header', () => {
  const s = adapters.buildRequest('tavily', 'web_search', { query: 'quantum algorithms', max_results: '3' }, 'tvly-test-key-9');
  assert.equal(s.ok, true);
  assert.equal(s.request.method, 'POST');
  assert.equal(s.request.url, 'https://api.tavily.com/search');
  assert.equal(s.request.headers.Authorization, 'Bearer tvly-test-key-9');
  const body = JSON.parse(s.request.body);
  assert.deepEqual(body, { query: 'quantum algorithms', max_results: 3 });
  assert.ok(s.request.body.indexOf('tvly-test-key') === -1, 'the key never rides the body');
  assert.equal(adapters.buildRequest('tavily', 'web_search', { query: 'q', max_results: '99' }, 'k').reason, 'param_invalid');
  assert.equal(adapters.buildRequest('tavily', 'web_search', { query: 'q' }, 'k').ok, true, 'max_results defaults to 5');
  assert.equal(adapters.buildRequest('tavily', 'web_search', {}, 'k').reason, 'param_missing');
  const [a] = adapters.listActions('tavily');
  assert.equal(a.kind, 'read_only');
  assert.equal(a.scope, 'search.read');
});

test('brave and tavily accept no user-controlled host (no SSRF path)', () => {
  const nasty = 'x/../../evil?api_key=zz&next=https://attacker.example';
  const b = adapters.buildRequest('brave-search', 'web_search', { query: nasty }, 'k');
  assert.equal(b.ok, true);
  assert.ok(b.request.url.indexOf('https://api.search.brave.com/res/v1/web/search?q=') === 0, 'brave stays on its pinned host');
  const t = adapters.buildRequest('tavily', 'web_search', { query: nasty }, 'k');
  assert.equal(t.ok, true);
  assert.equal(t.request.url, 'https://api.tavily.com/search', 'tavily stays on its pinned host');
});

// ---- batch 11 (27 Nov 2026): Google Docs + Google Sheets readonly reads ----

test('google docs requests only the readonly scope and reads one document', () => {
  assert.equal(adapters.get('google-docs').oauth.scope, 'https://www.googleapis.com/auth/documents.readonly');
  const au = adapters.authorizeUrl('google-docs', { client_id: 'cid', redirect_uri: 'https://app.example/cb' }, 'st');
  assert.equal(au.ok, true);
  assert.ok(au.url.indexOf('scope=' + encodeURIComponent('https://www.googleapis.com/auth/documents.readonly')) !== -1, 'the consent URL names the readonly scope');
  const tk = adapters.tokenRequest('google-docs', { client_id: 'cid', client_secret: 'cs', redirect_uri: 'https://app.example/cb' }, 'code1');
  assert.equal(tk.ok, true);
  assert.equal(tk.request.url, 'https://oauth2.googleapis.com/token');
  const blob = { client_id: 'cid', access_token: 'at-1', refresh_token: 'rt-1', expires_at: 3600000 };
  const s = adapters.buildRequest('google-docs', 'get_document_content', { document_id: '1AbC_dEf-9GhI' }, JSON.stringify(blob));
  assert.equal(s.ok, true);
  assert.equal(s.request.method, 'GET');
  assert.equal(s.request.url, 'https://docs.googleapis.com/v1/documents/1AbC_dEf-9GhI?fields=documentId,title,body');
  assert.equal(s.request.headers.Authorization, 'Bearer at-1');
  assert.equal(s.request.urlContainsSecret, false);
  for (const bad of ['../etc/passwd', 'a/b', 'id?x=1', 'id x']) {
    assert.equal(adapters.buildRequest('google-docs', 'get_document_content', { document_id: bad }, JSON.stringify(blob)).reason, 'param_invalid', bad);
  }
  assert.equal(adapters.validateOnly('google-docs', 'get_document_content', { document_id: 'x' }), null, 'validateOnly needs no credential');
  const [a] = adapters.listActions('google-docs');
  assert.equal(a.kind, 'read_only');
  assert.equal(a.scope, 'documents.read');
});

test('google sheets validates spreadsheet ids and ranges and stays on the pinned host', () => {
  assert.equal(adapters.get('google-sheets').oauth.scope, 'https://www.googleapis.com/auth/spreadsheets.readonly');
  const blob = { client_id: 'cid', access_token: 'at-1', refresh_token: 'rt-1', expires_at: 3600000 };
  const s = adapters.buildRequest('google-sheets', 'get_values', { spreadsheet_id: '1BxiMVs0XRA5', range: "Sheet 1!A1:C10" }, JSON.stringify(blob));
  assert.equal(s.ok, true);
  assert.equal(s.request.url, 'https://sheets.googleapis.com/v4/spreadsheets/1BxiMVs0XRA5/values/' + encodeURIComponent('Sheet 1!A1:C10') + '?majorDimension=ROWS');
  assert.equal(s.request.headers.Authorization, 'Bearer at-1');
  for (const bad of ['../x', 'id/y', 'id;drop', 'id?q=1']) {
    assert.equal(adapters.buildRequest('google-sheets', 'get_values', { spreadsheet_id: bad, range: 'A1' }, JSON.stringify(blob)).reason, 'param_invalid', bad);
  }
  for (const bad of ['A1;DROP', 'A1?x', '../A1', 'a\nb']) {
    assert.equal(adapters.buildRequest('google-sheets', 'get_values', { spreadsheet_id: '1Bxi', range: bad }, JSON.stringify(blob)).reason, 'param_invalid', bad);
  }
  assert.equal(adapters.buildRequest('google-sheets', 'get_values', { spreadsheet_id: '1Bxi' }, JSON.stringify(blob)).reason, 'param_missing');
  const [a] = adapters.listActions('google-sheets');
  assert.equal(a.kind, 'read_only');
  assert.equal(a.scope, 'spreadsheets.read');
});

// ---- batch 12 (27 Nov 2026): Microsoft Excel + Word readonly reads (Graph) ----

test('microsoft-excel consents to exactly Files.Read and reads a validated workbook range', () => {
  assert.equal(adapters.get('microsoft-excel').oauth.scope, 'Files.Read offline_access');
  const au = adapters.authorizeUrl('microsoft-excel', { client_id: 'cid', redirect_uri: 'https://app.example/cb' }, 'st');
  assert.equal(au.ok, true);
  assert.ok(au.url.indexOf('scope=' + encodeURIComponent('Files.Read offline_access')) !== -1, 'the consent URL names only Files.Read');
  assert.equal(au.url.indexOf('login.microsoftonline.com/common/oauth2/v2.0/authorize') !== -1, true, 'pinned authorize host');
  const tk = adapters.tokenRequest('microsoft-excel', { client_id: 'cid', client_secret: 'cs', redirect_uri: 'https://app.example/cb' }, 'code1');
  assert.equal(tk.request.url, 'https://login.microsoftonline.com/common/oauth2/v2.0/token');
  const blob = { client_id: 'cid', access_token: 'at-1', refresh_token: 'rt-1', expires_at: 3600000 };
  const s = adapters.buildRequest('microsoft-excel', 'get_workbook_range', { workbook_item_id: '01ABCD2F!123', worksheet: 'Sheet 1', range: 'A1:C10' }, JSON.stringify(blob));
  assert.equal(s.ok, true);
  assert.equal(s.request.method, 'GET');
  assert.equal(s.request.url, 'https://graph.microsoft.com/v1.0/me/drive/items/01ABCD2F!123/workbook/worksheets/' + encodeURIComponent('Sheet 1') + "/range(address='" + encodeURIComponent('A1:C10') + "')");
  assert.equal(s.request.headers.Authorization, 'Bearer at-1');
  assert.equal(s.request.urlContainsSecret, false);
  for (const bad of ['../etc/passwd', 'id/x', 'id?q=1', 'id q']) {
    assert.equal(adapters.buildRequest('microsoft-excel', 'get_workbook_range', { workbook_item_id: bad, worksheet: 'Sheet1', range: 'A1' }, JSON.stringify(blob)).reason, 'param_invalid', bad);
  }
  for (const bad of ['Sheet;1', 'Sheet/1', 'Sheet?1', '../Sheet1']) {
    assert.equal(adapters.buildRequest('microsoft-excel', 'get_workbook_range', { workbook_item_id: 'id1', worksheet: bad, range: 'A1' }, JSON.stringify(blob)).reason, 'param_invalid', bad);
  }
  for (const bad of ['A1;DROP', 'A1?x', '../A1', 'a\nb']) {
    assert.equal(adapters.buildRequest('microsoft-excel', 'get_workbook_range', { workbook_item_id: 'id1', worksheet: 'Sheet1', range: bad }, JSON.stringify(blob)).reason, 'param_invalid', bad);
  }
  assert.equal(adapters.buildRequest('microsoft-excel', 'get_workbook_range', { workbook_item_id: 'id1' }, JSON.stringify(blob)).reason, 'param_missing');
  assert.equal(adapters.validateOnly('microsoft-excel', 'get_workbook_range', { workbook_item_id: 'id1', worksheet: 'S', range: 'A1' }), null, 'validateOnly needs no credential');
  const [a] = adapters.listActions('microsoft-excel');
  assert.equal(a.kind, 'read_only');
  assert.equal(a.scope, 'workbook.read');
});

test('microsoft-word consents to exactly Files.Read and reads document metadata', () => {
  assert.equal(adapters.get('microsoft-word').oauth.scope, 'Files.Read offline_access');
  const au = adapters.authorizeUrl('microsoft-word', { client_id: 'cid', redirect_uri: 'https://app.example/cb' }, 'st');
  assert.ok(au.url.indexOf('scope=' + encodeURIComponent('Files.Read offline_access')) !== -1);
  const blob = { client_id: 'cid', access_token: 'at-1', refresh_token: 'rt-1', expires_at: 3600000 };
  const s = adapters.buildRequest('microsoft-word', 'get_document_properties', { item_id: '01WORD9Z!456' }, JSON.stringify(blob));
  assert.equal(s.ok, true);
  assert.equal(s.request.method, 'GET');
  assert.equal(s.request.url, 'https://graph.microsoft.com/v1.0/me/drive/items/01WORD9Z!456?select=id,name,size,lastModifiedDateTime,webUrl');
  assert.equal(s.request.headers.Authorization, 'Bearer at-1');
  assert.equal(s.request.urlContainsSecret, false);
  for (const bad of ['../x', 'id/y', 'id;q=1', 'id z']) {
    assert.equal(adapters.buildRequest('microsoft-word', 'get_document_properties', { item_id: bad }, JSON.stringify(blob)).reason, 'param_invalid', bad);
  }
  assert.equal(adapters.buildRequest('microsoft-word', 'get_document_properties', {}, JSON.stringify(blob)).reason, 'param_missing');
  assert.equal(adapters.validateOnly('microsoft-word', 'get_document_properties', { item_id: 'x' }), null, 'validateOnly needs no credential');
  const [a] = adapters.listActions('microsoft-word');
  assert.equal(a.kind, 'read_only');
  assert.equal(a.scope, 'documents.read');
});

// ---- batch 13 (27 Nov 2026): Microsoft Teams readonly chat reads (Graph) ----

test('microsoft-teams consents to exactly Chat.Read and builds validated chat reads', () => {
  assert.equal(adapters.get('microsoft-teams').oauth.scope, 'Chat.Read offline_access');
  const au = adapters.authorizeUrl('microsoft-teams', { client_id: 'cid', redirect_uri: 'https://app.example/cb' }, 'st');
  assert.ok(au.url.indexOf('scope=' + encodeURIComponent('Chat.Read offline_access')) !== -1, 'the consent URL names only Chat.Read');
  assert.equal(au.url.indexOf('login.microsoftonline.com/common/oauth2/v2.0/authorize') !== -1, true, 'pinned authorize host');
  const tk = adapters.tokenRequest('microsoft-teams', { client_id: 'cid', client_secret: 'cs', redirect_uri: 'https://app.example/cb' }, 'code1');
  assert.equal(tk.request.url, 'https://login.microsoftonline.com/common/oauth2/v2.0/token');
  const blob = { client_id: 'cid', access_token: 'at-1', refresh_token: 'rt-1', expires_at: 3600000 };
  const lc = adapters.buildRequest('microsoft-teams', 'list_chats', {}, JSON.stringify(blob));
  assert.equal(lc.ok, true);
  assert.equal(lc.request.method, 'GET');
  assert.equal(lc.request.url, 'https://graph.microsoft.com/v1.0/chats?$top=20');
  assert.equal(lc.request.headers.Authorization, 'Bearer at-1');
  assert.equal(lc.request.urlContainsSecret, false);
  const gm = adapters.buildRequest('microsoft-teams', 'get_chat_messages', { chat_id: '19:abcXYZ@thread.v2' }, JSON.stringify(blob));
  assert.equal(gm.ok, true);
  assert.equal(gm.request.method, 'GET');
  assert.equal(gm.request.url, 'https://graph.microsoft.com/v1.0/chats/' + encodeURIComponent('19:abcXYZ@thread.v2') + '/messages?$top=20');
  assert.equal(gm.request.headers.Authorization, 'Bearer at-1');
  for (const bad of ['../x', 'id/x', 'id?q=1', 'id q']) {
    assert.equal(adapters.buildRequest('microsoft-teams', 'get_chat_messages', { chat_id: bad }, JSON.stringify(blob)).reason, 'param_invalid', bad);
  }
  assert.equal(adapters.buildRequest('microsoft-teams', 'get_chat_messages', {}, JSON.stringify(blob)).reason, 'param_missing');
  assert.equal(adapters.validateOnly('microsoft-teams', 'list_chats', {}), null, 'validateOnly needs no credential');
  assert.equal(adapters.validateOnly('microsoft-teams', 'get_chat_messages', { chat_id: 'x' }), null, 'validateOnly needs no credential');
  for (const a of adapters.listActions('microsoft-teams')) {
    assert.equal(a.kind, 'read_only');
    assert.equal(a.scope, 'chat.read');
  }
});

// ---- batch 14 (27 Nov 2026): GitLab readonly adapter on gitlab.com (vault token) ----

test('gitlab adapter pins the host, validates identifiers, and builds three readonly reads', () => {
  assert.equal(adapters.get('gitlab').authShape, 'token');
  assert.ok(adapters.get('gitlab').setupNote.indexOf('app vault') !== -1, 'the setup note says the token lives only in the app vault');
  const s = adapters.buildRequest('gitlab', 'search_projects', { query: 'qiskit optimisation' }, 'gl-tok');
  assert.equal(s.ok, true);
  assert.equal(s.request.method, 'GET');
  assert.equal(s.request.url, 'https://gitlab.com/api/v4/projects?search=' + encodeURIComponent('qiskit optimisation') + '&per_page=20');
  assert.equal(s.request.headers.Authorization, 'Bearer gl-tok');
  assert.equal(s.request.urlContainsSecret, false);
  for (const bad of ['a;b', 'a/b', 'q?', 'a\nb', 'q=x']) {
    assert.equal(adapters.buildRequest('gitlab', 'search_projects', { query: bad }, 'gl-tok').reason, 'param_invalid', bad);
  }
  assert.equal(adapters.buildRequest('gitlab', 'search_projects', {}, 'gl-tok').reason, 'param_missing');
  const g = adapters.buildRequest('gitlab', 'get_project', { project: 'group/project' }, 'gl-tok');
  assert.equal(g.ok, true);
  assert.equal(g.request.url, 'https://gitlab.com/api/v4/projects/' + encodeURIComponent('group/project'));
  const c = adapters.buildRequest('gitlab', 'list_recent_commits', { project: '123' }, 'gl-tok');
  assert.equal(c.ok, true);
  assert.equal(c.request.url, 'https://gitlab.com/api/v4/projects/123/repository/commits?per_page=20');
  for (const bad of ['../x', 'a..b', 'a b', 'id?q=1']) {
    assert.equal(adapters.buildRequest('gitlab', 'get_project', { project: bad }, 'gl-tok').reason, 'param_invalid', bad);
    assert.equal(adapters.buildRequest('gitlab', 'list_recent_commits', { project: bad }, 'gl-tok').reason, 'param_invalid', bad);
  }
  assert.equal(adapters.buildRequest('gitlab', 'get_project', {}, 'gl-tok').reason, 'param_missing');
  assert.equal(adapters.validateOnly('gitlab', 'search_projects', { query: 'q' }), null, 'validateOnly needs no credential');
  assert.equal(adapters.validateOnly('gitlab', 'get_project', { project: 'x' }), null, 'validateOnly needs no credential');
  for (const a of adapters.listActions('gitlab')) {
    assert.equal(a.kind, 'read_only');
    assert.equal(a.scope, 'read_api');
  }
});

// ---- batch 15 (27 Nov 2026): Jira Cloud readonly adapter (vault JSON + tenant host validation) ----

test('jira validates tenant hosts strictly and builds basic-auth reads on the tenant host', () => {
  assert.equal(adapters.get('jira').authShape, 'token');
  assert.ok(adapters.get('jira').setupNote.indexOf('app vault') !== -1, 'the setup note says the secrets live only in the app vault');
  const ok = ['https://example.atlassian.net', 'https://my-site.atlassian.net', 'https://EXAMPLE.Atlassian.NET'];
  for (const h of ok) assert.equal(adapters.get('jira').hostValid(h), true, h);
  const bad = ['http://example.atlassian.net', 'https://example.atlassian.net:8443', 'https://example.atlassian.net.evil.com', 'https://evil.com', 'https://user:pass@example.atlassian.net', 'https://example.atlassian.net/path', 'https://example.atlassian.net?q=1', 'https://example.atlassian.net#f', 'example.atlassian.net', 'https://a.b.atlassian.net', 'https://example.atlassian.com'];
  for (const h of bad) assert.equal(adapters.get('jira').hostValid(h), false, h);
  const cred = JSON.stringify({ host: 'https://example.atlassian.net', email: 'user@example.com', token: 'at3t-token-1234567890' });
  const expectedBasic = 'Basic ' + Buffer.from('user@example.com:at3t-token-1234567890').toString('base64');
  const gi = adapters.buildRequest('jira', 'get_issue', { issue_key: 'PROJ-42' }, cred);
  assert.equal(gi.ok, true);
  assert.equal(gi.request.method, 'GET');
  assert.equal(gi.request.url, 'https://example.atlassian.net/rest/api/3/issue/PROJ-42?fields=summary,status,issuetype,assignee,created,updated');
  assert.equal(gi.request.headers.Authorization, expectedBasic);
  assert.equal(gi.request.urlContainsSecret, false);
  assert.ok(gi.request.url.indexOf('at3t-token') === -1, 'the token never rides the URL');
  const si = adapters.buildRequest('jira', 'search_issues', { jql: 'project = DEMO AND status = "In Progress"' }, cred);
  assert.equal(si.ok, true);
  assert.equal(si.request.url, 'https://example.atlassian.net/rest/api/3/search?jql=' + encodeURIComponent('project = DEMO AND status = "In Progress"') + '&maxResults=20');
  for (const payload of ['not json', '{}', JSON.stringify({ host: 'https://evil.com', email: 'user@example.com', token: 'at3t-token-1234567890' }), JSON.stringify({ host: 'https://example.atlassian.net', email: 'nope', token: 'at3t-token-1234567890' }), JSON.stringify({ host: 'https://example.atlassian.net', email: 'user@example.com', token: 'short' })]) {
    assert.equal(adapters.buildRequest('jira', 'get_issue', { issue_key: 'PROJ-42' }, payload).reason, 'credential_invalid', payload);
    assert.equal(adapters.buildRequest('jira', 'search_issues', { jql: 'x' }, payload).reason, 'credential_invalid', payload);
  }
  for (const badKey of ['../x', 'a b', 'KEY!1', 'PROJ-']) {
    assert.equal(adapters.buildRequest('jira', 'get_issue', { issue_key: badKey }, cred).reason, 'param_invalid', badKey);
  }
  assert.equal(adapters.buildRequest('jira', 'get_issue', {}, cred).reason, 'param_missing');
  assert.equal(adapters.buildRequest('jira', 'search_issues', { jql: 'a\nb' }, cred).reason, 'param_invalid', 'control char in jql');
  assert.equal(adapters.buildRequest('jira', 'search_issues', {}, cred).reason, 'param_missing');
  assert.equal(adapters.validateOnly('jira', 'get_issue', { issue_key: 'A-1' }), null, 'validateOnly needs no credential');
  assert.equal(adapters.validateOnly('jira', 'search_issues', { jql: 'x' }), null, 'validateOnly needs no credential');
  for (const a of adapters.listActions('jira')) {
    assert.equal(a.kind, 'read_only');
    assert.equal(a.scope, 'issues.read');
  }
});

// ---- batch 16 (27 Nov 2026): MusicBrainz keyless public read-only adapter ----

test('musicbrainz builds pinned-host keyless reads and validates params', () => {
  assert.equal(adapters.get('musicbrainz').authShape, 'public');
  assert.ok(adapters.get('musicbrainz').setupNote.indexOf('no account or key needed') !== -1, 'the setup note is honest about keyless access');
  const sa = adapters.buildRequest('musicbrainz', 'search_artists', { query: 'radiohead' });
  assert.equal(sa.ok, true);
  assert.equal(sa.request.method, 'GET');
  assert.equal(sa.request.url, 'https://musicbrainz.org/ws/2/artist?query=radiohead&fmt=json&limit=20');
  assert.equal(sa.request.headers['User-Agent'], 'CompanionDesk');
  assert.equal(sa.request.urlContainsSecret, false);
  const sr = adapters.buildRequest('musicbrainz', 'search_recordings', { query: 'creep', limit: '25' });
  assert.equal(sr.ok, true);
  assert.equal(sr.request.url, 'https://musicbrainz.org/ws/2/recording?query=creep&fmt=json&limit=25');
  assert.equal(adapters.buildRequest('musicbrainz', 'search_artists', { query: 'a', limit: '26' }).reason, 'param_invalid', 'limit above the cap');
  assert.equal(adapters.buildRequest('musicbrainz', 'search_artists', { query: 'a', limit: '0' }).reason, 'param_invalid', 'limit below 1');
  assert.equal(adapters.buildRequest('musicbrainz', 'search_artists', { query: 'a\nb' }).reason, 'param_invalid', 'control char in query');
  const ga = adapters.buildRequest('musicbrainz', 'get_artist', { mbid: 'a74b1b7f-71a5-4011-9441-d0b5e67127c0' });
  assert.equal(ga.ok, true);
  assert.equal(ga.request.url, 'https://musicbrainz.org/ws/2/artist/a74b1b7f-71a5-4011-9441-d0b5e67127c0?fmt=json');
  assert.equal(adapters.buildRequest('musicbrainz', 'get_artist', { mbid: 'not-a-uuid' }).reason, 'param_invalid');
  assert.equal(adapters.buildRequest('musicbrainz', 'get_artist', {}).reason, 'param_missing');
  assert.equal(adapters.validateOnly('musicbrainz', 'search_artists', { query: 'x' }), null, 'validateOnly needs no credential');
  assert.equal(adapters.validateOnly('musicbrainz', 'get_artist', { mbid: 'a74b1b7f-71a5-4011-9441-d0b5e67127c0' }), null, 'validateOnly needs no credential');
  for (const a of adapters.listActions('musicbrainz')) {
    assert.equal(a.kind, 'read_only');
    assert.equal(a.scope, 'recordings.read');
  }
});

// ---- batch 17 (27 Nov 2026): PyPI keyless public read-only adapter ----

test('pypi builds pinned-host keyless package reads and validates params', () => {
  assert.equal(adapters.get('pypi').authShape, 'public');
  assert.ok(adapters.get('pypi').setupNote.indexOf('keyless') !== -1, 'the setup note is honest about keyless reads');
  const gp = adapters.buildRequest('pypi', 'get_package', { package: 'qiskit' });
  assert.equal(gp.ok, true);
  assert.equal(gp.request.method, 'GET');
  assert.equal(gp.request.url, 'https://pypi.org/pypi/qiskit/json');
  assert.equal(gp.request.headers['User-Agent'], 'CompanionDesk');
  assert.equal(gp.request.urlContainsSecret, false);
  const gr = adapters.buildRequest('pypi', 'get_release', { package: 'numpy', version: '1.26.0' });
  assert.equal(gr.ok, true);
  assert.equal(gr.request.url, 'https://pypi.org/pypi/numpy/1.26.0/json');
  assert.equal(adapters.buildRequest('pypi', 'get_package', { package: '-bad-' }).reason, 'param_invalid', 'leading hyphen is not a package name');
  assert.equal(adapters.buildRequest('pypi', 'get_package', { package: 'a/b' }).reason, 'param_invalid', 'path traversal in package name');
  assert.equal(adapters.buildRequest('pypi', 'get_package', {}).reason, 'param_missing');
  assert.equal(adapters.buildRequest('pypi', 'get_release', { package: 'numpy', version: '1..x/y' }).reason, 'param_invalid', 'path traversal in version');
  assert.equal(adapters.buildRequest('pypi', 'get_release', { package: 'numpy' }).reason, 'param_missing');
  assert.equal(adapters.validateOnly('pypi', 'get_package', { package: 'x' }), null, 'validateOnly needs no credential');
  for (const a of adapters.listActions('pypi')) {
    assert.equal(a.kind, 'read_only');
    assert.equal(a.scope, 'packages.read');
  }
});

// ---- batch 18 (27 Nov 2026): Internet Archive keyless public read-only adapter ----

test('internet-archive builds pinned-host keyless item reads and validates params', () => {
  assert.equal(adapters.get('internet-archive').authShape, 'public');
  assert.ok(adapters.get('internet-archive').setupNote.indexOf('keyless') !== -1, 'the setup note is honest about keyless reads');
  const si = adapters.buildRequest('internet-archive', 'search_items', { query: 'collection:nasa' });
  assert.equal(si.ok, true);
  assert.equal(si.request.method, 'GET');
  assert.equal(si.request.url, 'https://archive.org/advancedsearch.php?q=collection%3Anasa&fl%5B%5D=identifier&fl%5B%5D=title&fl%5B%5D=mediatype&rows=20&output=json&page=1');
  assert.equal(si.request.headers['User-Agent'], 'CompanionDesk');
  assert.equal(si.request.urlContainsSecret, false);
  const capped = adapters.buildRequest('internet-archive', 'search_items', { query: 'x', limit: '50' });
  assert.equal(capped.ok, true);
  assert.equal(capped.request.url, 'https://archive.org/advancedsearch.php?q=x&fl%5B%5D=identifier&fl%5B%5D=title&fl%5B%5D=mediatype&rows=50&output=json&page=1');
  assert.equal(adapters.buildRequest('internet-archive', 'search_items', { query: 'x', limit: '51' }).reason, 'param_invalid', 'limit above the cap');
  assert.equal(adapters.buildRequest('internet-archive', 'search_items', { query: 'a\nb' }).reason, 'param_invalid', 'control char in query');
  const gm = adapters.buildRequest('internet-archive', 'get_metadata', { identifier: 'nasa_apollo' });
  assert.equal(gm.ok, true);
  assert.equal(gm.request.url, 'https://archive.org/metadata/nasa_apollo');
  assert.equal(adapters.buildRequest('internet-archive', 'get_metadata', { identifier: 'a/b' }).reason, 'param_invalid', 'path traversal in identifier');
  assert.equal(adapters.buildRequest('internet-archive', 'get_metadata', {}).reason, 'param_missing');
  assert.equal(adapters.validateOnly('internet-archive', 'search_items', { query: 'x' }), null, 'validateOnly needs no credential');
  for (const a of adapters.listActions('internet-archive')) {
    assert.equal(a.kind, 'read_only');
    assert.equal(a.scope, 'metadata.read');
  }
});

// ---- batch 19 (27 Nov 2026): Docker Hub keyless public read-only adapter ----

test('docker-hub builds pinned-host keyless repository reads and validates params', () => {
  assert.equal(adapters.get('docker-hub').authShape, 'public');
  assert.ok(adapters.get('docker-hub').setupNote.indexOf('keyless') !== -1, 'the setup note is honest about keyless public reads');
  const sr = adapters.buildRequest('docker-hub', 'search_repositories', { query: 'alpine' });
  assert.equal(sr.ok, true);
  assert.equal(sr.request.method, 'GET');
  assert.equal(sr.request.url, 'https://hub.docker.com/v2/search/repositories/?query=alpine&page_size=20');
  assert.equal(sr.request.headers['User-Agent'], 'CompanionDesk');
  assert.equal(sr.request.urlContainsSecret, false);
  const capped = adapters.buildRequest('docker-hub', 'search_repositories', { query: 'x', limit: '25' });
  assert.equal(capped.ok, true);
  assert.equal(capped.request.url, 'https://hub.docker.com/v2/search/repositories/?query=x&page_size=25');
  assert.equal(adapters.buildRequest('docker-hub', 'search_repositories', { query: 'x', limit: '26' }).reason, 'param_invalid', 'limit above the cap');
  assert.equal(adapters.buildRequest('docker-hub', 'search_repositories', { query: 'a\nb' }).reason, 'param_invalid', 'control char in query');
  const gr = adapters.buildRequest('docker-hub', 'get_repository', { namespace: 'library', repository: 'nginx' });
  assert.equal(gr.ok, true);
  assert.equal(gr.request.url, 'https://hub.docker.com/v2/repositories/library/nginx/');
  const gt = adapters.buildRequest('docker-hub', 'get_tags', { namespace: 'library', repository: 'nginx' });
  assert.equal(gt.ok, true);
  assert.equal(gt.request.url, 'https://hub.docker.com/v2/repositories/library/nginx/tags?page_size=20');
  assert.equal(adapters.buildRequest('docker-hub', 'get_repository', { namespace: 'a/b', repository: 'nginx' }).reason, 'param_invalid', 'path traversal in namespace');
  assert.equal(adapters.buildRequest('docker-hub', 'get_tags', { namespace: 'library', repository: 'NGINX!' }).reason, 'param_invalid', 'invalid repository name');
  assert.equal(adapters.buildRequest('docker-hub', 'get_repository', { namespace: 'library' }).reason, 'param_missing');
  assert.equal(adapters.validateOnly('docker-hub', 'get_tags', { namespace: 'l', repository: 'n' }), null, 'validateOnly needs no credential');
  for (const a of adapters.listActions('docker-hub')) {
    assert.equal(a.kind, 'read_only');
    assert.equal(a.scope, 'images.read');
  }
});

// ---- batch 20 (27 Nov 2026): npm keyless public read-only adapter ----

test('npm builds pinned-host keyless registry reads and validates params', () => {
  assert.equal(adapters.get('npm').authShape, 'public');
  assert.ok(adapters.get('npm').setupNote.indexOf('keyless') !== -1, 'the setup note is honest about keyless public reads');
  const gp = adapters.buildRequest('npm', 'get_package', { package: 'qiskit' });
  assert.equal(gp.ok, true);
  assert.equal(gp.request.method, 'GET');
  assert.equal(gp.request.url, 'https://registry.npmjs.org/qiskit');
  assert.equal(gp.request.headers['User-Agent'], 'CompanionDesk');
  assert.equal(gp.request.urlContainsSecret, false);
  const scoped = adapters.buildRequest('npm', 'get_package', { package: '@angular/core' });
  assert.equal(scoped.ok, true);
  assert.equal(scoped.request.url, 'https://registry.npmjs.org/@angular%2Fcore');
  const sp = adapters.buildRequest('npm', 'search_packages', { query: 'quantum', limit: '25' });
  assert.equal(sp.ok, true);
  assert.equal(sp.request.url, 'https://registry.npmjs.org/-/v1/search?text=quantum&size=25');
  assert.equal(adapters.buildRequest('npm', 'search_packages', { query: 'x', limit: '26' }).reason, 'param_invalid', 'limit above the cap');
  assert.equal(adapters.buildRequest('npm', 'search_packages', { query: 'a\nb' }).reason, 'param_invalid', 'control char in query');
  assert.equal(adapters.buildRequest('npm', 'get_package', { package: 'a/b' }).reason, 'param_invalid', 'unscoped name with a slash is not valid');
  assert.equal(adapters.buildRequest('npm', 'get_package', { package: 'A' }).reason, 'param_invalid', 'npm names are lowercase');
  assert.equal(adapters.buildRequest('npm', 'get_package', {}).reason, 'param_missing');
  assert.equal(adapters.validateOnly('npm', 'search_packages', { query: 'x' }), null, 'validateOnly needs no credential');
  for (const a of adapters.listActions('npm')) {
    assert.equal(a.kind, 'read_only');
    assert.equal(a.scope, 'packages.read');
  }
});
