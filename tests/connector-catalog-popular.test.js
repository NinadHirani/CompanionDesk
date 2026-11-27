'use strict';
// Curated popular-provider tier (27 Nov 2026, Ninad's clarification): the
// built-in catalog must visibly offer the mainstream services people expect,
// not only self-hosted ones. Every popular entry is metadata only - real
// cost, limits, auth shape and exact scopes - honestly marked
// integration not implemented, refused at authorizeCall even when
// connected, and discoverable through the same list/describe surface the AI
// already uses. Nothing connects or activates by itself.

const { test } = require('node:test');
const assert = require('node:assert');
const { createConnectorCatalog } = require('../src/connectors.js');

const POPULAR = ['slack', 'discord', 'notion', 'dropbox', 'google-drive', 'gmail', 'google-calendar', 'microsoft-onedrive', 'microsoft-outlook', 'telegram', 'youtube', 'spotify', 'zoom'];

test('the curated popular providers are all listed with honest metadata', () => {
  const c = createConnectorCatalog({});
  const all = c.list();
  for (const id of POPULAR) {
    const e = all.find((x) => x.id === id);
    assert.ok(e, id + ' is listed');
    assert.equal(e.custom, false, id + ' is built-in, not custom');
    assert.equal(e.integrationImplemented, false, id + ' is honestly marked not implemented');
    assert.ok(/no integration actions are implemented/.test(e.readinessNote || ''), id + ' carries an honest readiness note');
    assert.ok(e.costNote && e.limits, id + ' shows cost and limits before activation');
    assert.ok(Array.isArray(e.scopes) && e.scopes.length >= 1, id + ' declares exact scopes');
    assert.ok(e.category, id + ' has a category for the panel filter');
    assert.ok(e.selfHostable === false, id + ' is a cloud service');
  }
});

test('a popular provider connects through the explicit gate but authorizeCall refuses it', () => {
  const c = createConnectorCatalog({});
  const r = c.connect('slack', { userInitiated: true, scopes: ['channels.read'], credentialRef: 'vault:slack-cred' });
  assert.equal(r.ok, true, 'the unchanged explicit connect gate still runs');
  assert.equal(c.state('slack'), 'connected');
  assert.deepEqual(c.authorizeCall('slack', 'channels.read', {}), { allowed: false, reason: 'integration_not_implemented' }, 'no fake working integration');
});

test('existing built-in connectors keep their authorizeCall behavior', () => {
  const c = createConnectorCatalog({});
  c.connect('rss', { userInitiated: true, scopes: ['feed.read'], credentialRef: 'vault:rss-cred' });
  assert.equal(c.authorizeCall('rss', 'feed.read', {}).allowed, true, 'the legacy tier is untouched');
});

test('the new entries are AI-discoverable through describe with the honest marker', () => {
  const c = createConnectorCatalog({});
  const d = c.describe('notion');
  assert.equal(d.id, 'notion');
  assert.equal(d.integrationImplemented, false);
  assert.ok(/no integration actions are implemented/.test(d.readinessNote));
});

test('snapshot/restore is unaffected by the curated tier', () => {
  const c = createConnectorCatalog({});
  const snap = c.snapshot();
  assert.equal(snap.states.length, 0, 'nothing is connected by listing');
  const fresh = createConnectorCatalog({});
  assert.equal(fresh.restore(snap).ok, true);
  assert.equal(fresh.state('slack'), 'discovered');
});

test('every curated entry keeps unique ids and validated scope shapes', () => {
  const c = createConnectorCatalog({});
  const all = c.list();
  const ids = all.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate ids across the catalog');
  for (const e of all) {
    for (const s of e.scopes) {
      assert.ok(/^[a-z][a-z0-9_.]{2,63}$/.test(s.name), e.id + ' scope name shape');
    }
  }
});
