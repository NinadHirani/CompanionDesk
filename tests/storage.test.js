'use strict';

const test = require('node:test');
const assert = require('node:assert');
const LocalDb = require('../src/db');

// The pluggable storage adapter the web/mobile build uses (IndexedDB in the
// browser is swapped for a fake here) must persist across reopen exactly like
// the desktop file.
test('storage adapter persists the database across reopen', async () => {
  let saved = null;
  const storage = {
    load: async () => saved,
    save: async (bytes) => { saved = bytes; },
  };

  const db1 = await LocalDb.open({ storage });
  const id = db1.upsertCourse({ name: 'Quantum Computing', code: 'CS402' });
  db1.addAssignment(id, { title: 'PS1', due_date: '2026-11-01' });
  db1.flush();
  assert.ok(saved && saved.length > 0);

  const db2 = await LocalDb.open({ storage });
  const course = db2.listCourses()[0];
  assert.equal(course.name, 'Quantum Computing');
  const rows = db2.listAssignments(course.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'PS1');
  assert.equal(rows[0].due_date, '2026-11-01');
});

test('in-memory open still works and never persists', async () => {
  const db = await LocalDb.open();
  const id = db.upsertCourse({ name: 'X' });
  db.addAssignment(id, { title: 'T' });
  assert.equal(db.counts().courses, 1);
});
