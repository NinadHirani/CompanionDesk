'use strict';

// Gate 2 slice 4: reminders tool tests. Pure record book only; nothing
// fires and no timers exist to test because none exist in the module.

const test = require('node:test');
const assert = require('node:assert');
const { createReminderBook, MAX_BOOK } = require('../src/agent-reminders.js');

test('a valid reminder is created with a shaped id and validated fields', () => {
  const book = createReminderBook({ clock: () => 1_000 });
  const r = book.create({ title: 'Standup', dueAt: 2_000, notes: 'prep notes' });
  assert.equal(r.ok, true);
  assert.equal(r.reminder.id, 'rem-000001');
  assert.equal(r.reminder.cancelled, false);
  assert.equal(r.reminder.notes, 'prep notes');
});

test('every field is validated; a past dueAt is refused', () => {
  const book = createReminderBook({ clock: () => 1_000 });
  assert.equal(book.create({}).reason, 'title_invalid');
  assert.equal(book.create({ title: 't', dueAt: 'soon' }).reason, 'due_at_invalid');
  assert.equal(book.create({ title: 't', dueAt: 1_000 }).reason, 'due_at_past');
  assert.equal(book.create({ title: 't', dueAt: 2_000, notes: 42 }).reason, 'notes_invalid');
  assert.equal(book.create({ title: 'x'.repeat(121), dueAt: 2_000 }).reason, 'title_invalid');
  assert.equal(book.count(), 0);
});

test('the book is bounded and refuses to grow past its cap', () => {
  const book = createReminderBook({ clock: () => 1_000 });
  for (let i = 0; i < MAX_BOOK; i += 1) {
    assert.equal(book.create({ title: 't' + i, dueAt: 10_000 + i }).ok, true);
  }
  assert.equal(book.create({ title: 'overflow', dueAt: 999_999 }).reason, 'book_full');
});

test('list sorts soonest first and due() reads without firing', () => {
  const book = createReminderBook({ clock: () => 1_000 });
  book.create({ title: 'late', dueAt: 3_000 });
  book.create({ title: 'early', dueAt: 2_000 });
  assert.equal(book.list()[0].title, 'early');
  assert.equal(book.due(1_999).length, 0);
  assert.deepEqual(book.due(2_000).map((r) => r.title), ['early']);
  assert.deepEqual(book.due(5_000).map((r) => r.title), ['early', 'late']);
});

test('cancel, acknowledge and remove are reversible record operations', () => {
  const book = createReminderBook({ clock: () => 1_000 });
  book.create({ title: 'a', dueAt: 2_000 });
  book.create({ title: 'b', dueAt: 3_000 });
  assert.equal(book.cancel('rem-000001').ok, true);
  assert.deepEqual(book.due(9_999).map((r) => r.title), ['b'], 'a cancelled reminder never comes due');
  assert.equal(book.acknowledge('rem-000002').ok, true);
  assert.deepEqual(book.due(9_999), [], 'an acknowledged reminder leaves the due list');
  assert.equal(book.remove('rem-000001').ok, true);
  assert.equal(book.count(), 1);
  assert.equal(book.cancel('rem-999999').reason, 'reminder_unknown');
});
