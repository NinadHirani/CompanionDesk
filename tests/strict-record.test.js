'use strict';

// The shared strict record validator must be as strict as its sibling IPC
// contract: a persisted record carrying its OWN '__proto__', 'constructor'
// or 'prototype' data property is hostile plain data, and every naive
// assignment-style copy of a validated record (the most common downstream
// pattern) runs the '__proto__' setter on the copy target. The validator
// must refuse all three before anything downstream can copy the record.
// No Electron, no database: pure data only.

const test = require('node:test');
const assert = require('node:assert');
const { plainRecords, strictFlag, strictTimestamp, TS_MIN, TS_MAX } = require('../src/strict-record');

function ownPolluted(key, value) {
  const rec = { ok: 1 };
  Object.defineProperty(rec, key, { value, enumerable: true, writable: true, configurable: true });
  return rec;
}

test('REGRESSION: own __proto__ data property is refused, never accepted', () => {
  const r = plainRecords([ownPolluted('__proto__', { x: 9 })]);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'polluting_key:__proto__');
  assert.equal(r.index, 0);
});

test('REGRESSION: own constructor data property is refused', () => {
  const r = plainRecords([ownPolluted('constructor', 1)]);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'polluting_key:constructor');
});

test('REGRESSION: own prototype data property is refused', () => {
  const r = plainRecords([ownPolluted('prototype', 1)]);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'polluting_key:prototype');
});

test('a validated record must never survive a naive assignment copy with a live __proto__ setter call', () => {
  // The danger chain the refusal closes: assignment-copying the record runs
  // target.__proto__ = ... on plain-object targets. With the refusal in
  // place no such record is ever returned, so prove acceptance can no
  // longer hand one downstream.
  const rec = ownPolluted('__proto__', { x: 9 });
  const r = plainRecords([rec]);
  assert.equal(r.ok, false);
});

test('legit records still validate: plain, null-proto, empty arrays and records', () => {
  assert.deepEqual(plainRecords([{ a: 1 }, { b: 'x' }]), { ok: true, records: [{ a: 1 }, { b: 'x' }] });
  assert.equal(plainRecords([Object.create(null)]).ok, true);
  assert.equal(plainRecords([]).ok, true);
  assert.equal(plainRecords([{}]).ok, true);
});

test('existing strictness is untouched: shapes, descriptors and values still refuse', () => {
  assert.equal(plainRecords('nope').reason, 'not_array');
  assert.equal(plainRecords([undefined]).reason, 'not_plain_record');
  assert.equal(plainRecords([[1]]).reason, 'not_plain_record');
  assert.equal(plainRecords([new Map()]).reason, 'not_plain_record');
  // literal __proto__ changes the actual prototype, so it stays not_plain_record
  assert.equal(plainRecords([{ __proto__: { x: 1 }, a: 1 }]).reason, 'not_plain_record');
  const holes = [ , 1 ]; // eslint-disable-line no-sparse-arrays
  assert.equal(plainRecords(holes).reason, 'sparse_array');
  const withSym = {}; withSym[Symbol('s')] = 1;
  assert.equal(plainRecords([withSym]).reason, 'symbol_key');
  const withGet = { get a() { return 1; } };
  assert.equal(plainRecords([withGet]).reason, 'accessor_property');
  const frozen = Object.freeze({ a: 1 });
  const frozenRec = {}; Object.defineProperty(frozenRec, 'a', { value: 1, enumerable: true, writable: false, configurable: true });
  assert.equal(plainRecords([frozenRec]).reason, 'bad_descriptor');
  const withFn = { a: () => 1 };
  assert.equal(plainRecords([withFn]).reason, 'function_value');
});

test('strictFlag stays exact 0/1 only', () => {
  assert.equal(strictFlag(0), false);
  assert.equal(strictFlag(1), true);
  assert.equal(strictFlag(2), null);
  assert.equal(strictFlag('1'), null);
  assert.equal(strictFlag(null), null);
  assert.equal(strictFlag(true), null);
});

test('strictTimestamp stays bounded safe integers only', () => {
  assert.equal(strictTimestamp(TS_MIN), TS_MIN);
  assert.equal(strictTimestamp(TS_MAX), TS_MAX);
  assert.equal(strictTimestamp(TS_MIN - 1), null);
  assert.equal(strictTimestamp(TS_MAX + 1), null);
  assert.equal(strictTimestamp(1.5), null);
  assert.equal(strictTimestamp('100'), null);
  assert.equal(strictTimestamp(NaN), null);
});
