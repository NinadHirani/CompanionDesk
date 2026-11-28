'use strict';

// M8 batch 56 (28 Nov 2026, standing authorization): offline-simulation
// hardening. The M7 capture simulator is a pure policy module in the
// owner-directed offline-safe scope: no screen capture, no permission
// flow, no device API. Its existing six tests pin the consent policy;
// this batch hardens one real gap the module still has: the audit log
// grows without bound, while every other pure store in this codebase is
// bounded. The contract this test pins: the audit log holds a bounded
// window of recent entries, the totals (stats) stay exact forever, and
// a dropped audit entry never changes a counter or a decision.
// Test-only until it fails; then the module gains the cap.

const test = require('node:test');
const assert = require('node:assert');
const sim = require('../src/capture-simulation.js');

const AUDIT_CAP = 1000;

function event(i, consent) {
  return { ts: i, source: 'screen', kind: 'capture', consent: consent, sensitive: false };
}

test('the audit log stays bounded and drops only the oldest entries', () => {
  const s = sim.createCaptureSimulator({ enabled: true });
  for (let i = 0; i < AUDIT_CAP + 250; i++) s.process(event(i, true));
  const entries = s.audit();
  assert.equal(entries.length, AUDIT_CAP, 'audit holds at most ' + AUDIT_CAP + ' entries');
  assert.equal(entries[entries.length - 1].ts, AUDIT_CAP + 249, 'the newest entry survives');
  assert.equal(entries[0].ts, AUDIT_CAP + 250 - AUDIT_CAP, 'exactly the oldest entries are dropped');
});

test('totals stay exact while the audit window slides', () => {
  const s = sim.createCaptureSimulator({ enabled: true });
  for (let i = 0; i < AUDIT_CAP + 250; i++) s.process(event(i, i % 2 === 0));
  const st = s.stats();
  assert.equal(st.processed, AUDIT_CAP + 250, 'processed counts every attempt');
  assert.equal(st.captured, Math.ceil((AUDIT_CAP + 250) / 2), 'captured counter is exact');
  assert.equal(st.refused, Math.floor((AUDIT_CAP + 250) / 2), 'refused counter is exact');
});

test('a dropped audit entry never changes a later decision', () => {
  const s = sim.createCaptureSimulator({ enabled: true });
  for (let i = 0; i < AUDIT_CAP; i++) s.process(event(i, true));
  const r = s.process(event(AUDIT_CAP, false));
  assert.deepEqual(r, { decision: 'refused', reason: 'consent_reset' }, 'consent auto-reset still applies after the window slides');
  assert.equal(s.audit().length, AUDIT_CAP, 'the window never grows past the cap');
});
