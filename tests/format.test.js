'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { fmtDay, relDays } = require('../renderer/format');

test('fmtDay gives weekday, month and day, in UTC', () => {
  assert.equal(fmtDay('2026-11-04'), 'Wed Nov 4');
  assert.equal(fmtDay('2026-12-31'), 'Thu Dec 31');
  assert.equal(fmtDay('2028-02-29'), 'Tue Feb 29');
});

test('fmtDay refuses anything that is not a real date', () => {
  for (const bad of ['2026-02-30', '2026-13-01', '11/04/2026', '', null, undefined, 20261104]) {
    assert.equal(fmtDay(bad), null, String(bad));
  }
});

test('relDays words', () => {
  assert.equal(relDays(0), 'today');
  assert.equal(relDays(1), 'tomorrow');
  assert.equal(relDays(6), 'in 6 days');
  assert.equal(relDays(-1), null);
  assert.equal(relDays(1.5), null);
});

test('pcm: float chunks become little-endian Int16, clamped, across chunk boundaries', () => {
  const { floatChunksToPcm16 } = require('../renderer/pcm');
  const out = floatChunksToPcm16([Float32Array.from([0, 0.5]), Float32Array.from([-0.5, 1, -1, 2, -2, NaN])]);
  const v = new DataView(out.buffer);
  const got = Array.from({ length: out.length / 2 }, (_, i) => v.getInt16(i * 2, true));
  assert.deepEqual(got, [0, 16384, -16384, 32767, -32768, 32767, -32768, 0]);
  assert.equal(floatChunksToPcm16([]).length, 0);
});
