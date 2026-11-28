'use strict';

// M8 slice (28 Nov 2026, standing authorization): the keyless public RSS
// feed read. The catalog's last remaining keyless definition-only entry
// gets a real read-only adapter. The feed URL is a user-supplied
// parameter, not a pinned host, so the request builder carries a strict
// guard: https only, a public hostname (at least one dot, never localhost
// or an IP literal), no userinfo, no explicit port. These tests assert
// request building and validation only; nothing here connects a service,
// touches a credential or performs an external action, and execution
// still sits behind the full gate chain (connect with feed.read granted,
// then the consent chain).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const adapters = require('../src/connector-adapters.js');
const { createConnectorCatalog } = require('../src/connectors.js');

test('the rss adapter exists with one read-only keyless action', () => {
  const a = adapters.get('rss');
  assert.ok(a, 'rss adapter exists');
  assert.equal(a.authShape, 'public');
  const actions = adapters.listActions('rss');
  assert.ok(Array.isArray(actions) && actions.length === 1, 'exactly one action');
  assert.equal(actions[0].id, 'read_feed');
  assert.equal(actions[0].kind, 'read_only');
  assert.equal(actions[0].scope, 'feed.read');
});

test('a well-formed public https feed url builds a GET request', () => {
  const r = adapters.buildRequest('rss', 'read_feed', { url: 'https://example.com/feed.xml' });
  assert.equal(r.ok, true);
  assert.equal(r.request.method, 'GET');
  assert.equal(r.request.url, 'https://example.com/feed.xml');
  assert.match(r.request.headers['User-Agent'], /CompanionDesk/);
  assert.equal(r.request.body, null);
  assert.equal(r.request.urlContainsSecret, false, 'no credential ever rides an rss request');
});

test('the url guard refuses every private or unsafe shape', () => {
  const bad = [
    'http://example.com/feed.xml',
    'https://user:pass@example.com/feed',
    'https://localhost/feed',
    'https://127.0.0.1/feed',
    'https://192.168.1.10/feed',
    'https://[::1]/feed',
    'https://intranet/feed',
    'https://example.com:8443/feed',
    'https://example.com/' + 'a'.repeat(600),
    'not a url at all',
  ];
  for (const url of bad) {
    const r = adapters.buildRequest('rss', 'read_feed', { url });
    assert.equal(r.ok, false, JSON.stringify(url) + ' must be refused');
    assert.equal(r.reason, 'param_invalid', JSON.stringify(url));
  }
});

test('param validation and refusal ordering stay honest', () => {
  assert.equal(adapters.validateOnly('rss', 'read_feed', {}), 'param_missing');
  assert.equal(adapters.validateOnly('rss', 'read_feed', { url: 'https://example.com/f' }), null);
  const missing = adapters.buildRequest('rss', 'read_feed', {});
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'param_missing');
});

test('the catalog row is implemented and keyless', () => {
  const c = createConnectorCatalog({ clock: () => 1700000000000 });
  const row = c.describe('rss');
  assert.equal(row.integrationImplemented, true);
  assert.equal(row.auth, 'none');
  assert.match(row.readinessNote, /no key or account needed/);
});

test('the catalog doc no longer classifies rss as definition-only', () => {
  const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'CONNECTOR_CATALOG.md'), 'utf8');
  assert.ok(doc.includes('`rss` | RSS feeds'), 'the catalog table row stays');
  assert.ok(!/\| `rss` \| none \| local \|/.test(doc), 'the audit reason table must drop the rss row');
});
