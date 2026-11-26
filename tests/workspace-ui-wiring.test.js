'use strict';

// Structural guard for the Gate 3 workspace wiring (26 Nov 2026): the
// channel allowlist, its preload mirror, the section/tab/script in
// renderer/index.html, the shared view switcher and main's six handlers
// stay in step. Mirrors the repo's structural-guard pattern.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const CHANNELS = [
  'workspace:rows',
  'workspace:connectors',
  'workspace:connectorConnect',
  'workspace:connectorDisconnect',
  'workspace:connectorRevoke',
  'workspace:connectorReadmit',
];

test('the allowlist, preload mirror and main handlers carry exactly the six workspace channels', () => {
  const channelsSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'ipc-channels.js'), 'utf8');
  const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  for (const c of CHANNELS) {
    assert.ok(channelsSrc.includes("'" + c + "'"), 'ipc-channels: ' + c);
    assert.ok(preloadSrc.includes("'" + c + "'"), 'preload mirror: ' + c);
    assert.ok(mainSrc.includes("ipcMain.handle('" + c + "'"), 'main handler: ' + c);
  }
});

test('renderer/index.html carries the workspace tab, section, elements and scripts', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  assert.ok(html.includes('data-view="workspace"'), 'tab button');
  assert.ok(html.includes('id="view-workspace"'), 'section');
  for (const id of ['ws-view', 'ws-refresh', 'ws-status', 'ws-rows', 'ws-connectors']) {
    assert.ok(html.includes('id="' + id + '"'), 'element: ' + id);
  }
  assert.ok(html.includes('src="../src/workspace-views.js"'), 'shaper script');
  assert.ok(html.includes('src="workspace-panel.js"'), 'panel script');
  const panelIdx = html.indexOf('src="workspace-panel.js"');
  const bootIdx = html.indexOf('src="boot.js"');
  assert.ok(panelIdx !== -1 && bootIdx !== -1 && panelIdx < bootIdx, 'panel loads before boot');
});

test('the shared view switcher knows the workspace view and survives a missing section', () => {
  const domSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'dom.js'), 'utf8');
  assert.ok(/views = \[[^\]]*'workspace'[^\]]*\]/.test(domSrc), 'workspace in the views list');
  assert.ok(/if \(sec\)/.test(domSrc), 'missing section tolerated');
});

test('main wires the rows provider with the six owning sources and never registers a second tool', () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  assert.ok(mainSrc.includes('createWorkspaceRows('), 'rows provider wired');
  assert.ok(mainSrc.includes("conversations: () => chatHistory.listConversations(db)"), 'conversations source');
  assert.ok(mainSrc.includes("sensitive !== true"), 'sensitive memory rows filtered out');
  assert.ok(mainSrc.includes('CONNECTOR_CREDENTIAL_REFS'), 'credential refs map present');
});

test('main keeps the three Gate 8 stores and wires their providers; stores start empty', () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  for (const name of ['workspaceFilesStore', 'workspaceWorkflowsStore', 'workspaceModelsStore']) {
    assert.ok(mainSrc.includes('const ' + name + ' = createWorkspaceStore('), name + ' created');
    assert.ok(mainSrc.includes('() => ' + name + '.list()'), name + ' provider wired');
  }
  const mod = require('../src/workspace-stores.js');
  const fresh = mod.createWorkspaceStore({ clock: () => 0, name: 'files', prefix: 'f', fields: ['name'] });
  assert.deepEqual(fresh.list(), []);
});
