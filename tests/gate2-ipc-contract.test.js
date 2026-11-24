'use strict';
// Gate 2 slice 6: the IPC contract is fail-closed and read-only for the
// renderer. These tests are the boundary the wiring layer must satisfy.
const test = require('node:test');
const assert = require('node:assert/strict');
const { RENDERER_CHANNELS, MAIN_ONLY_CHANNELS, validateRequest, validatePreloadAllowlist, refusalResponse } = require('../src/ipc-contract.js');

test('the renderer surface is read-only by construction', () => {
  for (const ch of RENDERER_CHANNELS) {
    assert.match(ch, /^(status|runs|audit|providers|notifications|reminders):/, 'renderer channels are reads only: ' + ch);
  }
  // No execution-capable name may ever appear in the renderer set.
  for (const ch of MAIN_ONLY_CHANNELS) {
    assert.equal(RENDERER_CHANNELS.includes(ch), false, 'main-only channel ' + ch + ' is not renderer-exposed');
  }
  const allowWords = ['start', 'step', 'resume', 'abort', 'approval', 'grant', 'stop', 'persistence'];
  for (const ch of RENDERER_CHANNELS) {
    for (const w of allowWords) {
      assert.equal(ch.includes(':' + w), false, 'renderer channel ' + ch + ' must not carry a write verb');
    }
  }
});

test('unknown and main-only channels are refused (fail closed)', () => {
  for (const ch of ['does:not:exist', '', null, undefined, 42, 'run:start', 'approval:request', 'grants:grant', 'stop:activate', 'persistence:write', 'Run:get']) {
    const r = validateRequest(ch, {});
    assert.equal(r.ok, false, JSON.stringify(ch) + ' must be refused');
    assert.equal(r.reason, 'unknown_channel');
  }
});

test('payloads validate strictly: shapes, types, and no extra keys', () => {
  assert.deepEqual(validateRequest('status:get', {}).payload, {});
  assert.deepEqual(validateRequest('status:get', undefined).payload, {});
  // Extra keys refused everywhere.
  for (const ch of RENDERER_CHANNELS) {
    assert.equal(validateRequest(ch, { evil: 'x' }).ok, false, ch + ': unknown field refused');
  }
  // Wrong types refused.
  assert.equal(validateRequest('runs:get', { runId: 42 }).ok, false);
  assert.equal(validateRequest('runs:get', { runId: '' }).ok, false);
  assert.equal(validateRequest('runs:get', { runId: 'a'.repeat(65) }).ok, false);
  assert.equal(validateRequest('audit:read', { limit: 0 }).ok, false);
  assert.equal(validateRequest('audit:read', { limit: 501 }).ok, false);
  assert.equal(validateRequest('audit:read', { limit: 1.5 }).ok, false);
  assert.equal(validateRequest('audit:read', { limit: '10' }).ok, false);
  assert.equal(validateRequest('audit:read', { fromSeq: -1 }).ok, false);
  assert.equal(validateRequest('notifications:read', { limit: 99999 }).ok, false);
  // Non-object payloads refused.
  assert.equal(validateRequest('status:get', [1, 2]).ok, false);
  assert.equal(validateRequest('status:get', 'x').ok, false);
  // Explicit undefined field refused (a value must be a real value).
  assert.equal(validateRequest('runs:get', { runId: undefined }).ok, false);
  // Valid shapes pass and are copied, not aliased.
  const inPayload = { runId: 'r1' };
  const ok = validateRequest('runs:get', inPayload);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.payload, { runId: 'r1' });
  assert.notEqual(ok.payload, inPayload);
  assert.deepEqual(validateRequest('audit:read', { limit: 100, fromSeq: 5 }).payload, { limit: 100, fromSeq: 5 });
  assert.deepEqual(validateRequest('reminders:read', { limit: 10 }).payload, { limit: 10 });
});

test('validatePreloadAllowlist proves the wiring surface equals the contract', () => {
  assert.deepEqual(validatePreloadAllowlist(RENDERER_CHANNELS), { ok: true }, 'the contract itself satisfies the contract');
  const missing = validatePreloadAllowlist(['status:get']);
  assert.equal(missing.ok, false);
  assert.ok(missing.missing.length > 0, 'a partial surface is reported, never assumed complete');
  const extra = validatePreloadAllowlist([...RENDERER_CHANNELS, 'run:start']);
  assert.equal(extra.ok, false, 'a widened surface is refused');
  assert.deepEqual(extra.extra, ['run:start'], 'the widened channel is named');
  assert.equal(validatePreloadAllowlist('not-a-list').ok, false);
  const shuffled = [...RENDERER_CHANNELS].reverse();
  assert.deepEqual(validatePreloadAllowlist(shuffled), { ok: true }, 'order does not matter, exact set does');
});

test('refusals render one consistent fail-closed shape', () => {
  const r = refusalResponse('unknown_channel');
  assert.deepEqual(r, { ok: false, error: 'refused', reason: 'unknown_channel' });
  assert.equal(refusalResponse('x'.repeat(999)).reason.length <= 64, true, 'reason bounded');
});
