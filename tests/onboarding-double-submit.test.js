'use strict';

// Red-first regression for the onboarding submit race: submit() had no
// in-flight guard, so two activations in the same tick (a double-click on
// Next, or Next followed by Skip before the first await resumes) both read
// the same question index, both resumed, and the interview jumped a question
// while answering the first one twice. The ask view's one-ask-at-a-time guard
// is the established pattern for exactly this shape.

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

test('a double-click on Next answers the question once and advances one question', async () => {
  const byId = buildDom();
  const log = { completed: 0, shown: [], answers: [] };
  await loadRenderer(log);
  assert.match(byId['ob-prompt'].textContent, /What should I call you/);
  byId['ob-next'].click();
  byId['ob-next'].click(); // second activation lands before the first await resumes
  await flush();
  assert.equal(log.answers.length, 1, 'the first question is answered exactly once');
  assert.match(byId['ob-prompt'].textContent, /What are you working toward/, 'the interview advances exactly one question');
});

test('Next followed by Skip in the same tick advances one question, not two', async () => {
  const byId = buildDom();
  const log = { completed: 0, shown: [], answers: [] };
  await loadRenderer(log);
  byId['ob-next'].click();
  byId['ob-skip'].click();
  await flush();
  assert.equal(log.answers.length, 1, 'the answered question is saved once');
  assert.match(byId['ob-prompt'].textContent, /What are you working toward/, 'no question is skipped');
});

test('Enter and a Next click in the same tick submit once', async () => {
  const byId = buildDom();
  const log = { completed: 0, shown: [], answers: [] };
  await loadRenderer(log);
  const field = byId['ob-input'].children[0];
  field.value = 'Asha';
  field.fire('keydown', { key: 'Enter', preventDefault() {} });
  byId['ob-next'].click();
  await flush();
  assert.equal(log.answers.length, 1, 'Enter plus Next is one submission');
  assert.match(byId['ob-prompt'].textContent, /What are you working toward/);
});
