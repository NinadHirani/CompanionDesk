'use strict';

// M7 capture-simulation slice (28 Nov 2026, owner-directed offline-safe
// scope): a pure policy simulator for the capture engine's consent gate.
// No screen is captured, no permission flow runs, no device API is
// touched: the simulator mirrors the established rules (capture disabled
// by default, explicit owner enablement, per-call consent that
// auto-resets to off after every capture attempt, sensitive sources
// refused without explicit consent, an audit entry for every decision)
// so the policy logic is testable offline before any real device lane
// opens. The real capture engine and its permission flows stay excluded.

const test = require('node:test');
const assert = require('node:assert');
const { createCaptureSimulator } = require('../src/capture-simulation.js');

test('capture is disabled by default and every request is refused', () => {
  const sim = createCaptureSimulator();
  const r = sim.process({ ts: 1, source: 'screen', kind: 'observation', sensitive: false, consent: true });
  assert.equal(r.decision, 'refused');
  assert.equal(r.reason, 'capture_disabled');
});

test('enablement is explicit, one call, and stays narrow', () => {
  const sim = createCaptureSimulator();
  assert.equal(sim.isEnabled(), false);
  sim.setPolicy({ enabled: true });
  assert.equal(sim.isEnabled(), true);
  const r = sim.process({ ts: 2, source: 'window-list', kind: 'inventory', sensitive: false, consent: true });
  assert.equal(r.decision, 'captured');
  assert.equal(r.reason, null);
});

test('per-call consent auto-resets to off after every capture attempt', () => {
  const sim = createCaptureSimulator({ enabled: true });
  const first = sim.process({ ts: 1, source: 'screen', kind: 'observation', sensitive: false, consent: true });
  assert.equal(first.decision, 'captured');
  const second = sim.process({ ts: 2, source: 'screen', kind: 'observation', sensitive: false, consent: false });
  assert.equal(second.decision, 'refused');
  assert.equal(second.reason, 'consent_reset', 'consent does not persist past one attempt');
});

test('a sensitive source is refused without explicit consent', () => {
  const sim = createCaptureSimulator({ enabled: true });
  const r = sim.process({ ts: 1, source: 'private-app', kind: 'observation', sensitive: true, consent: false });
  assert.equal(r.decision, 'refused');
  assert.equal(r.reason, 'sensitive_consent_required');
  const ok = sim.process({ ts: 2, source: 'private-app', kind: 'observation', sensitive: true, consent: true });
  assert.equal(ok.decision, 'captured');
});

test('every decision writes an audit entry, refusals included', () => {
  const sim = createCaptureSimulator({ enabled: true });
  sim.process({ ts: 1, source: 'screen', kind: 'observation', sensitive: false, consent: true });
  sim.process({ ts: 2, source: 'private-app', kind: 'observation', sensitive: true, consent: false });
  const audit = sim.audit();
  assert.equal(audit.length, 2);
  assert.equal(audit[0].decision, 'captured');
  assert.equal(audit[1].decision, 'refused');
  assert.equal(audit[1].reason, 'sensitive_consent_required');
  const stats = sim.stats();
  assert.deepEqual(stats, { processed: 2, captured: 1, refused: 1 });
});

test('malformed input refuses honestly instead of guessing', () => {
  const sim = createCaptureSimulator({ enabled: true });
  assert.throws(() => sim.process(null), /event must be an object/);
  assert.throws(() => sim.process({ ts: 1 }), /source/);
  assert.throws(() => sim.process({ ts: 1, source: 's', kind: 'k' }), /consent/);
});
