'use strict';

// M8 slice (28 Nov 2026, standing authorization): the two remaining keyless,
// credential-free, account-free catalog rows - the local model servers
// (ollama, lm-studio) - get real read-only adapters. These are local-first
// and free: the action points at a server on the user's own machine
// (default loopback URL, user-overridable), lists the models installed
// there, and performs no send, write or external action. The URL guard
// allows loopback http only and must never reach a remote host, so the
// shared builder keeps its https-only rule for every non-local adapter.
// These tests assert request building and validation only; nothing here
// connects a service, touches a credential or performs an external action,
// and execution still sits behind the full gate chain (connect with
// model.read granted, then the consent chain).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const adapters = require('../src/connector-adapters.js');
const { createConnectorCatalog } = require('../src/connectors.js');

test('the local adapters exist with their read-only keyless actions (read + infer)', () => {
  const infer = { ollama: 'generate', 'lm-studio': 'chat' };
  for (const id of ['ollama', 'lm-studio']) {
    const a = adapters.get(id);
    assert.ok(a, id + ' adapter exists');
    assert.equal(a.authShape, 'local');
    const actions = adapters.listActions(id);
    assert.ok(Array.isArray(actions) && actions.length === 2, id + ': read + infer actions');
    assert.equal(actions[0].id, 'list_models');
    assert.equal(actions[0].kind, 'read_only');
    assert.equal(actions[0].scope, 'model.read');
    assert.equal(actions[1].id, infer[id]);
    assert.equal(actions[1].kind, 'read_only');
    assert.equal(actions[1].scope, 'model.infer');
  }
});

test('the default loopback instance builds the right GET request', () => {
  const r = adapters.buildRequest('ollama', 'list_models', {});
  assert.equal(r.ok, true);
  assert.equal(r.request.method, 'GET');
  assert.equal(r.request.url, 'http://127.0.0.1:11434/api/tags');
  assert.match(r.request.headers['User-Agent'], /CompanionDesk/);
  assert.equal(r.request.body, null);
  assert.equal(r.request.urlContainsSecret, false, 'no credential ever rides a local request');

  const l = adapters.buildRequest('lm-studio', 'list_models', {});
  assert.equal(l.ok, true);
  assert.equal(l.request.url, 'http://127.0.0.1:1234/v1/models');
  assert.equal(l.request.urlContainsSecret, false);
});

test('a custom loopback instance url is normalized and honoured', () => {
  const r = adapters.buildRequest('ollama', 'list_models', { instanceUrl: 'http://localhost:5000/' });
  assert.equal(r.ok, true);
  assert.equal(r.request.url, 'http://localhost:5000/api/tags');

  const v6 = adapters.buildRequest('lm-studio', 'list_models', { instanceUrl: 'http://[::1]:1234' });
  assert.equal(v6.ok, true);
  assert.equal(v6.request.url, 'http://[::1]:1234/v1/models');
});

test('the local url guard refuses every non-loopback or unsafe shape', () => {
  const bad = [
    'https://example.com',
    'http://example.com:11434',
    'http://192.168.1.10:11434',
    'http://127.0.0.1@evil.com',
    'http://user@127.0.0.1:11434',
    'http://127.0.0.1.evil.com:11434',
    'ftp://127.0.0.1:11434',
    'http://127.0.0.1/api/tags?x=1',
    'http://127.0.0.1:11434/../../etc',
    'http://' + 'a'.repeat(300),
    'not a url at all',
  ];
  for (const url of bad) {
    const r = adapters.buildRequest('ollama', 'list_models', { instanceUrl: url });
    assert.equal(r.ok, false, JSON.stringify(url) + ' must be refused');
    assert.equal(r.reason, 'param_invalid', JSON.stringify(url));
  }
});

test('the shared builder keeps https-only for every non-local adapter', () => {
  const r = adapters.buildRequest('rss', 'read_feed', { url: 'http://127.0.0.1:11434' });
  assert.equal(r.ok, false, 'a local-looking url must stay refused for public adapters');
  assert.equal(r.reason, 'param_invalid');
});

test('param validation and refusal ordering stay honest', () => {
  assert.equal(adapters.validateOnly('ollama', 'list_models', {}), null);
  assert.equal(adapters.validateOnly('ollama', 'nope', {}), 'unknown_action');
  const tooLong = adapters.buildRequest('lm-studio', 'list_models', { instanceUrl: 'http://127.0.0.1:' + '1'.repeat(300) });
  assert.equal(tooLong.ok, false);
});

test('the catalog rows are implemented and keyless', () => {
  const c = createConnectorCatalog({ clock: () => 1700000000000 });
  for (const id of ['ollama', 'lm-studio']) {
    const row = c.describe(id);
    assert.equal(row.integrationImplemented, true);
    assert.equal(row.auth, 'local');
    assert.match(row.readinessNote, /local/);
  }
});

test('the catalog doc no longer classifies the local rows as definition-only', () => {
  const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'CONNECTOR_CATALOG.md'), 'utf8');
  assert.ok(!/\| `ollama` \| local \| local \|/.test(doc), 'the audit reason table must drop the ollama row');
  assert.ok(!/\| `lm-studio` \| local \| local \|/.test(doc), 'the audit reason table must drop the lm-studio row');
});
