'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { courseStanding, neededForTarget } = require('../src/grades');

const WEIGHTS = [
  { category: 'Problem Sets', weight_pct: 20 },
  { category: 'Midterm', weight_pct: 30 },
  { category: 'Final', weight_pct: 50 },
];
const A = (id, title, category) => ({ id, title, category });

test('nothing graded yet: no current grade, everything remaining', () => {
  const s = courseStanding({ weights: WEIGHTS, assignments: [A(1, 'PS1', 'Problem Sets'), A(2, 'Midterm', 'Midterm')], scores: {} });
  assert.equal(s.weightsComplete, true);
  assert.equal(s.currentPct, null);
  assert.equal(s.gradedWeight, 0);
  assert.equal(s.remainingWeight, 100);
});

test('items in a category share its weight equally, and partial categories work', () => {
  // Problem Sets is 20% over 4 items: 5% each. Two graded: 80 and 100.
  const assignments = [1, 2, 3, 4].map((i) => A(i, `PS${i}`, 'Problem Sets')).concat([A(5, 'Midterm', 'Midterm')]);
  const s = courseStanding({ weights: WEIGHTS, assignments, scores: { 1: 80, 2: 100 } });
  assert.equal(s.gradedWeight, 10);
  assert.equal(s.earnedPoints, 9); // 5% * 0.8 + 5% * 1.0 = 4 + 5
  assert.equal(s.currentPct, 90);
  assert.equal(s.remainingWeight, 90);
});

test('categories match ignoring case and spacing; other categories are never guessed into', () => {
  const s = courseStanding({
    weights: WEIGHTS,
    assignments: [A(1, 'Midterm exam', ' midterm '), A(2, 'Pop quiz', 'Quizzes')],
    scores: { 1: 70, 2: 100 },
  });
  assert.equal(s.gradedWeight, 30);
  assert.equal(s.earnedPoints, 21);
  assert.deepEqual(s.unweighted, ['Pop quiz'], 'a score with no weighted category is reported, not folded in');
});

test('weights that do not add up to 100 block projection', () => {
  const s = courseStanding({ weights: [{ category: 'Exams', weight_pct: 60 }, { category: 'Labs', weight_pct: 20 }], assignments: [A(1, 'E1', 'Exams')], scores: { 1: 90 } });
  assert.equal(s.weightsComplete, false);
  assert.equal(s.totalWeight, 80);
  assert.deepEqual(neededForTarget(s, 90), { status: 'cannot_project', reason: 'weights_incomplete' });
  assert.equal(s.currentPct, 90, 'the standing on graded work is still honest');
  // Tiny rounding slack is fine.
  assert.equal(courseStanding({ weights: [{ category: 'A', weight_pct: 33.3 }, { category: 'B', weight_pct: 33.3 }, { category: 'C', weight_pct: 33.4 }], assignments: [], scores: {} }).weightsComplete, true);
});

test('needed score on the rest: reachable, out of reach, secured, nothing left', () => {
  const base = { weights: WEIGHTS, assignments: [A(1, 'Midterm', 'Midterm')] };
  // Midterm (30%) scored 60 -> 18 points earned, 70% remaining.
  const s = courseStanding({ ...base, scores: { 1: 60 } });
  assert.deepEqual(neededForTarget(s, 80), { status: 'needed', needed: 88.57, reachable: true });
  assert.deepEqual(neededForTarget(s, 90), { status: 'needed', needed: 102.86, reachable: false });
  assert.deepEqual(neededForTarget(s, 10), { status: 'secured' });

  const done = courseStanding({
    weights: [{ category: 'All', weight_pct: 100 }], assignments: [A(1, 'Everything', 'All')], scores: { 1: 75 },
  });
  assert.deepEqual(neededForTarget(done, 80), { status: 'nothing_left' });
});

test('invalid targets are refused', () => {
  const s = courseStanding({ weights: WEIGHTS, assignments: [], scores: {} });
  for (const bad of [NaN, -1, 101, undefined, '90']) {
    assert.deepEqual(neededForTarget(s, bad), { status: 'cannot_project', reason: 'invalid_target' });
  }
});
