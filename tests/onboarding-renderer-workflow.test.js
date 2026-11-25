'use strict';

// Drives the real renderer/onboarding.js (an IIFE wired to a DOM) and the
// real src/onboarding.js question set through a minimal DOM stub, walking
// the flows a user performs: typing + Enter, clicking choices, arrow keys,
// skip, and the finish confirm. The node suite otherwise never executes
// renderer code; this caught the double finish-listener of 25 Nov 2026.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const RENDERER = path.join(__dirname, '..', 'renderer', 'onboarding.js');

function makeEl(tag) {
  const e = {
    tag, children: [], handlers: {}, className: '',
    hidden: false, tabIndex: -1, value: '', id: '', attrs: {},
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k] ?? null; },
    addEventListener(type, fn) { (this.handlers[type] = this.handlers[type] || []).push(fn); },
    fire(type, ev = {}) { for (const fn of this.handlers[type] || []) fn(ev); },
    click() { this.fire('click'); },
    focus() { this._focused = true; global.document.activeElement = this; },
    replaceChildren(...kids) { this.children = kids; },
    appendChild(c) { this.children.push(c); },
    classList: { toggle() {} },
  };
  Object.defineProperty(e, 'textContent', {
    get() { return this._text ?? ''; },
    set(v) { this._text = String(v); },
    configurable: true,
  });
  return e;
}

function buildDom() {
  const byId = {};
  for (const id of ['ob-prompt', 'ob-input', 'ob-progress', 'ob-msg', 'ob-next', 'ob-skip', 'ob-finish']) {
    byId[id] = makeEl('div');
    byId[id].id = id;
  }
  global.document = {
    activeElement: null,
    getElementById: (id) => byId[id] || null,
    createElement: (tag) => makeEl(tag),
  };
  return byId;
}

// One fresh IIFE per test: delete the require cache so renderer/onboarding.js
// re-executes against this test's DOM and UI.
function loadRenderer(log) {
  global.UI = {
    el: (tag, text, cls) => { const e = makeEl(tag); e._text = text == null ? '' : String(text); e.className = cls || ''; return e; },
    friendlyError: (e) => e,
    today: { refresh: async () => {} },
    show: (v) => log.shown.push(v),
    api: {
      onboarding_get: async () => ({ ok: true, done: false, questions: QUESTIONS }),
      onboarding_answer: async (p) => { log.answers.push(p); return { ok: true, skipped: true }; },
      onboarding_complete: async () => { log.completed += 1; return { ok: true }; },
    },
  };
  const rp = require.resolve(RENDERER);
  delete require.cache[rp];
  require(rp);
  return global.UI.onboarding.start().then((started) => {
    assert.equal(started, true);
    return global.document;
  });
}

const flush = () => new Promise((r) => setTimeout(r, 5));
const { QUESTIONS } = require('../src/onboarding');

test('typing a name and pressing Enter submits it and advances', async () => {
  const byId = buildDom();
  const log = { completed: 0, shown: [], answers: [] };
  await loadRenderer(log);
  assert.equal(byId['ob-progress'].textContent, 'Question 1 of 7. Every one can be skipped.');
  assert.equal(byId['ob-prompt'].textContent, 'What should I call you?');
  const field = byId['ob-input'].children[0];
  assert.equal(field.tag, 'input');
  assert.equal(global.document.activeElement, field, 'text field focused on render');
  field.value = 'Asha';
  field.fire('keydown', { key: 'Enter', preventDefault() {} });
  await flush();
  assert.equal(log.answers[0].id, 'name');
  assert.match(byId['ob-prompt'].textContent, /What are you working toward/);
});

test('choice questions: click selects, arrows navigate, Next submits', async () => {
  const byId = buildDom();
  const log = { completed: 0, shown: [], answers: [] };
  await loadRenderer(log);
  for (let i = 0; i < 3; i++) { byId['ob-skip'].click(); await flush(); } // name, goal, hours
  assert.match(byId['ob-prompt'].textContent, /When do you work best/);
  const group = byId['ob-input'].children[0];
  assert.equal(group.getAttribute('role'), 'radiogroup');
  assert.equal(group.children.length, 5);
  assert.equal(group.children[0].tabIndex, 0, 'first option is the tab stop');
  assert.equal(global.document.activeElement, group.children[0], 'first option focused on choice render');
  group.children[1].click();
  assert.equal(group.children[1].getAttribute('aria-checked'), 'true');
  assert.equal(group.children[0].getAttribute('aria-checked'), 'false');
  assert.equal(group.children[1].tabIndex, 0, 'chosen option becomes the tab stop');
  assert.equal(global.document.activeElement, byId['ob-next'], 'focus moves to Next after choosing');
  global.document.activeElement = group.children[0];
  group.fire('keydown', { key: 'ArrowDown', preventDefault() {} });
  assert.equal(group.children[1].getAttribute('aria-checked'), 'true', 'arrow key selects');
  assert.equal(global.document.activeElement, group.children[1], 'focus stays on the option after arrow nav');
  group.fire('keydown', { key: 'ArrowDown', preventDefault() {} });
  group.fire('keydown', { key: 'ArrowDown', preventDefault() {} });
  assert.equal(group.children[3].getAttribute('aria-checked'), 'true');
  assert.equal(group.children[0].getAttribute('aria-checked'), 'false');
  group.children[3].click();
  byId['ob-next'].click(); await flush();
  assert.equal(log.answers.at(-1).answer, 'Late at night');
});

test('the privacy step renders heading + body and completes the interview', async () => {
  const byId = buildDom();
  const log = { completed: 0, shown: [], answers: [] };
  await loadRenderer(log);
  for (let i = 0; i < 6; i++) { byId['ob-skip'].click(); await flush(); } // through the style question
  assert.equal(byId['ob-prompt'].textContent, 'Last one: your privacy defaults');
  const body = byId['ob-input'].children[0];
  assert.equal(body.tag, 'p');
  assert.match(body.textContent, /^It changes nothing by itself\./);
  const group = byId['ob-input'].children[1];
  assert.equal(group.children.length, 2);
  group.children[0].click();
  assert.equal(global.document.activeElement, byId['ob-next']);
  byId['ob-next'].click(); await flush();
  assert.equal(log.completed, 1, 'interview completes after the last question');
  assert.deepEqual(log.shown, ['today']);
});

test('skip-the-rest needs a confirming second click; advancing disarms it', async () => {
  const byId = buildDom();
  const log = { completed: 0, shown: [], answers: [] };
  await loadRenderer(log);
  const f = byId['ob-finish'];
  f.click();
  assert.equal(f.textContent, 'Really skip the rest?', 'first click asks');
  assert.equal(log.completed, 0, 'first click does not end the interview');
  byId['ob-next'].click(); await flush(); // answering disarms
  assert.equal(f.textContent, 'Skip the rest', 'advancing disarms the confirm');
  f.click();
  assert.equal(log.completed, 0);
  f.click(); await flush();
  assert.equal(log.completed, 1, 'second consecutive click confirms');
  assert.deepEqual(log.shown, ['today']);
});
