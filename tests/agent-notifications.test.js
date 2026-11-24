'use strict';

// Gate 2 slice 4: notifications tool tests. Pure record queue only; no
// delivery surface exists to test because none exists in the module.

const test = require('node:test');
const assert = require('node:assert');
const { createNotificationDesk, MAX_QUEUE } = require('../src/agent-notifications.js');

test('a valid notification record is created with a shaped id and defaults', () => {
  const desk = createNotificationDesk({ clock: () => 1_700_000_000_000 });
  const r = desk.create({ title: 'Build finished', body: 'Gate 2 slice 4 is green' });
  assert.equal(r.ok, true);
  assert.equal(r.notification.id, 'ntf-000001');
  assert.equal(r.notification.priority, 'normal');
  assert.equal(r.notification.read, false);
  assert.equal(r.notification.createdAt, 1_700_000_000_000);
});

test('every field is validated and nothing invalid is stored', () => {
  const desk = createNotificationDesk({ clock: () => 1_700_000_000_000 });
  assert.equal(desk.create({}).reason, 'title_invalid');
  assert.equal(desk.create({ title: 'x' }).reason, 'body_invalid');
  assert.equal(desk.create({ title: 'x'.repeat(121), body: 'b' }).reason, 'title_invalid');
  assert.equal(desk.create({ title: 't', body: 'x'.repeat(501) }).reason, 'body_invalid');
  assert.equal(desk.create({ title: 't', body: 'b', priority: 'urgent' }).reason, 'priority_invalid');
  assert.equal(desk.count(), 0);
});

test('the queue is bounded and refuses to grow past its cap', () => {
  const desk = createNotificationDesk({ clock: () => 1_700_000_000_000 });
  for (let i = 0; i < MAX_QUEUE; i += 1) {
    assert.equal(desk.create({ title: 't' + i, body: 'b' }).ok, true);
  }
  assert.equal(desk.create({ title: 'overflow', body: 'b' }).reason, 'queue_full');
  assert.equal(desk.count(), MAX_QUEUE);
});

test('list and pending return copies, and markRead and remove work', () => {
  const desk = createNotificationDesk({ clock: () => 1_700_000_000_000 });
  desk.create({ title: 'a', body: 'b' });
  desk.create({ title: 'c', body: 'd', priority: 'high' });
  const listed = desk.list();
  assert.equal(listed.length, 2);
  listed[0].title = 'mutated';
  assert.equal(desk.list()[0].title, 'a', 'the caller cannot reach the stored records');
  assert.equal(desk.pending().length, 2);
  assert.equal(desk.markRead('ntf-000001').ok, true);
  assert.equal(desk.pending().length, 1);
  assert.equal(desk.markRead('ntf-999999').reason, 'notification_unknown');
  assert.equal(desk.remove('ntf-000002').ok, true);
  assert.equal(desk.count(), 1);
  assert.equal(desk.remove('ntf-000002').reason, 'notification_unknown');
});
