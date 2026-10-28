'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createSkills } = require('../src/skills');

function stubDb({ courses = 0, due = [] } = {}) {
  return {
    listCourses: () => (courses ? [{ name: 'Calc', code: 'MA101' }] : []),
    listDue: () => due,
  };
}

const HELPERS = { todayIso: () => '2026-10-28', addDaysIso: () => '2026-11-04' };

test('default voice is general-purpose, not student-specific', () => {
  const skills = createSkills();
  const sys = skills.system(stubDb({ courses: 0 }));
  assert.match(sys, /general-purpose local AI companion/);
  assert.doesNotMatch(sys, /student's chief of staff/);
});

test('fresh install with no student data activates only the general skill', () => {
  const skills = createSkills();
  const active = skills.active(stubDb({ courses: 0 }));
  assert.deepEqual(active.map((s) => s.id), ['general']);
});

test('student module activates only when course data exists', () => {
  const skills = createSkills();
  const db = stubDb({ courses: 1, due: [{ due_date: '2026-11-05', title: 'HW', course_name: 'Calc', date_confidence: 'extracted' }] });
  const sys = skills.system(db);
  assert.match(sys, /chief of staff/);
  const ctx = skills.context(db, HELPERS);
  assert.ok(ctx.some((l) => l.includes('Calc (MA101)')), ctx.join('|'));
  assert.ok(ctx.some((l) => l.includes('HW')));
});

test('context pack adds no student lines on a fresh install', () => {
  const skills = createSkills();
  const ctx = skills.context(stubDb({ courses: 0 }), HELPERS);
  assert.equal(ctx.length, 0);
});

test('skills never throw on a db missing methods', () => {
  const skills = createSkills();
  const sys = skills.system({});
  assert.match(sys, /general-purpose local AI companion/);
});
