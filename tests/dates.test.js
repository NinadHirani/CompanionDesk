'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { todayIso, localNowIso, addDaysIso } = require('../src/dates');

test('todayIso and localNowIso use the local calendar fields', () => {
  const d = new Date(2026, 10, 4, 0, 30, 5); // Nov 4 2026, 00:30:05 local
  assert.equal(todayIso(d), '2026-11-04');
  assert.equal(localNowIso(d), '2026-11-04T00:30:05');
  assert.equal(localNowIso(new Date(2026, 0, 2, 9, 5, 3)), '2026-01-02T09:05:03');
});

test('addDaysIso crosses month, year and leap boundaries', () => {
  assert.equal(addDaysIso('2026-11-02', 7), '2026-11-09');
  assert.equal(addDaysIso('2026-12-30', 3), '2027-01-02');
  assert.equal(addDaysIso('2028-02-28', 1), '2028-02-29');
  assert.equal(addDaysIso('2026-03-01', -1), '2026-02-28');
});
