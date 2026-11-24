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

// ---- Gate 2 slice 6 review hardening: adversarial payload shapes ----
const { validateRequest: vr, validatePreloadAllowlist: vpa, refusalResponse: rr, RENDERER_CHANNELS: CH } = require('../src/ipc-contract.js');

test('hardening: class instances, Dates, arrays, functions and primitives are refused as payloads', () => {
  class Hostile {}
  for (const p of [new Date(), new Hostile(), [], () => {}, true, 'x', 5]) {
    const r = vr('audit:read', p);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'bad_payload');
  }
});

test('hardening: accessor properties are refused and the getter is never invoked', () => {
  let calls = 0;
  const p = {};
  Object.defineProperty(p, 'limit', { enumerable: true, get() { calls += 1; return 9; } });
  const r = vr('audit:read', p);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'accessor_property:limit');
  assert.equal(calls, 0);
});

test('hardening: a throwing getter is refused without propagating the throw', () => {
  const p = {};
  Object.defineProperty(p, 'limit', { enumerable: true, get() { throw new Error('boom'); } });
  const r = vr('audit:read', p);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'accessor_property:limit');
});

test('hardening: setter-only properties are refused', () => {
  const p = {};
  Object.defineProperty(p, 'fromSeq', { enumerable: true, set() {} });
  const r = vr('audit:read', p);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'accessor_property:fromSeq');
});

test('hardening: non-enumerable own properties are refused', () => {
  const p = {};
  Object.defineProperty(p, 'limit', { value: 5, enumerable: false, writable: true, configurable: true });
  const r = vr('audit:read', p);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'non_enumerable:limit');
});

test('hardening: symbol-keyed properties are refused', () => {
  const p = { limit: 5 };
  p[Symbol('shadow')] = 1;
  const r = vr('audit:read', p);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'symbol_key');
});

test('hardening: prototype-polluting own keys are refused before any copy', () => {
  const fromJson = JSON.parse('{"__proto__": {"injected": true}, "limit": 3}');
  let r = vr('audit:read', fromJson);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'polluting_key:__proto__');
  r = vr('audit:read', { ['constructor']: 1 });
  assert.equal(r.reason, 'polluting_key:constructor');
  r = vr('audit:read', { ['prototype']: 1 });
  assert.equal(r.reason, 'polluting_key:prototype');
  // The polluted source never becomes a validated payload.
  assert.equal(fromJson.limit, 3); // sanity: source untouched
});

test('hardening: inherited-key objects are refused as non-plain payloads', () => {
  const r = vr('audit:read', Object.create({ limit: 5 }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'bad_payload');
});

test('hardening: object and function values are refused, valid primitives still pass', () => {
  for (const v of [{}, [], new Date(), () => {}, null]) {
    assert.equal(vr('audit:read', { limit: v }).reason, 'bad_value:limit');
  }
  const good = vr('audit:read', { limit: 10, fromSeq: 2 });
  assert.equal(good.ok, true);
  assert.deepEqual(good.payload, { limit: 10, fromSeq: 2 });
  const p = { limit: 5 };
  const r = vr('audit:read', p);
  assert.notEqual(r.payload, p); // a real copy, not the input object
});

test('hardening: duplicate preload allowlist entries are refused', () => {
  const r = vpa(CH.concat(['status:get']));
  assert.equal(r.ok, false);
  assert.deepEqual(r.duplicates, ['status:get']);
  assert.deepEqual(vpa(CH.slice().reverse()), { ok: true });
});

test('hardening: refusalResponse stringifies nothing but a string reason', () => {
  const hostile = { toString() { throw new Error('leak'); } };
  assert.equal(rr(hostile).reason, 'refused');
  assert.equal(rr(Symbol('s')).reason, 'refused');
  assert.equal(rr(42).reason, 'refused');
  assert.equal(rr(null).reason, 'refused');
  assert.equal(rr(['a']).reason, 'refused');
  assert.equal(rr('unknown_channel').reason, 'unknown_channel');
  assert.equal(rr('x'.repeat(80)).reason.length, 64);
  for (const r of [rr('a'), rr({})]) {
    assert.equal(r.ok, false);
    assert.equal(r.error, 'refused');
  }
});
