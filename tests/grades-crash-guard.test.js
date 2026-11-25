'use strict';
// The Grades tab's four channel calls (grades_get on load, setTarget,
// setScore, setCategory on commit) are all awaited bare: a bridge or
// transport crash is an unhandled rejection, shows nothing, and leaves
// the tab stale with zero feedback. Every other ask path in the app
// reports in place; the grades tab must too.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const s = fs.readFileSync('renderer/grades.js', 'utf8');

function fnBody(src, marker) {
  const i = src.indexOf(marker);
  assert.ok(i > -1, `${marker} exists`);
  const end = src.indexOf('\n  }', i);
  return src.slice(i, end);
}

test('a crashed grades_get is reported in place, not a silent stale tab', () => {
  const chunk = fnBody(s, 'async function refresh()');
  assert.ok(chunk.includes('try {'), 'grades_get runs inside a try');
  assert.ok(chunk.includes('catch'), 'a thrown bridge error is caught');
  assert.ok(chunk.includes('grades_load_failed'), 'the load failure renders its own wording');
});

for (const [call, label] of [
  ['grades_setTarget', 'target'],
  ['grades_setScore', 'score'],
  ['assignment_setCategory', 'category'],
]) {
  test(`a crashed ${call} reports in place and never advances`, () => {
    const i = s.indexOf(call);
    const start = s.lastIndexOf('async (v', i);
    const chunk = s.slice(start, i + 400);
    assert.ok(chunk.includes('try {'), `the ${label} call runs inside a try`);
    assert.ok(chunk.includes('catch'), `a thrown bridge error on ${label} is caught`);
  });
}
