'use strict';
// Expanded breadth tier (27 Nov 2026, Ninad's request): the catalog offers a
// broad, curated variety of connectors across productivity, email,
// communication, developer, cloud, AI, CRM/business, finance, analytics,
// media, education, research, travel, maps, smart home and automation. Every
// new entry is discovery metadata only: real cost and limits, exact
// least-privilege scopes, integrationImplemented: false, and an authorizeCall
// refusal until a real adapter exists. Nothing auto-connects and no
// credentials are requested anywhere; custom connectors keep their own
// HTTPS/no-secrets gate unchanged.

const { test } = require('node:test');
const assert = require('node:assert');
const { createConnectorCatalog } = require('../src/connectors.js');

const EXPECTED_TOTAL = 187; // batch 10 brave+tavily, batch 12 excel+word
const EXPECTED_DEFINITION_ONLY = 140; // batch 11 google reads, batch 13 microsoft-teams, batch 15 jira, batch 16 musicbrainz, batch 17 pypi, batch 19 docker-hub

test('the catalog is the expanded set with no duplicate ids or names', () => {
  const c = createConnectorCatalog({});
  const l = c.list();
  assert.equal(l.length, EXPECTED_TOTAL, 'legacy 22 + curated 15 + expanded 149 + microsoft-calendar');
  const ids = l.map(e => e.id);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate ids');
  const names = l.map(e => e.name.toLowerCase());
  assert.equal(new Set(names).size, names.length, 'no duplicate names');
  assert.equal(c.snapshot().states.length, 0, 'nothing is connected by listing');
});

test('every entry carries complete metadata: provider, category, auth, cost, limits, scopes', () => {
  const c = createConnectorCatalog({});
  const costOK = ['free_open_source', 'free_tier', 'paid'];
  const authOK = ['none', 'oauth2', 'api_key', 'access_token', 'app_password', 'local'];
  const hostOK = ['local', 'self_hostable', 'cloud'];
  const scopeRE = /^[a-z][a-z0-9_.]{2,63}$/;
  const catRE = /^[A-Za-z0-9 _-]{1,40}$/;
  for (const e of c.list()) {
    assert.ok(e.provider && e.name && e.category && catRE.test(e.category), e.id + ' provider, name and category');
    assert.ok(costOK.includes(e.costModel) && e.costNote, e.id + ' cost model and note');
    assert.ok(authOK.includes(e.auth) && hostOK.includes(e.hosting), e.id + ' auth and hosting');
    assert.ok(e.limits, e.id + ' limits stated');
    assert.ok(Array.isArray(e.scopes) && e.scopes.length >= 1, e.id + ' declares exact scopes');
    const scopeNames = e.scopes.map(s => s.name);
    assert.equal(new Set(scopeNames).size, scopeNames.length, e.id + ' no duplicate scopes');
    for (const s of e.scopes) {
      assert.ok(scopeRE.test(s.name), e.id + ' scope name ' + s.name);
      assert.ok(c.SCOPE_CLASSES[s.class], e.id + ' scope class ' + s.class);
      assert.ok(!s.name.includes('*') && !s.name.toLowerCase().includes('admin'), e.id + ' least-privilege scope ' + s.name);
    }
  }
});

test('every new expanded entry is least-privilege with a read-only baseline scope', () => {
  const c = createConnectorCatalog({});
  const expanded = c.list().filter(e => e.integrationImplemented === false && e.id !== 'slack' && e.id !== 'discord' && e.id !== 'notion' && e.id !== 'dropbox' && e.id !== 'google-drive' && e.id !== 'gmail' && e.id !== 'google-calendar' && e.id !== 'microsoft-onedrive' && e.id !== 'microsoft-outlook' && e.id !== 'telegram' && e.id !== 'youtube' && e.id !== 'spotify' && e.id !== 'zoom');
  assert.equal(expanded.length, 136, 'the 136 still-definition-only expanded entries carry the marker (batch 11 google reads, batch 12 excel/word, batch 13 microsoft-teams, batch 15 jira, batch 16 musicbrainz, batch 17 pypi, batch 19 docker-hub reads; Open-Meteo sits in the legacy tier)');
  for (const e of expanded) {
    assert.ok(e.scopes.some(s => s.class === 'read_only'), e.id + ' has a read-only baseline scope');
  }
});

test('every definition-only entry is honestly labelled and refused at authorizeCall even when connected', () => {
  const defs = createConnectorCatalog({}).list().filter(e => e.integrationImplemented === false);
  assert.equal(defs.length, EXPECTED_DEFINITION_ONLY, 'curated + expanded are all definition-only');
  for (const e of defs) {
    assert.equal(e.readinessNote, 'definition only: no integration actions are implemented for ' + e.name + ' in this build', e.id + ' honest readiness note');
    const c2 = createConnectorCatalog({});
    const r = c2.connect(e.id, { userInitiated: true, scopes: [e.scopes[0].name], credentialRef: 'vault:' + e.id + '-cred' });
    assert.equal(r.ok, true, e.id + ' still connects only through the explicit user gate');
    assert.deepEqual(c2.authorizeCall(e.id, e.scopes[0].name, {}), { allowed: false, reason: 'integration_not_implemented' }, e.id + ' never fakes a working integration');
    assert.equal(c2.disconnect(e.id, { userInitiated: true }).ok, true, e.id + ' disconnect stays available');
  }
});

test('the catalog covers the requested breadth of categories', () => {
  const c = createConnectorCatalog({});
  const cats = new Set(c.list().map(e => e.category));
  const required = ['productivity', 'automation', 'email', 'messaging', 'meetings', 'calendar', 'developer', 'cloud', 'ai_cloud', 'ai_local', 'business', 'finance', 'analytics', 'media', 'social', 'education', 'reference', 'travel', 'maps', 'home', 'monitoring', 'notes', 'files', 'code', 'feeds', 'weather', 'search'];
  for (const cat of required) assert.ok(cats.has(cat), cat + ' present');
  assert.equal(cats.size, 27, '27 distinct categories keep the filter list usable');
  for (const cat of cats) {
    assert.ok(c.list().filter(e => e.category === cat).length >= 1, cat + ' is non-empty');
  }
});

test('near-duplicate provider concepts are deduplicated to one entry each', () => {
  const c = createConnectorCatalog({});
  const ids = c.list().map(e => e.id);
  for (const dupe of ['google', 'microsoft-365', 'gmail-2', 'slack-2', 'openai-2', 'github-2']) {
    assert.ok(!ids.includes(dupe), 'no ' + dupe);
  }
  // One entry per major provider concept
  const googleEntries = c.list().filter(e => e.provider === 'Google');
  for (const e of googleEntries) assert.ok(!googleEntries.some(o => o !== e && o.name === e.name), e.name + ' unique among Google entries');
});
