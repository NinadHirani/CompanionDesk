'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { computePatterns, describePatterns, MIN_SAMPLES } = require('../src/patterns');

const ev = (due, doneOn) => ({ due_date: due, at: `${doneOn}T21:30:00` });

test('fewer than three finished items says nothing', () => {
  assert.equal(MIN_SAMPLES, 3);
  const p = computePatterns([ev('2026-11-10', '2026-11-05'), ev('2026-11-12', '2026-11-08')]);
  assert.equal(p.samples, 2);
  assert.equal(p.style, null);
  assert.equal(p.medianLeadDays, null);
  assert.equal(describePatterns(p), null);
});

test('early finisher: median lead of three days or more', () => {
  const p = computePatterns([ev('2026-11-10', '2026-11-05'), ev('2026-11-12', '2026-11-08'), ev('2026-11-20', '2026-11-15')]);
  assert.equal(p.medianLeadDays, 5);
  assert.equal(p.style, 'early');
  assert.equal(describePatterns(p), 'Usually finishes work about 5 days before it is due (from 3 items marked done).');
});

test('steady versus last-minute boundaries', () => {
  const lead = (n) => ev('2026-11-10', `2026-11-${String(10 - n).padStart(2, '0')}`);
  assert.equal(computePatterns([lead(1), lead(1), lead(1)]).style, 'steady');
  assert.equal(computePatterns([lead(2), lead(2), lead(2)]).style, 'steady');
  assert.equal(computePatterns([lead(3), lead(3), lead(3)]).style, 'early');
  assert.equal(computePatterns([lead(0), lead(0), lead(0)]).style, 'last-minute');
});

test('finishing after the due date counts as late and pulls the median down', () => {
  const p = computePatterns([ev('2026-11-10', '2026-11-11'), ev('2026-11-10', '2026-11-10'), ev('2026-11-10', '2026-11-12')]);
  assert.equal(p.lateCount, 2);
  assert.equal(p.style, 'last-minute');
  assert.match(describePatterns(p), /on the day it is due/);
});

test('uses the local calendar day in the timestamp, not UTC', () => {
  // Marked done at 00:30 local on Nov 4 for something due Nov 4: lead 0, not 1.
  const p = computePatterns([
    { due_date: '2026-11-04', at: '2026-11-04T00:30:00' },
    { due_date: '2026-11-04', at: '2026-11-04T00:31:00' },
    { due_date: '2026-11-04', at: '2026-11-04T00:32:00' },
  ]);
  assert.equal(p.medianLeadDays, 0);
});

test('rows with missing or malformed dates are skipped, never guessed', () => {
  const p = computePatterns([
    { due_date: null, at: '2026-11-04T10:00:00' },
    { due_date: '2026-11-10', at: 'garbage' },
    { due_date: 'soon', at: '2026-11-04T10:00:00' },
    ev('2026-11-10', '2026-11-05'),
  ]);
  assert.equal(p.samples, 1);
  assert.equal(p.style, null);
  assert.deepEqual(computePatterns(undefined), { samples: 0, medianLeadDays: null, lateCount: 0, style: null });
});
