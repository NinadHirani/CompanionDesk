'use strict';

// Behavioral tests for the Workspace UI panel (Gate 3 slice, approved by
// Ninad on 26 Nov 2026). The panel renders the workspace-views catalog
// with functional interactions: a view picker, a refresh that fetches the
// owning rows through the bridge and shapes them with the pure shaper,
// an honest not-wired state for the views whose stores do not exist yet,
// and the connector settings section (Gate 2 follow-on) where connecting,
// disconnecting and revoking happen ONLY from an explicit click and every
// refusal is surfaced verbatim. Nothing connects on load; no auto-connect,
// no auto-activation. Rendering is textContent only. A minimal DOM stub
// is used, mirroring tests/memory-panel-errors.test.js.

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
    get firstChild() { return el.children.length ? el.children[0] : null; },
    removeChild(child) {
      const i = el.children.indexOf(child);
      if (i !== -1) el.children.splice(i, 1);
      return child;
    },
  };
  return el;
}

function installDom() {
  const registry = { byId: new Map(), created: [], docHandlers: {} };
  const doc = {
    readyState: 'complete',
    body: makeElement(registry, 'body'),
    createElement(tag) { const e = makeElement(registry, tag); registry.created.push(e); return e; },
    getElementById(id) { return registry.byId.get(id) || null; },
    addEventListener(name, fn) { (registry.docHandlers[name] = registry.docHandlers[name] || []).push(fn); },
  };
  // The static containers the panel mounts into, as index.html provides them.
  const section = makeElement(registry, 'section'); section.id = 'view-workspace'; section.hidden = true;
  const select = makeElement(registry, 'select'); select.id = 'ws-view';
  const refreshBtn = makeElement(registry, 'button'); refreshBtn.id = 'ws-refresh';
  const status = makeElement(registry, 'div'); status.id = 'ws-status';
  const rows = makeElement(registry, 'div'); rows.id = 'ws-rows';
  const connectors = makeElement(registry, 'div'); connectors.id = 'ws-connectors';
  for (const e of [section, select, refreshBtn, status, rows, connectors]) registry.byId.set(e.id, e);
  global.document = doc;
  global.window = { document: doc, CompanionWorkspaceViews: require('../src/workspace-views.js') };
  return { registry, doc };
}

function uninstallDom() {
  delete global.document;
  delete global.window;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, tries = 300) {
  for (let i = 0; i < tries; i++) {
    if (fn()) return true;
    await sleep(5);
  }
  return false;
}

function statusText() { return (global.document.getElementById('ws-status') || {}).textContent || ''; }
function rowsOf() { return (global.document.getElementById('ws-rows') || {}).children || []; }

function bridgeStub(overrides) {
  const calls = { rows: [], connect: [], disconnect: [], readmit: [], revoke: [], connectors: 0 };
  const bridge = {
    workspace_rows: (name) => { calls.rows.push(name); return Promise.resolve(overrides.rows ? overrides.rows(name) : []); },
    workspace_connectors: () => { calls.connectors += 1; return Promise.resolve(overrides.connectors || []); },
    workspace_connector_connect: (id, scopes) => { calls.connect.push([id, scopes]); return Promise.resolve(overrides.connectResult || { ok: true, reason: null }); },
    workspace_connector_disconnect: (id) => { calls.disconnect.push(id); return Promise.resolve(overrides.disconnectResult || { ok: true, reason: null }); },
    workspace_connector_readmit: (id) => { calls.readmit.push(id); return Promise.resolve({ ok: true, reason: null }); },
    workspace_connector_revoke: (id) => { calls.revoke.push(id); return Promise.resolve({ ok: true, reason: null }); },
  };
  for (const [k, v] of Object.entries(overrides.bridge || {})) bridge[k] = v;
  bridge.__calls = calls;
  return bridge;
}

const GOOD_ROW = { id: 'rem-000003', title: 'Evening plan', dueAt: 1735312800000, notes: null, createdAt: 1735309200000, cancelled: false };

async function loadPanel() {
  const path = require.resolve('../renderer/workspace-panel.js');
  delete require.cache[path];
  require('../renderer/workspace-panel.js');
  const P = global.window.CompanionWorkspacePanel;
  assert.ok(P, 'panel exposes CompanionWorkspacePanel');
  return P;
}

test('without the bridge the panel announces unavailable and builds no rows', async () => {
  installDom();
  try {
    const P = await loadPanel();
    P.mount({ api: null });
    assert.strictEqual(statusText(), 'workspace: unavailable right now');
    assert.strictEqual(rowsOf().length, 0);
  } finally { uninstallDom(); }
});

test('a wired view renders shaper lines and reports shown/total/skipped', async () => {
  installDom();
  try {
    const bridge = bridgeStub({ rows: (n) => (n === 'tasks' ? [GOOD_ROW, { bad: true }] : []) });
    const P = await loadPanel();
    P.mount({ api: bridge, initialView: 'tasks' });
    assert.ok(await until(() => rowsOf().length === 1));
    assert.strictEqual(rowsOf()[0].textContent, '#rem-000003 Evening plan (due ' + new Date(1735312800000).toISOString() + ', active)');
    assert.strictEqual(statusText(), 'workspace: showing 1 of 2, 1 skipped');
    assert.strictEqual(bridge.__calls.rows[0], 'tasks');
  } finally { uninstallDom(); }
});

test('an unwired view stays honest: not wired yet, no rows invented', async () => {
  installDom();
  try {
    const bridge = bridgeStub({ rows: () => [GOOD_ROW] });
    const P = await loadPanel();
    P.mount({ api: bridge, initialView: 'settings' });
    assert.ok(await until(() => /not wired yet in this build/.test(statusText())));
    assert.strictEqual(rowsOf().length, 0);
    assert.strictEqual(bridge.__calls.rows.length, 0, 'no fetch for an unwired view');
  } finally { uninstallDom(); }
});

test('a wired row-store view with no rows shows its empty state, never invented rows', async () => {
  installDom();
  try {
    const bridge = bridgeStub({ rows: () => [] });
    const P = await loadPanel();
    P.mount({ api: bridge, initialView: 'files' });
    assert.ok(await until(() => /showing 0 of 0/.test(statusText())));
    assert.strictEqual(rowsOf().length, 1, 'the empty-state note is the only row');
    assert.ok(/no rows yet/.test(rowsOf()[0].textContent));
    assert.strictEqual(bridge.__calls.rows[0], 'files');
  } finally { uninstallDom(); }
});

test('a bridge failure becomes a status line, never an unhandled rejection', async () => {
  installDom();
  try {
    const bridge = bridgeStub({ bridge: { workspace_rows: () => Promise.reject(new Error('boom')) } });
    const P = await loadPanel();
    P.mount({ api: bridge, initialView: 'tasks' });
    assert.ok(await until(() => statusText() === 'workspace: unavailable right now'));
    assert.strictEqual(rowsOf().length, 0);
  } finally { uninstallDom(); }
});

test('a refresh already in flight is a no-op: the bridge is not fired twice', async () => {
  installDom();
  try {
    let release;
    const gate = new Promise((r) => { release = r; });
    const bridge = bridgeStub({ bridge: {
      workspace_rows: (name) => { bridge.__calls.rows.push(name); return gate.then(() => [GOOD_ROW]); },
    } });
    const P = await loadPanel();
    P.mount({ api: bridge, initialView: 'tasks' });
    const btn = global.document.getElementById('ws-refresh');
    btn.handlers.click[0]();
    btn.handlers.click[0]();
    release();
    await until(() => rowsOf().length === 1);
    assert.strictEqual(bridge.__calls.rows.length, 1);
  } finally { uninstallDom(); }
});

test('connectors render with cost and limits visible and nothing connects on load', async () => {
  installDom();
  try {
    const connectors = [
      { id: 'rss', name: 'RSS feeds', state: 'discovered', costNote: 'Free; RSS feeds are open by design', limits: 'Bound by each feed publisher', scopes: [{ name: 'feed.read', class: 'read_only' }] },
      { id: 'github', name: 'GitHub', state: 'connected', costNote: 'Free for public repos; paid plans for private features', limits: '5,000 REST requests per hour on the free tier', scopes: [{ name: 'repos.read', class: 'read_only' }] },
    ];
    const bridge = bridgeStub({ rows: () => [], connectors });
    const P = await loadPanel();
    P.mount({ api: bridge, initialView: 'conversations' });
    const box = global.document.getElementById('ws-connectors');
    assert.ok(await until(() => box.children.length >= 2));
    const text = box.children.map((c) => c.textContent).join(' ');
    assert.ok(text.includes('Free; RSS feeds are open by design'), 'cost visible before activation');
    assert.ok(text.includes('5,000 REST requests per hour'), 'limits visible');
    assert.strictEqual(bridge.__calls.connect.length, 0, 'no auto-connect on load');
    assert.strictEqual(bridge.__calls.disconnect.length, 0);
    assert.strictEqual(bridge.__calls.revoke.length, 0);
  } finally { uninstallDom(); }
});

test('the connector wait state states the activation rule up front: explicit pick, counts shown', async () => {
  installDom();
  try {
    const connectors = [
      { id: 'rss', name: 'RSS feeds', state: 'discovered', costNote: 'Free; RSS feeds are open by design', limits: 'Bound by each feed publisher', scopes: [{ name: 'feed.read', class: 'read_only' }] },
      { id: 'github', name: 'GitHub', state: 'connected', costNote: 'Free for public repos', limits: '5,000 REST requests per hour on the free tier', scopes: [{ name: 'repos.read', class: 'read_only' }] },
    ];
    const bridge = bridgeStub({ rows: () => [], connectors });
    const P = await loadPanel();
    P.mount({ api: bridge, initialView: 'conversations' });
    const box = global.document.getElementById('ws-connectors');
    assert.ok(await until(() => box.children[0] && /connector catalog: 2 shipped, 1 connected/.test(box.children[0].textContent)));
    assert.ok(/explicit pick per connector/.test(box.children[0].textContent));
  } finally { uninstallDom(); }
});

test('connecting is an explicit click that passes the entry scopes and surfaces a refusal verbatim', async () => {
  installDom();
  try {
    const connectors = [{ id: 'rss', name: 'RSS feeds', state: 'discovered', costNote: 'Free; RSS feeds are open by design', limits: 'Bound by each feed publisher', scopes: [{ name: 'feed.read', class: 'read_only' }] }];
    const bridge = bridgeStub({ rows: () => [], connectors, connectResult: { ok: false, reason: 'credential_ref_required' } });
    const P = await loadPanel();
    P.mount({ api: bridge, initialView: 'conversations' });
    const box = global.document.getElementById('ws-connectors');
    assert.ok(await until(() => box.children.some((c) => c.tagName === 'button' && /Connect RSS feeds/.test(c.textContent))));
    const connectBtn = box.children.find((c) => c.tagName === 'button' && /Connect RSS feeds/.test(c.textContent));
    connectBtn.handlers.click[0]();
    await until(() => bridge.__calls.connect.length === 1);
    assert.deepStrictEqual(bridge.__calls.connect[0], ['rss', ['feed.read']]);
    assert.ok(await until(() => /workspace: connect refused: credential_ref_required/.test(statusText())));
  } finally { uninstallDom(); }
});

test('a connected connector offers disconnect and revoke, each on its own explicit click', async () => {
  installDom();
  try {
    const connectors = [{ id: 'github', name: 'GitHub', state: 'connected', costNote: 'Free for public repos', limits: '5,000 REST requests per hour on the free tier', scopes: [{ name: 'repos.read', class: 'read_only' }] }];
    const bridge = bridgeStub({ rows: () => [], connectors });
    const P = await loadPanel();
    P.mount({ api: bridge, initialView: 'conversations' });
    const box = global.document.getElementById('ws-connectors');
    assert.ok(await until(() => box.children.some((c) => c.tagName === 'button' && /Disconnect GitHub/.test(c.textContent))));
    const d = box.children.find((c) => c.tagName === 'button' && /Disconnect GitHub/.test(c.textContent));
    d.handlers.click[0]();
    await until(() => bridge.__calls.disconnect.length === 1);
    assert.strictEqual(bridge.__calls.disconnect[0], 'github');
    assert.ok(await until(() => /workspace: connector disconnected/.test(statusText())));
    const r = box.children.find((c) => c.tagName === 'button' && /Revoke GitHub/.test(c.textContent));
    r.handlers.click[0]();
    await until(() => bridge.__calls.revoke.length === 1);
    assert.strictEqual(bridge.__calls.revoke[0], 'github');
    assert.ok(await until(() => /workspace: connector revoked/.test(statusText())));
  } finally { uninstallDom(); }
});

test('the catalog select carries all thirteen catalog views in roadmap order', async () => {
  installDom();
  try {
    const bridge = bridgeStub({ rows: () => [] });
    const P = await loadPanel();
    P.mount({ api: bridge, initialView: 'conversations' });
    const sel = global.document.getElementById('ws-view');
    const labels = sel.children.map((o) => o.textContent);
    assert.deepStrictEqual(labels, ['Conversations', 'Tasks', 'Memory', 'Tools', 'Files', 'Databases', 'App data', 'Workflows', 'Settings', 'Permissions', 'Activity', 'Models', 'Integrations']);
  } finally { uninstallDom(); }
});
