'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Store = require('../experiments/memory-v2-harness/lib/store');
const productMemory = require('../src/memory');

const MD = [
  '# About me', '',
  'Written by you and CompanionDesk. Edit it, add lines, or delete any line to',
  'make CompanionDesk forget it. Nothing in this file leaves your computer unless',
  'you turn that on in settings.', '',
  '## Facts', '', '- Morning run at 6:30 on weekdays, rest day Sunday.', '',
  '## Routines', '', '- Lights out by midnight on weekdays.', '',
].join('\n');

test('store roundtrip: parse -> toMarkdown -> parse is identical', () => {
  const a = Store.parseMarkdown(MD);
  const b = Store.parseMarkdown(Store.createStore(a).toMarkdown());
  assert.deepStrictEqual(b, a);
});

test('store markdown is consumable by the CURRENT product memory module', () => {
  // Wiring later must be a drop-in: the v2 store's canonical output has to
  // be readable AND editable by src/memory.js unchanged.
  const st = Store.createStore(Store.parseMarkdown(MD));
  const md = st.toMarkdown();
  assert.deepStrictEqual(productMemory.parse(md), [
    { section: 'Facts', text: 'Morning run at 6:30 on weekdays, rest day Sunday.' },
    { section: 'Routines', text: 'Lights out by midnight on weekdays.' },
  ]);
  const added = productMemory.addBullet(md, 'Preferences', 'Prefers trains over flights.');
  assert.ok(added.added);
  assert.ok(productMemory.parse(added.text).some((b) => b.section === 'Preferences' && b.text === 'Prefers trains over flights.'));
  const removed = productMemory.removeBullet(added.text, 'Preferences', 'Prefers trains over flights.');
  assert.ok(removed.removed);
});

test('sanitize contract matches the product implementation', () => {
  const cases = ['  ## sneaky heading\n- line  ', 'plain text', 'x'.repeat(500), '', '   ', '*- bullet-ish lead'];
  for (const c of cases) assert.strictEqual(Store.sanitizeBullet(c), productMemory.sanitizeBullet(c), JSON.stringify(c.slice(0, 40)));
});

test('addMemory mirrors product semantics: unknown_section, empty, duplicate, ok', () => {
  const st = Store.createStore(Store.parseMarkdown(MD));
  assert.strictEqual(st.addMemory('Nowhere', 'x').error, 'unknown_section');
  assert.strictEqual(st.addMemory('Facts', '   ').error, 'empty');
  assert.strictEqual(st.addMemory('Facts', 'Morning run at 6:30 on weekdays, rest day SUNDAY.').error, 'duplicate');
  const res = st.addMemory('Facts', 'Keeps a paper notebook for weekly planning.');
  assert.ok(res.ok && res.id === 'm3');
  // duplicate is judged WITHIN the target section only, like the product
  assert.ok(st.addMemory('Goals', 'Morning run at 6:30 on weekdays, rest day Sunday.').ok);
});

test('consent gate: sensitive bullets stay hidden until explicitly included', () => {
  const st = Store.createStore(Store.parseMarkdown(MD, { sensitiveIds: ['m1'] }));
  const hidden = st.search('morning run', { task: 'chat' }).map((r) => r.id);
  assert.ok(!hidden.includes('m1'), 'sensitive bullet hidden by default');
  const open = st.search('morning run', { task: 'chat', includeSensitive: true }).map((r) => r.id);
  assert.ok(open.includes('m1'), 'explicit consent surfaces it');
  assert.ok(st.markSensitive('m1', false).ok);
  assert.ok(st.search('morning run', { task: 'chat' }).some((r) => r.id === 'm1'));
  assert.ok(!st.toMarkdown().includes('sensitive'), 'the markdown file never carries the flag: that convention is an open decision');
});

test('forget semantics: removed bullet disappears everywhere', () => {
  const st = Store.createStore(Store.parseMarkdown(MD));
  assert.ok(st.forgetMemory('m1').ok);
  assert.strictEqual(st.forgetMemory('m1').error, 'not_found');
  assert.strictEqual(st.count(), 1);
  assert.ok(!st.search('morning run', { task: 'chat' }).some((r) => r.text.includes('Morning run')));
  assert.ok(!st.toMarkdown().includes('Morning run'));
});

test('task budgets hold through the store: vision 0, screen small, chat bounded', () => {
  const lines = [];
  for (let i = 1; i <= 30; i++) lines.push(`- fact number ${i} about the workspace`);
  const md = MD.replace('## Facts\n', `## Facts\n\n${lines.join('\n')}\n`);
  const st = Store.createStore(Store.parseMarkdown(md));
  assert.strictEqual(st.search('fact number', { task: 'vision' }).length, 0);
  assert.ok(st.search('fact number', { task: 'screen' }).length <= 6);
  assert.ok(st.search('fact number', { task: 'chat' }).length <= 12);
});

test('retrieval is deterministic across identical stores', () => {
  const a = Store.createStore(Store.parseMarkdown(MD));
  const b = Store.createStore(Store.parseMarkdown(MD));
  assert.deepStrictEqual(a.search('morning schedule', { task: 'screen' }), b.search('morning schedule', { task: 'screen' }));
});

test('extra (non-canonical) headings survive roundtrip in first-seen order', () => {
  const md = MD + '\n## Work\n\n- Standup at 9:30.\n';
  const st = Store.createStore(Store.parseMarkdown(md));
  const out = st.toMarkdown();
  assert.ok(out.indexOf('## Work') > out.indexOf('## Routines'), 'extra section trails canonical ones');
  assert.deepStrictEqual(productMemory.parse(out).filter((b) => b.section === 'Work'),
    [{ section: 'Work', text: 'Standup at 9:30.' }]);
});
