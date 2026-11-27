'use strict';

// Batch 2 behavioral tests (27 Nov 2026, Ninad's integration go-ahead):
// the Connectors panel's action surfaces. Read-only actions run from an
// explicit click; sends and writes need a second explicit Confirm click
// and never call the bridge from the first one; refusals surface
// verbatim; ok results show a bounded preview; the oauth token-state
// label renders without any credential material. Same DOM stub pattern
// as tests/workspace-ui.test.js.

const test = require('node:test');
const assert = require('node:assert');

function makeElement(registry, tag) {
  const el = {
    tagName: tag, children: [], attrs: {}, handlers: {}, dataset: {},
    textContent: '', id: '', value: '', checked: false, type: '', disabled: false,
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
function allLines(root) {
  return deepChildren(root, []).filter((c) => c.tagName === 'div').map((c) => c.textContent || '');
}

function bridgeStub(overrides) {
  const calls = { action: [] };
  const bridge = {
    workspace_rows: () => Promise.resolve([]),
    workspace_connectors: () => Promise.resolve(overrides.connectors || []),
    workspace_connector_connect: () => Promise.resolve({ ok: true }),
    workspace_connector_disconnect: () => Promise.resolve({ ok: true }),
    workspace_connector_revoke: () => Promise.resolve({ ok: true }),
    workspace_connector_readmit: () => Promise.resolve({ ok: true }),
    workspace_connectorAction: (id, actionId, params, runOpts) => {
      calls.action.push({ id, actionId, params, runOpts });
      return Promise.resolve(typeof overrides.actionResult === 'function'
        ? overrides.actionResult({ id, actionId, params, runOpts })
        : (overrides.actionResult || { ok: true, status: 200, data: { fine: true } }));
    },
  };
  bridge.__calls = calls;
  return bridge;
}

const CONNECTED_GITHUB = {
  id: 'github', name: 'GitHub', state: 'connected', hasCredential: true, integrationImplemented: true,
  costNote: 'Free tier', limits: 'Rate limits', tokenState: 'ok',
  scopes: [{ name: 'issues.read', class: 'read_only' }, { name: 'issues.write', class: 'write' }],
  actions: [
    { id: 'list_issues', label: 'List open issues on a repository', scope: 'issues.read', kind: 'read_only', params: [{ name: 'owner', required: true }, { name: 'repo', required: true }] },
    { id: 'create_issue', label: 'Open a new issue on a repository', scope: 'issues.write', kind: 'write', params: [{ name: 'owner', required: true }, { name: 'repo', required: true }, { name: 'title', required: true }] },
  ],
};
const CONNECTED_SLACK = {
  id: 'slack', name: 'Slack', state: 'connected', hasCredential: true, integrationImplemented: true,
  costNote: 'Free tier', limits: 'Rate limits', tokenState: null,
  scopes: [{ name: 'channels.read', class: 'read_only' }, { name: 'message.send', class: 'send' }],
  actions: [
    { id: 'auth_test', label: 'Check the bot token works', scope: 'channels.read', kind: 'read_only', params: [] },
    { id: 'post_message', label: 'Post a message to a channel', scope: 'message.send', kind: 'send',
      params: [{ name: 'channel', required: true }, { name: 'text', required: true }] },
  ],
};

async function loadPanel() {
  const path = require.resolve('../renderer/workspace-panel.js');
  delete require.cache[path];
  require('../renderer/workspace-panel.js');
  const P = global.window.CompanionWorkspacePanel;
  assert.ok(P, 'panel exposes CompanionWorkspacePanel');
  return P;
}

test('a connected implemented connector shows its actions as explicit run buttons', async () => {
  installDom();
  try {
    const bridge = bridgeStub({ connectors: [CONNECTED_SLACK] });
    const P = await loadPanel();
    P.mount({ api: bridge, initialView: 'conversations' });
    const box = global.document.getElementById('ws-connectors');
    assert.ok(await until(() => !!findBtn(box, /^Run: Check the bot token works$/)));
    assert.ok(findBtn(box, /^Run: Post a message to a channel$/), 'the send action is offered too');
    const runBtn = findBtn(box, /^Run: Check the bot token works$/);
    assert.equal(runBtn.attrs['aria-label'], 'read_only (channels.read) on Slack', 'the kind and scope travel with the button');
  } finally { uninstallDom(); }
});

test('a read-only action runs from its single click with the engine opts, never confirmWrite', async () => {
  installDom();
  try {
    const bridge = bridgeStub({ connectors: [CONNECTED_SLACK] });
    const P = await loadPanel();
    P.mount({ api: bridge, initialView: 'conversations' });
    const box = global.document.getElementById('ws-connectors');
    const btn = await until(() => findBtn(box, /^Run: Check the bot token works$/)) && findBtn(box, /^Run: Check the bot token works$/);
    btn.handlers.click[0]();
    await until(() => bridge.__calls.action.length === 1);
    const a = bridge.__calls.action[0];
    assert.equal(a.id, 'slack');
    assert.equal(a.actionId, 'auth_test');
    assert.equal(a.runOpts.userInitiated, true);
    assert.equal(a.runOpts.confirmWrite, false, 'a read never asks for an approval');
    const notes = allLines(box).join(' | ');
    assert.ok(notes.indexOf('action ok (status 200)') !== -1, 'the result preview shows');
    assert.ok(notes.indexOf('fine') !== -1);
  } finally { uninstallDom(); }
});

test('a send action needs a second explicit Confirm click before the bridge is called', async () => {
  installDom();
  try {
    const bridge = bridgeStub({ connectors: [CONNECTED_SLACK] });
    const P = await loadPanel();
    P.mount({ api: bridge, initialView: 'conversations' });
    const box = global.document.getElementById('ws-connectors');
    const runBtn = await until(() => findBtn(box, /^Run: Post a message to a channel$/)) && findBtn(box, /^Run: Post a message to a channel$/);
    runBtn.handlers.click[0]();
    await sleep(20);
    assert.equal(bridge.__calls.action.length, 0, 'no call from the first click');
    const confirmBtn = findBtn(box, /^Confirm run$/);
    assert.ok(confirmBtn, 'the confirm step exists');
    const notes = allLines(box).join(' | ');
    assert.ok(notes.indexOf('per-action approval') !== -1, 'the approval note is visible before confirming');
    const inputs = deepChildren(box, []).filter((c) => c.tagName === 'input' && /post_message /.test(c.attrs['aria-label'] || ''));
    assert.equal(inputs.length, 2, 'one labelled input per required parameter');
    inputs[0].value = 'C123';
    inputs[1].value = 'hello there';
    confirmBtn.handlers.click[0]();
    await until(() => bridge.__calls.action.length === 1);
    const a = bridge.__calls.action[0];
    assert.equal(a.actionId, 'post_message');
    assert.deepEqual(a.params, { channel: 'C123', text: 'hello there' });
    assert.equal(a.runOpts.confirmWrite, true, 'the confirm click is the per-action approval gesture');
  } finally { uninstallDom(); }
});

test('refusals surface verbatim, including the reauth guidance', async () => {
  installDom();
  try {
    const bridge = bridgeStub({
      connectors: [CONNECTED_SLACK],
      actionResult: { ok: false, reason: 'scope_not_granted' },
    });
    const P = await loadPanel();
    P.mount({ api: bridge, initialView: 'conversations' });
    const box = global.document.getElementById('ws-connectors');
    const btn = await until(() => findBtn(box, /^Run: Check the bot token works$/)) && findBtn(box, /^Run: Check the bot token works$/);
    btn.handlers.click[0]();
    await until(() => bridge.__calls.action.length === 1);
    assert.ok(await until(() => allLines(box).join(' | ').indexOf('action refused: scope_not_granted') !== -1));
  } finally { uninstallDom(); }

  installDom();
  try {
    const bridge = bridgeStub({
      connectors: [CONNECTED_SLACK],
      actionResult: { ok: false, reason: 'reauth_required' },
    });
    const P = await loadPanel();
    P.mount({ api: bridge, initialView: 'conversations' });
    const box = global.document.getElementById('ws-connectors');
    const btn = await until(() => findBtn(box, /^Run: Check the bot token works$/)) && findBtn(box, /^Run: Check the bot token works$/);
    btn.handlers.click[0]();
    await until(() => bridge.__calls.action.length === 1);
    assert.ok(await until(() => allLines(box).join(' | ').indexOf('connect again to re-authenticate') !== -1));
  } finally { uninstallDom(); }
});

test('the oauth token-state label renders a label only, never credential material', async () => {
  installDom();
  try {
    const bridge = bridgeStub({ connectors: [Object.assign({}, CONNECTED_SLACK, { tokenState: 'expired' })] });
    const P = await loadPanel();
    P.mount({ api: bridge, initialView: 'conversations' });
    const box = global.document.getElementById('ws-connectors');
    assert.ok(await until(() => allLines(box).join(' | ').indexOf('token expired: the next action refreshes it automatically') !== -1));
    const blob = JSON.stringify(bridge);
    assert.equal(/access_token|client_secret/.test(blob), false, 'no credential text anywhere in the rendered output');
  } finally { uninstallDom(); }
});

test('a discovery-state row renders no action buttons', async () => {
  installDom();
  try {
    const discovered = Object.assign({}, CONNECTED_SLACK, { state: 'discovered' });
    const bridge = bridgeStub({ connectors: [discovered] });
    const P = await loadPanel();
    P.mount({ api: bridge, initialView: 'conversations' });
    const box = global.document.getElementById('ws-connectors');
    await sleep(20);
    assert.equal(findBtn(box, /^Run: /), undefined, 'nothing is runnable before an explicit connect');
  } finally { uninstallDom(); }
});

test('a write action follows the same two-step confirm as sends', async () => {
  installDom();
  try {
    const bridge = bridgeStub({ connectors: [CONNECTED_GITHUB] });
    const P = await loadPanel();
    P.mount({ api: bridge, initialView: 'conversations' });
    const box = global.document.getElementById('ws-connectors');
    const runBtn = await until(() => findBtn(box, /^Run: Open a new issue on a repository$/)) && findBtn(box, /^Run: Open a new issue on a repository$/);
    runBtn.handlers.click[0]();
    await sleep(20);
    assert.equal(bridge.__calls.action.length, 0, 'no call from the first click');
    const confirmBtn = findBtn(box, /^Confirm run$/);
    assert.ok(confirmBtn, 'the write confirm step exists');
    const inputs = deepChildren(box, []).filter((c) => c.tagName === 'input' && /create_issue /.test(c.attrs['aria-label'] || ''));
    assert.equal(inputs.length, 3, 'one labelled input per required parameter');
    inputs[0].value = 'NinadHirani';
    inputs[1].value = 'CompanionDesk';
    inputs[2].value = 'Test issue';
    confirmBtn.handlers.click[0]();
    await until(() => bridge.__calls.action.length === 1);
    const a = bridge.__calls.action[0];
    assert.equal(a.actionId, 'create_issue');
    assert.deepEqual(a.params, { owner: 'NinadHirani', repo: 'CompanionDesk', title: 'Test issue' });
    assert.equal(a.runOpts.confirmWrite, true, 'the confirm click is the per-action approval gesture for writes too');
  } finally { uninstallDom(); }
});
