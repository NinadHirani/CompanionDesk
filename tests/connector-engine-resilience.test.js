'use strict';

// M8 batch 59 (28 Nov 2026, standing authorization): connector-engine
// resilience. The action engine's contract everywhere else is a
// structured, fail-closed result: every gate refuses with { ok: false,
// reason }. But run() had no outer exception boundary, so a throwing
// injected dependency - a vault hiccup in the credential reader, a
// malformed adapter's validateOnly, an adapter whose refreshRequest
// throws - escaped run() as an unhandled rejection instead of a
// refusal. In the wired main process that turns one connector's bad
// day into a crashed IPC handler. Test-only until it fails: no
// network, no credentials, nothing external.

const { test } = require('node:test');
const assert = require('node:assert');
const { createConnectorCatalog } = require('../src/connectors.js');
const adapters = require('../src/connector-adapters.js');
const { createActionEngine } = require('../src/connector-actions.js');

function connectedEngine(overrides) {
  const catalog = createConnectorCatalog({ clock: () => 0 });
  catalog.connect('slack', { userInitiated: true, scopes: ['channels.read'], credentialRef: 'vault:slack-cred' });
  const engine = createActionEngine(Object.assign({
    catalog: catalog,
    adapters: adapters,
    transport: async () => ({ status: 200, body: '{}' }),
    credentialReader: () => 'xoxb-tok',
  }, overrides || {}));
  return { catalog, engine };
}

test('a throwing credential reader refuses as a structured result', async () => {
  const { engine } = connectedEngine({
    credentialReader: () => { throw new Error('vault hiccup'); },
  });
  const r = await engine.run('slack', 'auth_test', {});
  assert.equal(r.ok, false, 'run() must resolve, never reject');
  assert.equal(r.reason, 'engine_error');
});

test('a throwing adapter validation refuses as a structured result', async () => {
  const fakeAdapters = {
    get: () => ({ id: 'slack', authShape: 'token' }),
    listActions: () => [{ id: 'auth_test', scope: 'channels.read', kind: 'read' }],
    validateOnly: () => { throw new Error('adapter bug'); },
  };
  const { engine } = connectedEngine({ adapters: fakeAdapters });
  const r = await engine.run('slack', 'auth_test', {});
  assert.equal(r.ok, false, 'run() must resolve, never reject');
  assert.equal(r.reason, 'engine_error');
});

test('a throwing refreshRequest refuses as a structured result', async () => {
  const fakeAdapters = {
    get: () => ({ id: 'x', authShape: 'oauth_json' }),
    listActions: () => [{ id: 'a1', scope: 'channels.read', kind: 'read' }],
    refreshRequest: () => { throw new Error('adapter bug'); },
    buildRequest: () => ({ ok: true, request: { method: 'GET', url: 'https://example.invalid/x' } }),
  };
  const { engine } = connectedEngine({
    adapters: fakeAdapters,
    credentialReader: () => JSON.stringify({
      client_id: 'c', client_secret: 's', access_token: 'at',
      refresh_token: 'rt', expires_at: 0, // long expired: the pre-action refresh path runs
    }),
  });
  const r = await engine.run('slack', 'a1', {});
  assert.equal(r.ok, false, 'run() must resolve, never reject');
  assert.equal(r.reason, 'engine_error');
});
