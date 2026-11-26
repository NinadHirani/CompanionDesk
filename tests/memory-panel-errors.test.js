'use strict';

// Behavioral error-safety tests for the memory panel (M2/M4 UI slice,
// 26 Nov 2026), complementing the structural guard in
// tests/memory-panel-guard.test.js. The panel's contract says every
// bridge call is error-safe: a failure becomes a status line, never an
// unhandled rejection and never a retry. These tests pin two edges:
// a row action must not reject when the shaper lacks its outcome
// formatter, and a double click on a button must not fire the bridge
// call twice. A minimal DOM stub is used because the panel is plain
// browser-side code with no existing behavioral harness.

const test = require('node:test');
const assert = require('node:assert');

function makeElement(registry, tag) {
  const el = {
    tagName: tag,
    children: [],
    attrs: {},
    handlers: {},
    dataset: {},
    textContent: '',
    id: '',
    value: '',
    checked: false,
    type: '',
    disabled: false,
    appendChild(child) {
      el.children.push(child);
      if (child.id && !registry.byId.has(child.id)) registry.byId.set(child.id, child);
    },
    setAttribute(k, v) { el.attrs[k] = String(v); },
    addEventListener(name, fn) {
      (el.handlers[name] = el.handlers[name] || []).push(fn);
    },
  };
  return el;
}

function installDom() {
  const registry = { byId: new Map(), created: [], docHandlers: {} };
  global.document = {
    readyState: 'loading',
    body: makeElement(registry, 'body'),
    createElement(tag) { const e = makeElement(registry, tag); registry.created.push(e); return e; },
    getElementById(id) { return registry.byId.get(id) || null; },
    addEventListener(name, fn) { (registry.docHandlers[name] = registry.docHandlers[name] || []).push(fn); },
  };
  return registry;
}

function uninstallDom(registry) {
  delete global.document;
  delete global.window;
  registry.byId.clear();
  registry.created.length = 0;
}

function fireDOMContentLoaded(registry) {
  return Promise.all((registry.docHandlers.DOMContentLoaded || []).map((fn) => fn()));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, tries = 200) {
  for (let i = 0; i < tries; i++) {
    if (fn()) return true;
    await sleep(5);
  }
  return false;
}

function freshPanel() {
  const path = require.resolve('../renderer/memory-panel.js');
  delete require.cache[path];
  return require(path);
}

function bridgeWith(impl, log) {
  const bridge = {};
  for (const m of ['memory_items', 'memory_add', 'memory_forget', 'memory_mark', 'memory_persist', 'memory_search']) {
    bridge[m] = (...args) => { log.push(m); return Promise.resolve(impl[m] ? impl[m](...args) : { ok: true }); };
  }
  return bridge;
}

test('a row action does not reject when the shaper lacks shapeOutcome', async () => {
  const registry = installDom();
  try {
    const log = [];
    const bridge = bridgeWith({
      memory_items: () => ({ ok: true, items: [{ id: 'm1', section: 'facts', text: 'hello there', sensitive: false, persisted: true }], sections: ['facts'] }),
    }, log);
    const viewModule = require('../src/memory-view.js');
    const partialView = Object.assign({}, viewModule);
    delete partialView.shapeOutcome;
    global.window = { companiondesk: bridge, CompanionMemoryView: partialView };
    freshPanel();
    await fireDOMContentLoaded(registry);
    const mark = registry.created.find((e) => e.tagName === 'button' && e.textContent === 'mark');
    assert.ok(mark, 'the mark button exists');
    const status = registry.byId.get('memory-panel-status');
    let rejection = null;
    try { await mark.handlers.click[0](); } catch (e) { rejection = e; }
    assert.equal(rejection, null, 'the click handler must never reject');
    assert.ok(await until(() => status && status.textContent !== ''), 'a status line is shown');
    assert.equal(status.textContent, 'memory: done', 'the action succeeded and the status says so');
  } finally { uninstallDom(registry); }
});

test('a double click on add fires the bridge call once and the button recovers', async () => {
  const registry = installDom();
  try {
    const log = [];
    let releaseAdd;
    const gate = new Promise((res) => { releaseAdd = res; });
    const bridge = bridgeWith({
      memory_items: () => ({ ok: true, items: [], sections: ['facts'] }),
      memory_add: () => gate,
    }, log);
    const viewModule = require('../src/memory-view.js');
    global.window = { companiondesk: bridge, CompanionMemoryView: viewModule };
    freshPanel();
    await fireDOMContentLoaded(registry);
    const add = registry.created.find((e) => e.tagName === 'button' && e.textContent === 'add');
    assert.ok(add, 'the add button exists');
    const input = registry.byId.get('memory-add-text');
    input.value = 'remember the thing';
    add.handlers.click[0]();
    add.handlers.click[0]();
    await until(() => log.some((m) => m === 'memory_add'), 50);
    assert.equal(log.filter((m) => m === 'memory_add').length, 1, 'the second click while in flight must not re-fire the add');
    releaseAdd({ ok: true });
    assert.ok(await until(() => add.disabled === false), 'the button is re-enabled once the call settles');
    assert.equal(log.filter((m) => m === 'memory_add').length, 1, 'settling the call does not add a retry');
    input.value = 'remember the thing';
    add.handlers.click[0]();
    assert.ok(await until(() => log.filter((m) => m === 'memory_add').length === 2), 'a settled button accepts the next click');
    assert.ok(await until(() => input.value === ''), 'the input clears on a successful add');
  } finally { uninstallDom(registry); }
});

test('a partial shaper missing shapeItems degrades the mount to an honest unavailable state', async () => {
  const registry = installDom();
  try {
    const log = [];
    const bridge = bridgeWith({
      memory_items: () => ({ ok: true, items: [{ id: 'm1', section: 'facts', text: 'hello there', sensitive: false, persisted: true }], sections: ['facts'] }),
    }, log);
    const viewModule = require('../src/memory-view.js');
    const partialView = Object.assign({}, viewModule);
    delete partialView.shapeItems;
    global.window = { companiondesk: bridge, CompanionMemoryView: partialView };
    freshPanel();
    let mountErr = null;
    try { await fireDOMContentLoaded(registry); } catch (e) { mountErr = e; }
    assert.equal(mountErr, null, 'the mount path must never reject');
    const status = registry.byId.get('memory-panel-status');
    assert.ok(await until(() => status && status.textContent !== ''), 'a status line is shown at mount');
    assert.equal(status.textContent, 'memory: unavailable right now', 'the mount says the panel is unavailable');
    const list = registry.byId.get('memory-panel-list');
    assert.ok(list && list.children.some((c) => c.textContent === 'memory: unavailable'), 'the list carries the honest unavailable line');
  } finally { uninstallDom(registry); }
});

test('a search click with a partial shaper announces itself instead of a silent no-op', async () => {
  const registry = installDom();
  try {
    const log = [];
    const bridge = bridgeWith({
      memory_items: () => ({ ok: true, items: [], sections: ['facts'] }),
      memory_search: () => ({ ok: true, results: [], task: 'chat', budget: 12, candidates: 0, sensitiveTotal: 0, sensitiveIncluded: 0 }),
    }, log);
    const viewModule = require('../src/memory-view.js');
    const partialView = Object.assign({}, viewModule);
    delete partialView.shapeSearch;
    global.window = { companiondesk: bridge, CompanionMemoryView: partialView };
    freshPanel();
    await fireDOMContentLoaded(registry);
    const search = registry.created.find((e) => e.tagName === 'button' && e.textContent === 'search');
    assert.ok(search, 'the search button exists');
    const input = registry.byId.get('memory-search-query');
    input.value = 'anything';
    const status = registry.byId.get('memory-panel-status');
    let rejection = null;
    try { await search.handlers.click[0](); } catch (e) { rejection = e; }
    assert.equal(rejection, null, 'the search click must never reject');
    assert.ok(await until(() => status && status.textContent !== ''), 'a status line is shown');
    assert.equal(status.textContent, 'memory: unavailable right now', 'the search says the panel is unavailable');
  } finally { uninstallDom(registry); }
});

test('a missing bridge at click time is announced instead of a silent no-op', async () => {
  const registry = installDom();
  try {
    const log = [];
    const bridge = bridgeWith({
      memory_items: () => ({ ok: true, items: [], sections: ['facts'] }),
    }, log);
    const viewModule = require('../src/memory-view.js');
    global.window = { companiondesk: bridge, CompanionMemoryView: viewModule };
    freshPanel();
    await fireDOMContentLoaded(registry);
    delete global.window.companiondesk;
    const add = registry.created.find((e) => e.tagName === 'button' && e.textContent === 'add');
    assert.ok(add, 'the add button exists');
    const input = registry.byId.get('memory-add-text');
    input.value = 'remember the thing';
    const status = registry.byId.get('memory-panel-status');
    let rejection = null;
    try { await add.handlers.click[0](); } catch (e) { rejection = e; }
    assert.equal(rejection, null, 'the click handler must never reject');
    assert.ok(await until(() => status && status.textContent !== ''), 'a status line is shown');
    assert.equal(status.textContent, 'memory: unavailable right now', 'the missing bridge is announced');
  } finally { uninstallDom(registry); }
});

test('consent resets after each search so the next search needs a fresh opt-in', async () => {
  const registry = installDom();
  try {
    const log = [];
    const searches = [];
    const bridge = bridgeWith({
      memory_items: () => ({ ok: true, items: [], sections: ['facts'] }),
      memory_search: (args) => {
        searches.push(args.includeSensitive === true);
        return { ok: true, results: [], task: 'chat', budget: 12, candidates: 0, sensitiveTotal: 1, sensitiveIncluded: args.includeSensitive === true ? 1 : 0 };
      },
    }, log);
    const viewModule = require('../src/memory-view.js');
    global.window = { companiondesk: bridge, CompanionMemoryView: viewModule };
    freshPanel();
    await fireDOMContentLoaded(registry);
    const search = registry.created.find((e) => e.tagName === 'button' && e.textContent === 'search');
    assert.ok(search, 'the search button exists');
    const input = registry.byId.get('memory-search-query');
    const consent = registry.byId.get('memory-search-consent');
    input.value = 'anything';
    consent.checked = true;
    let rejection = null;
    try { await search.handlers.click[0](); } catch (e) { rejection = e; }
    assert.equal(rejection, null, 'the search click must never reject');
    assert.ok(await until(() => searches.length >= 1), 'the first search ran');
    assert.equal(searches[0], true, 'the first search used the explicit consent');
    assert.ok(await until(() => consent.checked === false), 'consent resets after the search');
    await until(() => search.disabled === false, 50);
    search.handlers.click[0]();
    assert.ok(await until(() => searches.length >= 2), 'the second search ran');
    assert.equal(searches[1], false, 'the second search without re-consent must not include sensitive entries');
    consent.checked = true;
    await until(() => search.disabled === false, 50);
    search.handlers.click[0]();
    assert.ok(await until(() => searches.length >= 3), 'the third search ran');
    assert.equal(searches[2], true, 'a fresh explicit opt-in is honored again');
    assert.ok(await until(() => consent.checked === false), 'consent resets again');
  } finally { uninstallDom(registry); }
});

test('an errored search still resets consent', async () => {
  const registry = installDom();
  try {
    const log = [];
    const bridge = bridgeWith({
      memory_items: () => ({ ok: true, items: [], sections: ['facts'] }),
      memory_search: () => Promise.reject(new Error('bridge down')),
    }, log);
    const viewModule = require('../src/memory-view.js');
    global.window = { companiondesk: bridge, CompanionMemoryView: viewModule };
    freshPanel();
    await fireDOMContentLoaded(registry);
    const search = registry.created.find((e) => e.tagName === 'button' && e.textContent === 'search');
    const input = registry.byId.get('memory-search-query');
    const consent = registry.byId.get('memory-search-consent');
    input.value = 'anything';
    consent.checked = true;
    let rejection = null;
    try { await search.handlers.click[0](); } catch (e) { rejection = e; }
    assert.equal(rejection, null, 'the errored search must not reject the handler');
    assert.ok(await until(() => consent.checked === false), 'consent resets even when the search errors');
    assert.equal(log.filter((m) => m === 'memory_search').length, 1, 'no retry followed the error');
  } finally { uninstallDom(registry); }
});

test('the empty-query refusal does not spend or reset consent', async () => {
  const registry = installDom();
  try {
    const log = [];
    const bridge = bridgeWith({
      memory_items: () => ({ ok: true, items: [], sections: ['facts'] }),
    }, log);
    const viewModule = require('../src/memory-view.js');
    global.window = { companiondesk: bridge, CompanionMemoryView: viewModule };
    freshPanel();
    await fireDOMContentLoaded(registry);
    const search = registry.created.find((e) => e.tagName === 'button' && e.textContent === 'search');
    const consent = registry.byId.get('memory-search-consent');
    consent.checked = true;
    let rejection = null;
    try { await search.handlers.click[0](); } catch (e) { rejection = e; }
    assert.equal(rejection, null);
    const status = registry.byId.get('memory-panel-status');
    assert.ok(await until(() => status && status.textContent !== ''));
    assert.equal(status.textContent, 'memory: enter a search first', 'the refusal is the empty-query one');
    await until(() => search.disabled === false, 50);
    assert.equal(consent.checked, true, 'no search was attempted, so consent stays armed');
    assert.equal(log.filter((m) => m === 'memory_search').length, 0, 'no search call was made');
  } finally { uninstallDom(registry); }
});

test('a search with a missing bridge resets consent', async () => {
  const registry = installDom();
  try {
    const log = [];
    const bridge = bridgeWith({
      memory_items: () => ({ ok: true, items: [], sections: ['facts'] }),
    }, log);
    const viewModule = require('../src/memory-view.js');
    global.window = { companiondesk: bridge, CompanionMemoryView: viewModule };
    freshPanel();
    await fireDOMContentLoaded(registry);
    delete global.window.companiondesk;
    const search = registry.created.find((e) => e.tagName === 'button' && e.textContent === 'search');
    const input = registry.byId.get('memory-search-query');
    const consent = registry.byId.get('memory-search-consent');
    input.value = 'anything';
    consent.checked = true;
    let rejection = null;
    try { await search.handlers.click[0](); } catch (e) { rejection = e; }
    assert.equal(rejection, null, 'the click handler must never reject');
    assert.ok(await until(() => consent.checked === false), 'consent resets when the bridge is missing');
    const status = registry.byId.get('memory-panel-status');
    assert.ok(await until(() => status && status.textContent !== ''), 'a status line is shown');
    assert.equal(status.textContent, 'memory: unavailable right now', 'the missing bridge is announced like add');
  } finally { uninstallDom(registry); }
});
