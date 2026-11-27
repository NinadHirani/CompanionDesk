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
    const text = deepText(box);
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
    assert.ok(await until(() => box.children[0] && /connector catalog: 2 listed, 1 connected/.test(box.children[0].textContent)));
    assert.ok(/explicit pick per connector/.test(box.children[0].textContent));
  } finally { uninstallDom(); }
});

test('connecting is an explicit click that passes the entry scopes and surfaces a refusal verbatim', async () => {
  installDom();
  try {
    const connectors = [{ id: 'rss', name: 'RSS feeds', state: 'discovered', hasCredential: true, costNote: 'Free; RSS feeds are open by design', limits: 'Bound by each feed publisher', scopes: [{ name: 'feed.read', class: 'read_only' }] }];
    const bridge = bridgeStub({ rows: () => [], connectors, connectResult: { ok: false, reason: 'credential_ref_required' } });
    const P = await loadPanel();
    P.mount({ api: bridge, initialView: 'conversations' });
    const box = global.document.getElementById('ws-connectors');
    assert.ok(await until(() => !!findBtn(box, /Connect RSS feeds/)));
    const connectBtn = findBtn(box, /Connect RSS feeds/);
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
    assert.ok(await until(() => !!findBtn(box, /Disconnect GitHub/)));
    const d = findBtn(box, /Disconnect GitHub/);
    d.handlers.click[0]();
    await until(() => bridge.__calls.disconnect.length === 1);
    assert.strictEqual(bridge.__calls.disconnect[0], 'github');
    assert.ok(await until(() => /workspace: connector disconnected/.test(statusText())));
    const r = findBtn(box, /Revoke GitHub/);
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

// ---------------------------------------------------------------------------
// Gate 2 AI-access connector flow (27 Nov 2026): the AI's connect requests
// render in the Connectors section; approving one is an explicit click that
// runs the SAME connect gate as the user's own pick; dismissing just
// resolves the request. The optional bridge methods degrade gracefully.

function requestBridge(overrides) {
  const calls = { requests: [], resolve: [], connect: [] };
  const base = bridgeStub(overrides || {});
  base.workspace_connectorRequests = () => { calls.requests.push(1); return Promise.resolve((overrides && overrides.requests) || []); };
  base.workspace_connectorRequestResolve = (id, decision) => { calls.resolve.push([id, decision]); return Promise.resolve((overrides && overrides.resolveResult) || { ok: true, status: decision, connectorId: 'rss' }); };
  base.__req = calls;
  return base;
}

const CATALOG_TWO = [
  { id: 'rss', name: 'RSS feeds', state: 'discovered', costNote: 'Free; RSS feeds are open by design', limits: 'Bound by each feed publisher', scopes: [{ name: 'feed.read', class: 'read_only' }] },
  { id: 'github', name: 'GitHub', state: 'discovered', costNote: 'Free for public repos', limits: '5,000 REST requests per hour', scopes: [{ name: 'repos.read', class: 'read_only' }, { name: 'issues.write', class: 'write' }] },
];

function connectorText() { return (global.document.getElementById('ws-connectors') || {}).children || []; }

// The connector rows are wrapped in per-row containers (the marketplace
// slice added row filtering), so lookups walk the subtree instead of
// scanning only direct children.
function allNodes(root) {
  const out = [];
  const walk = (n) => { if (!n) return; out.push(n); for (const c of n.children || []) walk(c); };
  walk(root);
  return out.slice(1);
}
function deepText(root) { return allNodes(root).map((n) => n.textContent || '').join(' '); }
function findBtn(root, re) { return allNodes(root).find((n) => n.tagName === 'button' && re.test(n.textContent || '')) || null; }
function findInput(root, labelRe) {
  return allNodes(root).find((n) => n.tagName === 'input' && (labelRe.test((n.attrs && n.attrs.placeholder) || '') || labelRe.test((n.attrs && n.attrs['aria-label']) || ''))) || null;
}

test('a pending AI request renders with its reason and approve/dismiss buttons', async () => {
  installDom();
  try {
    const bridge = requestBridge({ connectors: CATALOG_TWO, requests: [{ id: 'cr-1', connectorId: 'rss', reason: 'the task needs feed reads', requestedAt: 1, status: 'pending', repeats: 0 }] });
    const P = await loadPanel();
    P.mount({ api: bridge, initialView: 'tasks' });
    assert.ok(await until(() => connectorText().some((n) => /AI request for RSS feeds - the task needs feed reads/.test(n.textContent))));
    const labels = connectorText().map((n) => n.textContent);
    assert.ok(labels.some((t) => t === 'Approve request for RSS feeds'), 'approve button renders');
    assert.ok(labels.some((t) => t === 'Dismiss request for RSS feeds'), 'dismiss button renders');
    assert.equal(bridge.__req.requests.length, 1);
  } finally { uninstallDom(); }
});

test('approving a request resolves it and then runs the SAME explicit connect gate', async () => {
  installDom();
  try {
    const bridge = requestBridge({ connectors: CATALOG_TWO, requests: [{ id: 'cr-1', connectorId: 'rss', reason: 'needs feeds', requestedAt: 1, status: 'pending', repeats: 0 }], resolveResult: { ok: true, status: 'approved', connectorId: 'rss' } });
    const P = await loadPanel();
    P.mount({ api: bridge, initialView: 'tasks' });
    assert.ok(await until(() => connectorText().some((n) => n.textContent === 'Approve request for RSS feeds')));
    const approve = connectorText().find((n) => n.textContent === 'Approve request for RSS feeds');
    approve.handlers.click[0]();
    assert.ok(await until(() => bridge.__req.resolve.length === 1));
    assert.deepEqual(bridge.__req.resolve[0], ['cr-1', 'approved']);
    assert.ok(await until(() => bridge.__calls.connect.length === 1));
    assert.deepEqual(bridge.__calls.connect[0], ['rss', ['feed.read']], 'the approved connect passes the declared scopes only');
    assert.ok(await until(() => /connected \(AI request approved\)|connect refused/.test(statusText())));
  } finally { uninstallDom(); }
});

test('dismissing a request only resolves it and never calls connect', async () => {
  installDom();
  try {
    const bridge = requestBridge({ connectors: CATALOG_TWO, requests: [{ id: 'cr-2', connectorId: 'github', reason: 'repo read', requestedAt: 1, status: 'pending', repeats: 0 }], resolveResult: { ok: true, status: 'dismissed', connectorId: 'github' } });
    const P = await loadPanel();
    P.mount({ api: bridge, initialView: 'tasks' });
    assert.ok(await until(() => connectorText().some((n) => n.textContent === 'Dismiss request for GitHub')));
    const dismiss = connectorText().find((n) => n.textContent === 'Dismiss request for GitHub');
    dismiss.handlers.click[0]();
    assert.ok(await until(() => bridge.__req.resolve.length === 1));
    assert.deepEqual(bridge.__req.resolve[0], ['cr-2', 'dismissed']);
    assert.equal(bridge.__calls.connect.length, 0, 'a dismissal never connects');
    assert.ok(await until(() => statusText() === 'workspace: request dismissed'));
  } finally { uninstallDom(); }
});

test('a bridge without the optional request methods still renders the catalog', async () => {
  installDom();
  try {
    const bridge = bridgeStub({ connectors: CATALOG_TWO });
    const P = await loadPanel();
    P.mount({ api: bridge, initialView: 'tasks' });
    assert.ok(await until(() => connectorText().some((n) => /connector catalog: 2 listed, 0 connected/.test(n.textContent))));
    assert.equal(connectorText().some((n) => /AI request/.test(n.textContent)), false, 'no request rows invented');
  } finally { uninstallDom(); }
});

test('a failed connect after approval surfaces the refusal verbatim and keeps the request', async () => {
  installDom();
  try {
    const bridge = requestBridge({
      connectors: CATALOG_TWO,
      requests: [{ id: 'cr-3', connectorId: 'rss', reason: 'needs feeds', requestedAt: 1, status: 'pending', repeats: 0 }],
      resolveResult: { ok: true, status: 'approved', connectorId: 'rss' },
      connectResult: { ok: false, reason: 'credential_ref_required' },
    });
    const P = await loadPanel();
    P.mount({ api: bridge, initialView: 'tasks' });
    assert.ok(await until(() => connectorText().some((n) => n.textContent === 'Approve request for RSS feeds')));
    connectorText().find((n) => n.textContent === 'Approve request for RSS feeds').handlers.click[0]();
    assert.ok(await until(() => statusText() === 'workspace: connect refused: credential_ref_required'), 'the honest refusal, verbatim');
  } finally { uninstallDom(); }
});

test('a row without a stored credential shows a password field and an empty click refuses honestly', async () => {
  installDom();
  try {
    const connectors = [{ id: 'rss', name: 'RSS feeds', state: 'discovered', hasCredential: false, costNote: 'Free; RSS feeds are open by design', limits: 'Bound by each feed publisher', scopes: [{ name: 'feed.read', class: 'read_only' }] }];
    const bridge = bridgeStub({ rows: () => [], connectors });
    const P = await loadPanel();
    P.mount({ api: bridge, initialView: 'conversations' });
    const box = global.document.getElementById('ws-connectors');
    assert.ok(await until(() => !!findInput(box, /credential for/)), 'password field rendered');
    const connectBtn = findBtn(box, /Connect RSS feeds/);
    connectBtn.handlers.click[0]();
    assert.ok(await until(() => /workspace: enter a credential for RSS feeds to connect/.test(statusText())));
    assert.strictEqual(bridge.__calls.connect.length, 0, 'no connect without a credential');
  } finally { uninstallDom(); }
});

test('a typed credential is saved through the bridge, the connect runs, and the field is cleared', async () => {
  installDom();
  try {
    const connectors = [{ id: 'rss', name: 'RSS feeds', state: 'discovered', hasCredential: false, costNote: 'Free; RSS feeds are open by design', limits: 'Bound by each feed publisher', scopes: [{ name: 'feed.read', class: 'read_only' }] }];
    const bridge = bridgeStub({ rows: () => [], connectors, bridge: { workspace_connectorCredentialSet: (id, secret) => { bridge.__calls.credSet.push([id, secret]); return Promise.resolve({ ok: true, hasCredential: true }); } } });
    bridge.__calls.credSet = [];
    const P = await loadPanel();
    P.mount({ api: bridge, initialView: 'conversations' });
    const box = global.document.getElementById('ws-connectors');
    assert.ok(await until(() => !!findInput(box, /credential for/)));
    const input = findInput(box, /credential for/);
    input.value = 'sk-secret-token';
    const connectBtn = findBtn(box, /Connect RSS feeds/);
    connectBtn.handlers.click[0]();
    assert.ok(await until(() => bridge.__calls.connect.length === 1));
    assert.deepStrictEqual(bridge.__calls.credSet[0], ['rss', 'sk-secret-token'], 'the secret went to main only');
    assert.strictEqual(input.value, '', 'the field is cleared right after the click');
    assert.ok(await until(() => /workspace: connect requested for RSS feeds/.test(statusText())));
    assert.ok(!statusText().includes('sk-secret-token'), 'the status line never shows the secret');
  } finally { uninstallDom(); }
});

test('a failed credential save surfaces the reason verbatim and never connects', async () => {
  installDom();
  try {
    const connectors = [{ id: 'rss', name: 'RSS feeds', state: 'discovered', hasCredential: false, costNote: 'Free; RSS feeds are open by design', limits: 'Bound by each feed publisher', scopes: [{ name: 'feed.read', class: 'read_only' }] }];
    const bridge = bridgeStub({ rows: () => [], connectors, bridge: { workspace_connectorCredentialSet: () => Promise.resolve({ ok: false, reason: 'encryption_unavailable' }) } });
    const P = await loadPanel();
    P.mount({ api: bridge, initialView: 'conversations' });
    const box = global.document.getElementById('ws-connectors');
    assert.ok(await until(() => !!findInput(box, /credential for/)));
    const input = findInput(box, /credential for/);
    input.value = 'sk-secret-token';
    const connectBtn = findBtn(box, /Connect RSS feeds/);
    connectBtn.handlers.click[0]();
    assert.ok(await until(() => /workspace: credential not saved: encryption_unavailable/.test(statusText())));
    assert.strictEqual(bridge.__calls.connect.length, 0, 'no connect when the credential did not save');
    assert.strictEqual(input.value, '', 'the field is cleared either way');
  } finally { uninstallDom(); }
});

test('a row with a stored credential renders no credential field and connects on one click', async () => {
  installDom();
  try {
    const connectors = [{ id: 'rss', name: 'RSS feeds', state: 'discovered', hasCredential: true, costNote: 'Free; RSS feeds are open by design', limits: 'Bound by each feed publisher', scopes: [{ name: 'feed.read', class: 'read_only' }] }];
    const bridge = bridgeStub({ rows: () => [], connectors });
    const P = await loadPanel();
    P.mount({ api: bridge, initialView: 'conversations' });
    const box = global.document.getElementById('ws-connectors');
    assert.ok(await until(() => !!findBtn(box, /Connect RSS feeds/)));
    assert.strictEqual(!!findInput(box, /credential for/), false, 'no credential field when one is already stored');
    const connectBtn = findBtn(box, /Connect RSS feeds/);
    connectBtn.handlers.click[0]();
    assert.ok(await until(() => bridge.__calls.connect.length === 1));
  } finally { uninstallDom(); }
});

// ---------------------------------------------------------------------------
// Connector marketplace slice (27 Nov 2026, Ninad's instruction): search and
// category filters, custom connectors with honest readiness labels, and the
// add/remove custom flows. Nothing auto-connects; every custom entry is
// definition-only and labelled, never a fake working integration.

function marketplaceBridge(overrides) {
  const calls = { customAdd: [], customRemove: [] };
  const base = bridgeStub(overrides || {});
  base.workspace_connectorCustomAdd = (def) => { calls.customAdd.push(def); return Promise.resolve((overrides && overrides.customAddResult) || { ok: true, state: 'discovered' }); };
  base.workspace_connectorCustomRemove = (id) => { calls.customRemove.push(id); return Promise.resolve((overrides && overrides.customRemoveResult) || { ok: true, state: 'removed' }); };
  base.__custom = calls;
  return base;
}

test('the search filter and category select hide rows client-side', async () => {
  installDom();
  try {
    const connectors = [
      { id: 'rss', name: 'RSS feeds', category: 'feeds', state: 'discovered', costNote: 'Free', limits: 'Feed limits', scopes: [{ name: 'feed.read', class: 'read_only' }] },
      { id: 'github', name: 'GitHub', category: 'code', state: 'discovered', costNote: 'Free for public repos', limits: 'Rate limits', scopes: [{ name: 'repos.read', class: 'read_only' }] },
    ];
    const bridge = marketplaceBridge({ connectors });
    const P = await loadPanel();
    P.mount({ api: bridge, initialView: 'tasks' });
    const box = global.document.getElementById('ws-connectors');
    assert.ok(await until(() => !!findInput(box, /search connectors/)));
    const search = findInput(box, /search connectors/);
    search.value = 'rss';
    search.handlers.input[0]();
    const rowDivs = box.children.filter((c) => c.tagName === 'div' && c.children.length);
    const rssRow = rowDivs.find((r) => allNodes(r).some((n) => /RSS feeds - discovered/.test(n.textContent || '')));
    const ghRow = rowDivs.find((r) => allNodes(r).some((n) => /GitHub - discovered/.test(n.textContent || '')));
    assert.ok(rssRow && ghRow, 'both rows rendered as wrapped rows');
    assert.strictEqual(rssRow.hidden, false);
    assert.strictEqual(ghRow.hidden, true, 'the non-matching row is hidden client-side');
    search.value = '';
    search.handlers.input[0]();
    assert.strictEqual(ghRow.hidden, false, 'clearing the search unhides every row');
    const catSel = box.children.find((c) => c.tagName === 'select' && c.attrs['aria-label'] === 'filter connectors by category');
    assert.ok(catSel, 'the category filter renders');
    const values = catSel.children.map((o) => o.value);
    assert.strictEqual(values[0], 'all');
    assert.ok(values.indexOf('feeds') !== -1 && values.indexOf('code') !== -1, 'the categories come from the entries');
    assert.strictEqual(bridge.__calls.connect.length, 0, 'filtering never connects anything');
  } finally { uninstallDom(); }
});

test('a custom connector row carries the honest readiness label and a remove button', async () => {
  installDom();
  try {
    const connectors = [
      { id: 'my-service', name: 'My Service', state: 'discovered', custom: true, readinessNote: 'URL stored, integration not implemented: this build never sends outbound webhook calls', scopes: [{ name: 'events.read', class: 'read_only' }] },
      { id: 'live-one', name: 'Live One', state: 'connected', custom: true, readinessNote: 'x', scopes: [] },
    ];
    const bridge = marketplaceBridge({ connectors });
    const P = await loadPanel();
    P.mount({ api: bridge, initialView: 'tasks' });
    const box = global.document.getElementById('ws-connectors');
    assert.ok(await until(() => deepText(box).includes('custom connector: URL stored, integration not implemented')));
    const removeBtn = findBtn(box, /Remove My Service/);
    assert.ok(removeBtn, 'remove button renders for a custom row');
    removeBtn.handlers.click[0]();
    assert.ok(await until(() => bridge.__custom.customRemove.length === 1));
    assert.strictEqual(bridge.__custom.customRemove[0], 'my-service');
    assert.ok(await until(() => /workspace: custom connector removed/.test(statusText())));
    assert.strictEqual(findBtn(box, /Remove Live One/), null, 'no remove button while a custom connector is connected');
  } finally { uninstallDom(); }
});

test('the custom form adds through the channel with an explicit slug and scopes', async () => {
  installDom();
  try {
    const bridge = marketplaceBridge({ connectors: CATALOG_TWO });
    const P = await loadPanel();
    P.mount({ api: bridge, initialView: 'tasks' });
    const box = global.document.getElementById('ws-connectors');
    assert.ok(await until(() => !!findBtn(box, /Add custom connector/)));
    findInput(box, /custom connector name/).value = '3Box Notes';
    const auth = box.children.find((c) => c.tagName === 'select' && c.attrs['aria-label'] === 'custom connector auth type');
    auth.value = 'webhook';
    findInput(box, /custom connector URL/).value = 'https://example.com/hook';
    findInput(box, /custom connector scopes/).value = 'events.read:read_only, events.write:write';
    findBtn(box, /Add custom connector/).handlers.click[0]();
    assert.ok(await until(() => bridge.__custom.customAdd.length === 1));
    const def = bridge.__custom.customAdd[0];
    assert.strictEqual(def.id, 'c-3box-notes', 'the slug is generated and digit-leading ids are prefixed');
    assert.strictEqual(def.name, '3Box Notes');
    assert.strictEqual(def.authType, 'webhook');
    assert.strictEqual(def.url, 'https://example.com/hook');
    assert.deepStrictEqual(def.scopes, ['events.read:read_only', 'events.write:write']);
    assert.ok(await until(() => /custom connector added \(definition only/.test(statusText())));
    assert.strictEqual(findInput(box, /custom connector name/).value, '', 'the form is cleared after a successful add');
  } finally { uninstallDom(); }
});

test('a custom add refusal surfaces verbatim and the empty-name path never calls the channel', async () => {
  installDom();
  try {
    const bridge = marketplaceBridge({ connectors: CATALOG_TWO, customAddResult: { ok: false, reason: 'url_invalid' } });
    const P = await loadPanel();
    P.mount({ api: bridge, initialView: 'tasks' });
    const box = global.document.getElementById('ws-connectors');
    assert.ok(await until(() => !!findBtn(box, /Add custom connector/)));
    findBtn(box, /Add custom connector/).handlers.click[0]();
    assert.ok(await until(() => statusText() === 'workspace: name your custom connector first'));
    assert.strictEqual(bridge.__custom.customAdd.length, 0, 'no channel call without a name');
    findInput(box, /custom connector name/).value = 'My Service';
    findBtn(box, /Add custom connector/).handlers.click[0]();
    assert.ok(await until(() => bridge.__custom.customAdd.length === 1));
    assert.ok(await until(() => statusText() === 'workspace: custom connector refused: url_invalid'), 'the refusal, verbatim');
  } finally { uninstallDom(); }
});

test('a bridge without the custom-connector methods degrades honestly', async () => {
  installDom();
  try {
    const bridge = bridgeStub({ connectors: CATALOG_TWO });
    const P = await loadPanel();
    P.mount({ api: bridge, initialView: 'tasks' });
    const box = global.document.getElementById('ws-connectors');
    assert.ok(await until(() => !!findBtn(box, /Add custom connector/)));
    findInput(box, /custom connector name/).value = 'My Service';
    findBtn(box, /Add custom connector/).handlers.click[0]();
    assert.ok(await until(() => statusText() === 'workspace: custom connectors unavailable in this build'));
  } finally { uninstallDom(); }
});

test('a curated popular-provider row carries the honest not-implemented label', async () => {
  installDom();
  try {
    const connectors = [{ id: 'slack', name: 'Slack', state: 'discovered', costNote: 'Free tier with message-history limits', limits: 'Free tier API rate limits apply', scopes: [{ name: 'channels.read', class: 'read_only' }], readinessNote: 'definition only: no integration actions are implemented for Slack in this build' }];
    const bridge = marketplaceBridge({ connectors });
    const P = await loadPanel();
    P.mount({ api: bridge, initialView: 'tasks' });
    const box = global.document.getElementById('ws-connectors');
    assert.ok(await until(() => deepText(box).includes('integration not implemented: definition only: no integration actions are implemented for Slack in this build')), 'the honest label travels with the row');
    assert.strictEqual(bridge.__calls.connect.length, 0, 'nothing connects by being listed');
  } finally { uninstallDom(); }
});
