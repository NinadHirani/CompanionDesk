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
  // 27 Nov 2026 adapter batch: nine of the thirteen now have real request
  // builders (integrationImplemented true + an honest setup note); the
  // other four stay definition-only and refused until an adapter exists.
  const IMPLEMENTED = ['slack', 'discord', 'notion', 'google-drive', 'gmail', 'google-calendar', 'microsoft-onedrive', 'microsoft-outlook', 'telegram'];
  for (const id of POPULAR) {
    const e = all.find((x) => x.id === id);
    assert.ok(e, id + ' is listed');
    assert.equal(e.custom, false, id + ' is built-in, not custom');
    const isImpl = IMPLEMENTED.indexOf(id) !== -1;
    assert.equal(e.integrationImplemented, isImpl, id + ' carries the honest marker');
    if (isImpl) {
      assert.ok(e.readinessNote.indexOf('adapter implemented:') === 0, id + ' carries the adapter note');
      assert.ok(e.readinessNote.includes('setup'), id + " says what setup is still the user's");
    } else {
      assert.ok(/no integration actions are implemented/.test(e.readinessNote || ''), id + ' carries an honest readiness note');
    }
    assert.ok(e.costNote && e.limits, id + ' shows cost and limits before activation');
    assert.ok(Array.isArray(e.scopes) && e.scopes.length >= 1, id + ' declares exact scopes');
    assert.ok(e.category, id + ' has a category for the panel filter');
    assert.ok(e.selfHostable === false, id + ' is a cloud service');
  }
});

test('a definition-only popular provider connects through the explicit gate but authorizeCall refuses it', () => {
  const c = createConnectorCatalog({});
  const scope = c.describe('spotify').scopes[0].name;
  const r = c.connect('spotify', { userInitiated: true, scopes: [scope], credentialRef: 'vault:spotify-cred' });
  assert.equal(r.ok, true, 'the unchanged explicit connect gate still runs');
  assert.equal(c.state('spotify'), 'connected');
  assert.deepEqual(c.authorizeCall('spotify', scope, {}), { allowed: false, reason: 'integration_not_implemented' }, 'no fake working integration');
});

test('an implemented popular provider is allowed at authorizeCall once connected, and sends still need a per-action approval', () => {
  const c = createConnectorCatalog({});
  const r = c.connect('slack', { userInitiated: true, scopes: ['channels.read', 'message.send'], credentialRef: 'vault:slack-cred' });
  assert.equal(r.ok, true);
  assert.equal(c.state('slack'), 'connected');
  assert.equal(c.authorizeCall('slack', 'channels.read', {}).allowed, true, 'read-only actions run after connect');
  assert.deepEqual(c.authorizeCall('slack', 'message.send', {}), { allowed: false, reason: 'approval_required' }, 'sends need a single-use approval');
  const a = c.approve('slack', 'message.send', { userInitiated: true });
  assert.equal(a.ok, true);
  assert.equal(c.authorizeCall('slack', 'message.send', { approvalId: a.approvalId }).allowed, true, 'the approval opens exactly one call');
  assert.deepEqual(c.authorizeCall('slack', 'message.send', { approvalId: a.approvalId }), { allowed: false, reason: 'approval_required' }, 'and is single-use');
});

test('existing built-in connectors keep their authorizeCall behavior', () => {
  const c = createConnectorCatalog({});
  c.connect('rss', { userInitiated: true, scopes: ['feed.read'], credentialRef: 'vault:rss-cred' });
  assert.equal(c.authorizeCall('rss', 'feed.read', {}).allowed, true, 'the legacy tier is untouched');
});

test('the still-definition-only entries are AI-discoverable through describe with the honest marker', () => {
  const c = createConnectorCatalog({});
  const d = c.describe('spotify');
  assert.equal(d.id, 'spotify');
  assert.equal(d.integrationImplemented, false);
  assert.ok(/no integration actions are implemented/.test(d.readinessNote));
});

test('the implemented entries are AI-discoverable through describe with the adapter marker', () => {
  const c = createConnectorCatalog({});
  const d = c.describe('notion');
  assert.equal(d.id, 'notion');
  assert.equal(d.integrationImplemented, true);
  assert.ok(d.readinessNote.indexOf('adapter implemented:') === 0);
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
