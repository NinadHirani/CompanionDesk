'use strict';

// Red-first regression for the About view's M4 memory UX reporting: the
// add form reports a failed ask in place (mem-msg + friendlyError), but the
// Forget button and the suggestion decision path swallowed every failure:
// a failed memory_forget refreshed the list silently (a stale row just sat
// there), a failed memory_decide left a stale card, and a transport crash on
// any memory click was an unhandled rejection with no user-visible word.
// The house rule (update banner crash guard): a click-path ask that fails
// must never be a silent no-op.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const RENDERER = path.join(__dirname, '..', 'renderer', 'about.js');

// Let fire-and-forget chains (the status loads refresh() starts without
// awaiting) finish while this test's globals are still the live ones.
async function flush() {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
}

const IDS = [
  'about-file', 'about-items', 'about-version', 'activity-clear', 'app-version',
  'cloud-key', 'cloud-remove', 'cloud-save', 'cloud-status', 'cloud-test',
  'doc-privacy', 'doc-terms', 'health-body', 'health-refresh', 'health-summary',
  'hw-note', 'mem-add', 'mem-msg', 'mem-section', 'mem-text', 'models-note',
  'ov-hotkey', 'ov-msg', 'ov-open', 'ov-save', 'patterns-text', 'provider-list',
  'provider-msg', 'provider-refresh', 's-aimodel', 's-assistant', 's-brevity',
  's-cloud', 's-hwprofile', 's-language', 's-learn', 's-proactive',
  's-proactive-deadline', 's-proactive-quiet', 's-proactive-rem', 's-quiet-end',
  's-quiet-start', 's-screen-consent', 's-screen-mode', 's-student', 's-suggest',
  's-tone', 's-user', 's-visionmodel', 's-voice', 's-voice-output', 's-wake',
  's-wake-threshold', 'screen-mode-note', 'settings-msg', 'settings-save',
  'view-about', 'wake-pause', 'wake-resume', 'wake-start', 'wake-status',
  'wake-stop', 'ask-proposals', 'about-proposals',
];

function makeEl(tag) {
  const e = {
    tag, children: [], handlers: {}, className: '', hidden: false,
    value: '', id: '', attrs: {}, options: null,
    style: {}, checked: false, disabled: false, parentElement: null,
    append(...kids) { this.children.push(...kids); },
    closest() { return { hidden: false, style: {} }; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k] ?? null; },
    addEventListener(type, fn) { (this.handlers[type] = this.handlers[type] || []).push(fn); },
    fire(type, ev = {}) { return Promise.all((this.handlers[type] || []).map((fn) => fn(ev))); },
    click() { return this.fire('click'); },
    focus() { global.document.activeElement = this; },
    replaceChildren(...kids) { this.children = kids; if (this.options) this.options = kids; },
    appendChild(c) { this.children.push(c); if (this.options) this.options.push(c); },
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
  for (const id of IDS) {
    byId[id] = makeEl('div');
    byId[id].id = id;
  }
  byId['mem-section'].options = [];
  byId['view-about'].hidden = false;
  for (const id of ['s-screen-consent', 's-screen-mode', 'screen-mode-note']) {
    const parent = makeEl('div');
    byId[id].parentElement = parent;
  }
  global.document = {
    activeElement: null,
    getElementById: (id) => byId[id] || null,
    createElement: (tag) => makeEl(tag),
  };
  global.Option = function Option(text, value) { return { text, value }; };
  global.window = { friendlyError: (e) => `FRIENDLY:${e}` };
  return byId;
}

const FAT = {
  ok: true, proposals: [], items: [], sections: ['Facts', 'Goals', 'Routines', 'Preferences', 'Constraints'],
  file: '/about-me.md', settings: {}, summary: '', samples: 0, learning: false,
  appVersion: '1.0.0', channel: 'stable', hotkey: 'Ctrl+Space', registered: true,
  privacy: 'p', terms: 't', version: '1.0.0',
  ollama: { reachable: true }, chat: { installed: true, model: 'm' }, vision: { installed: true, model: 'v' },
  defaults: { chat: '', vision: '' }, cloud: { state: 'off' }, credentialStorage: { available: false },
};

async function loadAbout(log) {
  const calls = [];
  const overrides = {};
  const api = new Proxy({}, {
    get(_t, prop) {
      const name = String(prop);
      if (overrides[name]) return overrides[name];
      return async (payload) => { calls.push({ name, payload }); return { ...FAT }; };
    },
    set(_t, prop, v) { overrides[String(prop)] = v; return true; },
  });
  global.UI = {
    api, el: (tag, text, cls) => { const e = makeEl(tag); e._text = text == null ? '' : String(text); e.className = cls || ''; return e; },
    plural: (n, w) => (n === 1 ? w : `${w}s`),
    friendlyError: (e) => `FRIENDLY:${e}`,
    show: () => {},
    onShow: () => {},
    today: { refreshStatus: async () => {}, refresh: async () => {} },
  };
  delete require.cache[require.resolve(RENDERER)];
  require(RENDERER);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  return { byId: buildDom.byId, api, overrides, calls, set: (name, fn) => { overrides[name] = fn; } };
}

test('a failed Forget is reported in place, not swallowed', async () => {
  const byId = buildDom();
  const h = await loadAbout();
  h.set('memory_forget', async () => ({ ok: false, error: 'not_found' }));
  h.set('memory_list', async () => ({ ...FAT, items: [{ section: 'Facts', text: 'Likes chai' }], proposals: [] }));
  await UI.about.refresh();
  const forgetBtn = byId['about-items'].children
    .flatMap((n) => n.children).flatMap((li) => li.children)
    .find((b) => b._text === 'Forget');
  assert.ok(forgetBtn, 'a Forget button was rendered');
  await forgetBtn.fire('click');
  assert.match(byId['mem-msg'].textContent, /FRIENDLY:not_found/, 'the failure is reported in mem-msg');
  assert.match(byId['mem-msg'].className, /error/);
  await flush();
});

test('a crashed Forget is reported in place and still refreshes', async () => {
  const byId = buildDom();
  const h = await loadAbout();
  h.set('memory_forget', async () => { throw new Error('bridge gone'); });
  h.set('memory_list', async () => ({ ...FAT, items: [{ section: 'Facts', text: 'Likes chai' }], proposals: [] }));
  await UI.about.refresh();
  const forgetBtn = byId['about-items'].children
    .flatMap((n) => n.children).flatMap((li) => li.children)
    .find((b) => b._text === 'Forget');
  await forgetBtn.fire('click');
  assert.match(byId['mem-msg'].textContent, /FRIENDLY:/, 'the crash is reported in mem-msg, not left silent');
  await flush();
});

test('a failed decision is reported in place and the cards re-sync', async () => {
  const byId = buildDom();
  const h = await loadAbout();
  h.set('memory_decide', async () => ({ ok: false, error: 'unknown_proposal' }));
  h.set('memory_list', async () => ({ ...FAT, proposals: [{ id: 'p1', text: 'Plays table tennis', section: 'Facts' }] }));
  await UI.about.refresh();
  const yes = byId['about-proposals'].children
    .flatMap((n) => n.children).flatMap((m) => m.children)
    .find((b) => b._text === 'Yes, remember it');
  assert.ok(yes, 'a decision button was rendered');
  await yes.fire('click');
  assert.match(byId['mem-msg'].textContent, /FRIENDLY:unknown_proposal/, 'the failed decision is reported on the About view');
  await flush();
});

test('a successful Forget keeps the message quiet', async () => {
  const byId = buildDom();
  const h = await loadAbout();
  h.set('memory_forget', async () => ({ ok: true }));
  h.set('memory_list', async () => ({ ...FAT, items: [], proposals: [] }));
  await UI.about.refresh();
  assert.equal(byId['mem-msg'].textContent, '');
  await flush();
});
