'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const read = (f) => fs.readFileSync(f, 'utf8');

test('the ask log renders in chat order, newest last, and scrolls to it', () => {
  const s = read('renderer/ask.js');
  assert.ok(!s.includes('log.prepend'), 'no prepending: the thread must stay in chat order');
  assert.ok(s.includes('log.appendChild(entry)'), 'messages append');
  assert.ok(!s.includes('.reverse()'), 'history is rendered oldest-first, no reversal');
  assert.ok(s.includes('scrollToLatest()'), 'the view scrolls to the newest message');
  assert.ok(s.includes("m.role === 'user' ? 'q' : 'answer'"), 'roles map to bubbles');
});

test('answers carry the companion name label from the assistant_name setting', () => {
  const s = read('renderer/ask.js');
  assert.ok(s.includes("document.body.dataset.companionName"), 'label reads the live companion name');
  assert.ok(s.includes("cls === 'answer'"), 'only answers get the label, questions do not');
});

test('Enter sends and Shift+Enter makes a new line', () => {
  const s = read('renderer/ask.js');
  const i = s.indexOf("input.addEventListener('keydown'");
  assert.ok(i > 0);
  const chunk = s.slice(i, i + 300);
  assert.ok(chunk.includes("e.key !== 'Enter' || e.shiftKey"), 'plain Enter sends, Shift+Enter newlines');
});

test('app.js applyIdentity feeds the companion name to the thread and the tab', () => {
  const s = read('renderer/app.js');
  assert.ok(s.includes('document.body.dataset.companionName = name'), 'dataset set for ask.js');
  assert.ok(s.includes("button[data-view=\"ask\"]"), 'the Ask tab is updated');
  assert.ok(s.includes("? 'Ask' : name"), 'the tab falls back to Ask for the default name');
});

test('styles ship the chat bubbles and the small-screen layout', () => {
  const css = read('renderer/styles.css');
  assert.ok(css.includes('.qa .q') && css.includes('align-self: flex-end'), 'question bubble on the right');
  assert.ok(css.includes('.qa .who'), 'companion name label style');
  assert.ok(css.includes('@media (max-width: 640px)'), 'responsive block exists');
  const media = css.slice(css.indexOf('@media (max-width: 640px)'));
  assert.ok(media.includes('.tabs') && media.includes('overflow-x: auto'), 'tabs scroll on phones');
  assert.ok(media.includes('#ask-conv-bar'), 'conversation bar wraps on phones');
});

test('the thinking indicator and the Ask heading carry the companion name', () => {
  const ask = read('renderer/ask.js');
  assert.ok(ask.includes('is thinking`'), 'the pending hint names the companion');
  assert.ok(!ask.includes("'Thinking'"), 'no bare Thinking label left');
  const html = read('renderer/index.html');
  assert.ok(html.includes('id="ask-heading"'), 'the Ask heading is addressable');
  const app = read('renderer/app.js');
  assert.ok(app.includes("getElementById('ask-heading')"), 'the heading follows the name');
  const ov = read('renderer/overlay.js');
  assert.ok(ov.includes('state_get()'), 'the overlay reads the companion name from state');
  assert.ok(ov.includes("typeof thinking === 'function' ? thinking() : thinking"), 'thinking hints can be computed');
  assert.ok(ov.includes('is thinking`'), 'the overlay thinking hint names the companion');
});

test('the app opens on the companion chat once setup is done', () => {
  const boot = read('renderer/boot.js');
  assert.ok(boot.includes("needsSetup ? 'onboarding' : 'ask'"), 'ready state lands on the chat');
  const ob = read('renderer/onboarding.js');
  assert.ok(ob.includes("UI.show('ask')"), 'finishing setup ends in the chat');
});

test("the Today brief opens in the companion's voice", () => {
  const app = read('renderer/app.js');
  assert.ok(app.includes("'companion-lead'"), 'brief renders a companion lead line');
  assert.ok(app.includes("dataset.companionName"), 'the lead uses the companion name');
  assert.ok(app.includes("${cname} here."), 'the lead names the companion');
  const css = read('renderer/styles.css');
  assert.ok(css.includes('.companion-lead'), 'the lead line has a style');
});

test('the open conversation title is visible in the chat header', () => {
  const ask = read('renderer/ask.js');
  assert.ok(ask.includes('function updateSub'), 'ask.js keeps the title line in step');
  assert.ok(ask.includes("getElementById('ask-sub')"), 'the title targets ask-sub');
  for (const p of ['renderer/index.html', 'web/index.html']) {
    assert.ok(read(p).includes('id="ask-sub"'), p + ' carries the ask-sub element');
  }
  const css = read('renderer/styles.css');
  assert.ok(css.includes('.ask-sub'), 'the title line has a style');
});

test('a fresh ask opts into persistence, and a declined consent cleans up', () => {
  const ask = read('renderer/ask.js');
  assert.ok(ask.includes('api.chat_new()'), 'a fresh ask creates its thread first');
  assert.ok(ask.includes('conversation_id: currentId'), 'the ask runs inside that thread');
  assert.ok(ask.includes('api.chat_delete({ id: emptyId })'), 'a declined cloud consent removes the empty thread');
  assert.ok(ask.includes('input.value = question'), 'the declined question returns to the input');
});
