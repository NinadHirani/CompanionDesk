'use strict';
// The schedules panel's Add/Save button runs an async create/update. With
// no in-flight guard a double click enters the handler twice and creates
// two identical schedules; the codebase already enforces one-at-a-time on
// the overlay mic button for exactly this reason. The flag must release in
// finally, so a bridge crash cannot strand the button.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const s = fs.readFileSync('renderer/schedules-panel.js', 'utf8');

test('the schedules Add/Save button refuses re-entry while a submission is pending', () => {
  const i = s.indexOf("create.addEventListener('click'");
  assert.ok(i > 0, 'the create click handler exists');
  const chunk = s.slice(i, i + 1200);
  assert.ok(/if \(\s*submitting\s*\) return;/.test(chunk), 'a pending submission blocks a second click');
  assert.ok(chunk.includes('submitting = true;'), 'the flag is set before the await');
  assert.ok(chunk.includes('finally {'), 'the flag is released in finally, not only on success');
});
