'use strict';

// In-place credential update (28 Nov 2026): a connected connector's
// stored key can be replaced without disconnecting. Two explicit clicks:
// the first reveals the field and calls nothing, the second saves the
// new key straight into main's OS credential vault. The secret is never
// rendered, logged or kept in the renderer, and a refusal surfaces
// verbatim. Same DOM stub pattern as tests/workspace-connector-actions-ui.test.js.

const test = require('node:test');
const assert = require('node:assert');

function makeElement(registry, tag) {
  const el = {
    tagName: tag, children: [], attrs: {}, handlers: {}, dataset: {},
    textContent: '', id: '', value: '', checked: false, type: '', disabled: false, hidden: false,
    appendChild(child) {
      el.children.push(child);
      if (child.id && !registry.byId.has(child.id)) registry.byId.set(child.id, child);
    },
    setAttribute(k, v) { el.attrs[k] = String(v); },
    addEventListener(name, fn) { (el.handlers[name] = el.handlers[name] || []).push(fn); },
    get firstChild() { return el.children.length ? el.children[0] : null; },
    removeChild(child) { const i = el.children.indexOf(child); if (i !== -1) el.children.splice(i, 1); return child; },
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
  const section = makeElement(registry, 'div'); section.id = 'ws-connectors-section';
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

function uninstallDom() { delete global.document; delete global.window; }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, tries = 300) {
  for (let i = 0; i < tries; i++) { if (fn()) return true; await sleep(5); }
  return false;
}

function deepChildren(el, out) {
  for (const c of el.children) { out.push(c); deepChildren(c, out); }
  return out;
}
function findBtn(root, re) {
  const all = deepChildren(root, []);
  return all.find((c) => c.tagName === 'button' && re.test(c.textContent || ''));
}
function statusText() {
  const s = global.document.getElementById('ws-status');
  return s ? (s.textContent || '') : '';
}
function allText(root) {
  return deepChildren(root, []).map((c) => c.textContent || '').join('\n');
}

async function loadPanel() {
  const path = require.resolve('../renderer/workspace-panel.js');
  delete require.cache[path];
  require('../renderer/workspace-panel.js');
  const P = global.window.CompanionWorkspacePanel;
  assert.ok(P, 'panel exposes CompanionWorkspacePanel');
  return P;
}

const CONNECTED = {
  id: 'github', name: 'GitHub', state: 'connected', hasCredential: true, integrationImplemented: true,
  costNote: 'Free for public repos', limits: 'Rate limits',
  scopes: [{ name: 'repos.read', class: 'read_only' }],
  actions: [{ id: 'list_issues', label: 'List open issues on a repository', scope: 'repos.read', kind: 'read_only', params: [{ name: 'owner', required: true }, { name: 'repo', required: true }] }],
};

function bridgeStub(overrides) {
  const calls = { credentialSet: [] };
  const bridge = {
    workspace_rows: () => Promise.resolve([]),
    workspace_connectors: () => Promise.resolve(overrides.connectors || [CONNECTED]),
    workspace_connector_connect: () => Promise.resolve({ ok: true }),
    workspace_connector_disconnect: () => Promise.resolve({ ok: true }),
    workspace_connector_revoke: () => Promise.resolve({ ok: true }),
    workspace_connector_readmit: () => Promise.resolve({ ok: true }),
    workspace_connectorCredentialSet: (id, secret) => {
      calls.credentialSet.push({ id, secret });
      return Promise.resolve(typeof overrides.credentialSetResult === 'function'
        ? overrides.credentialSetResult({ id, secret })
        : (overrides.credentialSetResult || { ok: true, hasCredential: true }));
    },
  };
  bridge.__calls = calls;
  return bridge;
}

test('a connected connector with a stored credential offers an in-place key update', async () => {
  installDom();
  try {
    const bridge = bridgeStub({});
    const P = await loadPanel();
    P.mount({ api: bridge, initialView: 'conversations' });
    const box = global.document.getElementById('ws-connectors');
    assert.ok(await until(() => !!findBtn(box, /Update key for GitHub/)), 'update key button renders');
    // The first click reveals the field and calls nothing.
    findBtn(box, /Update key for GitHub/).handlers.click[0]();
    await sleep(10);
    assert.equal(bridge.__calls.credentialSet.length, 0, 'the reveal click calls nothing');
    const field = deepChildren(box, []).find((c) => c.tagName === 'input' && /new credential for GitHub/.test(c.attrs['aria-label'] || ''));
    assert.ok(field, 'the new credential field is revealed');
    assert.ok(!!findBtn(box, /Save key for GitHub/), 'the save button is revealed');
  } finally { uninstallDom(); }
});

test('saving an empty new credential calls nothing and asks for the key first', async () => {
  installDom();
  try {
    const bridge = bridgeStub({});
    const P = await loadPanel();
    P.mount({ api: bridge, initialView: 'conversations' });
    const box = global.document.getElementById('ws-connectors');
    assert.ok(await until(() => !!findBtn(box, /Update key for GitHub/)));
    findBtn(box, /Update key for GitHub/).handlers.click[0]();
    await sleep(10);
    findBtn(box, /Save key for GitHub/).handlers.click[0]();
    await sleep(10);
    assert.equal(bridge.__calls.credentialSet.length, 0, 'no bridge call without a secret');
    assert.ok(/enter the new credential/.test(statusText()));
  } finally { uninstallDom(); }
});

test('saving a new key stores it through the vault and never renders the secret', async () => {
  installDom();
  try {
    const SECRET = 'ghp_NEW_SECRET_VALUE_9f8e7d6c';
    const bridge = bridgeStub({});
    const P = await loadPanel();
    P.mount({ api: bridge, initialView: 'conversations' });
    const box = global.document.getElementById('ws-connectors');
    assert.ok(await until(() => !!findBtn(box, /Update key for GitHub/)));
    findBtn(box, /Update key for GitHub/).handlers.click[0]();
    await sleep(10);
    const input = deepChildren(box, []).find((c) => c.tagName === 'input' && /new credential for GitHub/.test(c.attrs['aria-label'] || ''));
    assert.ok(input, 'the new credential field is on the row');
    input.value = SECRET;
    findBtn(box, /Save key for GitHub/).handlers.click[0]();
    await until(() => /credential updated for GitHub/.test(statusText()));
    assert.ok(await until(() => bridge.__calls.credentialSet.length === 1));
    assert.equal(bridge.__calls.credentialSet[0].id, 'github');
    assert.equal(bridge.__calls.credentialSet[0].secret, SECRET);
    assert.ok(await until(() => /credential updated for GitHub/.test(statusText())));
    // The whole rendered surface never carries the secret.
    assert.equal(allText(box).includes(SECRET), false, 'secret never rendered');
    assert.equal(statusText().includes(SECRET), false, 'secret never in the status line');
    assert.equal(input.value, '', 'the field is cleared after saving');
  } finally { uninstallDom(); }
});

test('a refusal from the vault surfaces verbatim and the connection stays', async () => {
  installDom();
  try {
    const bridge = bridgeStub({ credentialSetResult: { ok: false, reason: 'secret_too_long' } });
    const P = await loadPanel();
    P.mount({ api: bridge, initialView: 'conversations' });
    const box = global.document.getElementById('ws-connectors');
    assert.ok(await until(() => !!findBtn(box, /Update key for GitHub/)));
    findBtn(box, /Update key for GitHub/).handlers.click[0]();
    await sleep(10);
    const input = deepChildren(box, []).find((c) => c.tagName === 'input' && /new credential for GitHub/.test(c.attrs['aria-label'] || ''));
    input.value = 'x';
    findBtn(box, /Save key for GitHub/).handlers.click[0]();
    assert.ok(await until(() => bridge.__calls.credentialSet.length === 1));
    assert.ok(await until(() => /credential not saved: secret_too_long/.test(statusText())));
  } finally { uninstallDom(); }
});
