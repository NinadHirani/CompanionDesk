'use strict';
// Gate 4 documentation slice (27 Nov 2026, Ninad-approved read-only/doc polish):
// the shipped file-access policy/execution core gets a generated docs page held
// in sync with src/agent-tool-file-access.js. The doc may never name an action
// that is not shipped, and it must state the destructive-confirmation gate,
// the byte caps, the sandbox note, and the driver-run boundary.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const fa = require('../src/agent-tool-file-access.js');

const DOC_PATH = path.join(__dirname, '..', 'docs', 'FILE_ACCESS.md');
const ACTIONS = fa.FILE_ACCESS_TOOL_DEFINITION.schema.properties.action.enum;

test('the file-access doc exists and states the shipped safeguards and caps', () => {
  const doc = fs.readFileSync(DOC_PATH, 'utf8');
  for (const a of ACTIONS) assert.ok(doc.includes('`' + a + '`'), a + ' named in the doc');
  assert.ok(doc.includes('overwrite_requires_confirmation'));
  assert.ok(doc.includes('delete_requires_confirmation'));
  assert.ok(doc.includes('content_too_large'));
  assert.ok(/65,?536/.test(doc) && doc.includes('MAX_WRITE_BYTES'));
  assert.ok(doc.includes('never bypasses'), 'sandbox note stated');
  assert.ok(/second registered (agent )?tool/i.test(doc));
  assert.ok(/driver-driven runs/.test(doc));
});

test('the doc actions table lists exactly the shipped actions', () => {
  const doc = fs.readFileSync(DOC_PATH, 'utf8');
  const table = doc.split('## Actions')[1] || '';
  const named = new Set([...table.matchAll(/^\| `([a-z]+)` \|/gm)].map((m) => m[1]));
  assert.ok(named.size > 0, 'the doc table lists actions');
  assert.deepEqual([...named].sort(), [...ACTIONS].sort());
});

test('the doc states the real schema caps from the tool definition', () => {
  const doc = fs.readFileSync(DOC_PATH, 'utf8');
  const props = fa.FILE_ACCESS_TOOL_DEFINITION.schema.properties;
  assert.equal(props.path.maxLength, 500);
  assert.equal(props.content.maxLength, 500);
  assert.ok(/500/.test(doc), 'schema caps named');
});
