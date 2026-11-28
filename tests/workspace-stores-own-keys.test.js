'use strict';

// Own-keys validation pin (28 Nov 2026): the row validator walked with
// for...in, which also visits INHERITED enumerable properties. Every other
// validator in the repo inspects own enumerable keys only (workspace-views
// accept(), the notifications display store, the delivery gate), because
// a row must never be judged on data it does not own. Observable here:
// with an inherited enumerable property whose value would fail an enum,
// a row whose OWN fields are all valid must still be accepted; inherited
// values are ignored, never validated and never stored.

const test = require('node:test');
const assert = require('node:assert');
const { createWorkspaceStore } = require('../src/workspace-stores');

test('add validates own enumerable keys only, never inherited ones', () => {
  const store = createWorkspaceStore({
    name: 'test',
    prefix: 'f',
    fields: ['name', 'status'],
    enums: { status: ['active', 'archived'] },
  });
  // An inherited enumerable property on Object.prototype (pollution):
  // its value would fail the status enum, so for...in validation would
  // refuse a row that owns nothing invalid.
  Object.defineProperty(Object.prototype, 'status_probe_1128', {
    value: 'not-in-enum', enumerable: true, configurable: true, writable: true,
  });
  try {
    const r = store.add({ name: 'clean row' });
    assert.equal(r.ok, true, 'a row with valid own fields must be accepted; inherited properties must be ignored');
  } finally {
    delete Object.prototype.status_probe_1128;
  }
  // And a genuinely invalid OWN value is still refused.
  assert.equal(store.add({ name: 'x', status: 'nope' }).ok, false);
});
