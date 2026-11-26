'use strict';
// Gate 2 documentation slice (27 Nov 2026, Ninad-approved): the shipped
// connector catalog gets a generated, read-only docs page that stays in
// sync with src/connectors.js. The doc may never name a connector that
// is not in the shipped catalog, and it must state the activation gate:
// nothing auto-connects, activation is an explicit user selection per
// connector with explicit scopes.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const cc = require('../src/connectors.js');

const DOC_PATH = path.join(__dirname, '..', 'docs', 'CONNECTOR_CATALOG.md');

test('the connector catalog doc exists and covers every shipped entry', () => {
  const doc = fs.readFileSync(DOC_PATH, 'utf8');
  const c = cc.createConnectorCatalog({ clock: () => 1700000000000 });
  for (const e of c.list()) {
    assert.ok(doc.includes('`' + e.id + '`'), e.id + ' named in the doc');
    assert.ok(doc.includes(e.costNote), e.id + ' cost visible');
    assert.ok(doc.includes(e.limits), e.id + ' limits visible');
  }
});

test('the doc states the activation gate: nothing auto-connects, explicit selection per connector', () => {
  const doc = fs.readFileSync(DOC_PATH, 'utf8');
  assert.ok(/AUTO_CONNECT is false|nothing auto-connects/i.test(doc), 'no auto-connect statement');
  assert.ok(/explicit (user )?selection/i.test(doc), 'explicit selection statement');
  assert.ok(/not registered/i.test(doc), 'unregistered status stated');
});

test('the doc names no connector id that is not in the shipped catalog', () => {
  const doc = fs.readFileSync(DOC_PATH, 'utf8');
  const table = doc.split('## Catalog')[1] || '';
  const named = new Set([...table.matchAll(/^\| `([a-z0-9-]+)` \|/gm)].map((m) => m[1]));
  assert.ok(named.size > 10, 'the doc table lists the catalog');
  const c = cc.createConnectorCatalog({ clock: () => 1700000000000 });
  const shipped = new Set(c.list().map((e) => e.id));
  for (const id of named) assert.ok(shipped.has(id), id + ' is a shipped id, not an invented one');
  for (const id of shipped) assert.ok(named.has(id), id + ' not missing from the doc table');
});
