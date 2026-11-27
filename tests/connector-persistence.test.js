'use strict';

// Gate 2 AI-access connector flow (27 Nov 2026): a connection is one-time
// and persistent until the user disconnects it. The catalog gains a strict
// snapshot/restore pair; these tests pin the round-trip and the fail-closed
// validation.

const test = require('node:test');
const assert = require('node:assert');
const cc = require('../src/connectors.js');

function connectedCatalog() {
  const c = cc.createConnectorCatalog({ clock: () => 7 });
  const r = c.connect('rss', { userInitiated: true, scopes: ['feed.read'], credentialRef: 'keychain:companiondesk-rss' });
  assert.equal(r.ok, true);
  return c;
}

test('snapshot exports states and exact grants only, never credential references', () => {
  const c = connectedCatalog();
  const snap = JSON.parse(JSON.stringify(c.snapshot()));
  assert.deepEqual(snap.states, [{ id: 'rss', state: 'connected' }]);
  assert.deepEqual(snap.grants, [{ id: 'rss', scopes: ['feed.read'] }]);
  assert.equal(/keychain:|vault:|credential-store:/i.test(JSON.stringify(snap)), false, 'credential references stay out of the snapshot');
});

test('restore round-trips a connected entry with its exact grants', () => {
  const snap = JSON.parse(JSON.stringify(connectedCatalog().snapshot()));
  const fresh = cc.createConnectorCatalog({ clock: () => 8 });
  const res = fresh.restore(snap);
  assert.equal(res.ok, true, JSON.stringify(res.problems));
  assert.equal(fresh.state('rss'), 'connected');
  // the restored grant authorizes exactly the granted scope
  assert.deepEqual(fresh.authorizeCall('rss', 'feed.read', {}), { allowed: true });
  assert.equal(fresh.authorizeCall('rss', 'feed.read', { approvalId: 'apr-1' }).allowed, true, 'read scopes need no approval');
});

test('restore fails closed: unknown ids, undeclared scopes, grants without connection', () => {
  const fresh = cc.createConnectorCatalog({ clock: () => 8 });
  const bad1 = fresh.restore({ states: [{ id: 'nope', state: 'connected' }], grants: [] });
  assert.equal(bad1.ok, false);
  assert.ok(bad1.problems.includes('unknown_connector'));
  assert.equal(fresh.state('nope'), null);
  const bad2 = fresh.restore({ states: [{ id: 'rss', state: 'connected' }], grants: [{ id: 'rss', scopes: ['not.a.scope'] }] });
  assert.equal(bad2.ok, false);
  assert.ok(bad2.problems.includes('bad_scopes'));
  assert.equal(fresh.state('rss'), 'discovered', 'the invalid grant left nothing behind');
  const bad3 = fresh.restore({ states: [], grants: [{ id: 'rss', scopes: ['feed.read'] }] });
  assert.equal(bad3.ok, false);
  assert.ok(bad3.problems.includes('not_connected'));
  assert.equal(fresh.state('rss'), 'discovered');
  const bad4 = fresh.restore({ states: [{ id: 'rss', state: 'connected' }], grants: [] });
  assert.equal(bad4.ok, false);
  assert.ok(bad4.problems.includes('connection_without_grants'));
  assert.equal(fresh.state('rss'), 'discovered', 'an ungrantable connection is not kept');
  assert.equal(fresh.restore({}).ok, false, 'malformed snapshot refused');
  assert.equal(fresh.restore(null).ok, false, 'a null snapshot is refused');
});

test('after restore the lifecycle still gates every change behind the user', () => {
  const snap = JSON.parse(JSON.stringify(connectedCatalog().snapshot()));
  const fresh = cc.createConnectorCatalog({ clock: () => 8 });
  fresh.restore(snap);
  assert.equal(fresh.disconnect('rss', {}).reason, 'requires_user_action', 'disconnect still needs the user');
  assert.equal(fresh.disconnect('rss', { userInitiated: true }).ok, true, 'the user can always disconnect');
  assert.equal(fresh.state('rss'), 'disconnected');
  const snap2 = JSON.parse(JSON.stringify(fresh.snapshot()));
  assert.deepEqual(snap2.states, [{ id: 'rss', state: 'disconnected' }], 'disconnected state persists too');
  assert.deepEqual(snap2.grants, [], 'a disconnect clears the grants');
});
