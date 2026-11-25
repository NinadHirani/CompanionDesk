'use strict';

// The web/mobile bridge gates every public entry point on the boot promise:
// a cached page can reload faster than init() opens the saved database, and
// a call that touches the database in that window used to run against a null
// db and break the boot (observed live: brief_today threw "Cannot read
// properties of null (reading 'listBriefRows')" on a reload with saved data).
// This test loads the real built bundle in a sandbox with a deferred
// IndexedDB and proves the gate: a call before init pends, completes after,
// and the companion identity round-trips through the same gated surface.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WEB = path.join(__dirname, '..', 'web');

// Same script order web/index.html loads, minus the sql.js WASM vendor file
// (the sandbox injects its own initSqlJs stand-in) and the renderer files.
const SCRIPTS = [
  'core/extraction-core.js', 'core/import-errors.js', 'core/ai.js',
  'core/model-selection.js', 'core/chat-history.js', 'core/ollama-setup.js',
  'core/db.js', 'core/dates.js', 'core/settings.js', 'core/hardware.js',
  'core/provider-faults.js', 'core/provider-status.js', 'core/skills.js',
  'core/patterns.js', 'core/grades.js', 'core/gradebook.js', 'core/brief.js',
  'core/services.js', 'core/ics.js', 'core/calendar.js',
  'core/provider-registry.js', 'core/task-router.js', 'bridge.js',
];

function makeFakeIdb() {
  const state = { released: false, saved: null, waiters: [], release() { state.released = true; state.waiters.splice(0).forEach((fire) => fire()); } };
  const fake = {
    open() {
      const req = { onupgradeneeded: null, onsuccess: null, onerror: null, result: null, error: null };
      Promise.resolve().then(() => {
        req.result = {
          objectStoreNames: { length: 1, contains: () => true },
          close() {},
          transaction(_store, mode) {
            return {
              objectStore: () => ({
                get(_key) {
                  const g = { onsuccess: null, onerror: null, result: state.saved || null };
                  const fire = () => { if (g.onsuccess) g.onsuccess(); };
                  if (mode === 'readonly' && !state.released) state.waiters.push(fire);
                  else Promise.resolve().then(fire);
                  return g;
                },
                put(value) { state.saved = value; return {}; },
              }),
              oncomplete: null,
              onerror: null,
            };
          },
        };
        if (req.onsuccess) req.onsuccess();
      });
      return req;
    },
  };
  return { fake, state };
}

function makeContext() {
  const { fake, state } = makeFakeIdb();
  // Empty-database stand-in: settings rows are really stored (the identity
  // round-trip below writes and reads them), every list query returns no
  // rows, and the two COUNT queries state_get makes still get their single
  // { n: 0 } row.
  const tables = { settings: new Map() };
  const fakeDb = {
    exec() {}, close() {},
    run(sql, params = []) {
      const s = String(sql);
      if (/INSERT INTO settings/i.test(s) && params.length >= 2) {
        tables.settings.set(String(params[0]), String(params[1]));
      }
    },
    prepare(sql) {
      const s = String(sql);
      if (/SELECT key, value FROM settings/i.test(s)) {
        const rows = Array.from(tables.settings.entries()).map(([key, value]) => ({ key, value }));
        let i = 0;
        return { bind() { return this; }, step() { return i < rows.length; }, getAsObject() { return rows[i++]; }, free() {} };
      }
      if (/COUNT\(\*\)\s+AS\s+n/i.test(s)) {
        let stepped = false;
        return { bind() { return this; }, step() { if (!stepped) { stepped = true; return true; } return false; }, getAsObject() { return { n: 0 }; }, free() {} };
      }
      return { bind() { return this; }, step() { return false; }, getAsObject() { return {}; }, free() {} };
    },
    export() { return new Uint8Array(64); },
  };
  const sandbox = {
    self: null,
    window: null,
    location: { href: 'http://127.0.0.1:8123/index.html' },
    URL,
    console,
    setTimeout, clearTimeout,
    indexedDB: fake,
    initSqlJs: () => Promise.resolve({ Database: function () { return fakeDb; } }),
    fetch: () => Promise.reject(new Error('no network in this test')),
    navigator: {},
    crypto: {},
    performance: { now: () => Date.now() },
  };
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  const ctx = vm.createContext(sandbox);
  for (const script of SCRIPTS) {
    const code = fs.readFileSync(path.join(WEB, script), 'utf8');
    vm.runInContext(code, ctx, { filename: script });
  }
  return { sandbox, idb: state };
}

test('the web bridge gates every db-touching entry point on the boot promise', async () => {
  const { sandbox, idb } = makeContext();
  const api = sandbox.window.companiondesk;
  assert.ok(api, 'the bridge published window.companiondesk');
  assert.equal(api.bridgeMode, 'web', 'bridgeMode stays a plain value');

  // Before init() opens the database the call must pend, never reject.
  let settled = false;
  const pending = api.brief_today();
  pending.then(() => { settled = true; }, () => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'a call before init completes waits for the boot gate');

  // Release the deferred database load; the same call now completes.
  idb.release();
  const brief = await pending;
  assert.ok(brief && typeof brief === 'object', 'brief_today resolves after init');
});

test('the companion identity round-trips through the gated web bridge', async () => {
  const { sandbox, idb } = makeContext();
  const api = sandbox.window.companiondesk;
  idb.release();
  await api.settings_save({ assistant_name: 'Nova', user_name: 'Ninad' });
  const st = await api.state_get();
  assert.equal(st.identity.name, 'Nova');
  assert.equal(st.identity.greeting, 'Hi Ninad, Nova here. Ask me about your deadlines, courses or notes.');
});

test('the push listener stays outside the gate so boot-time registration works', () => {
  const { sandbox, idb } = makeContext();
  const api = sandbox.window.companiondesk;
  assert.equal(typeof api.on('test:event', () => {}), 'function', 'on returns its unlistener synchronously');
  idb.release();
});
