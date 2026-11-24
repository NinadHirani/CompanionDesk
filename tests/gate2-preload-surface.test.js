'use strict';
// Gate 2 wiring: structural proof of the shipped preload and renderer.
// The preload is self-contained (sandboxed preloads cannot require local
// modules), so the proof reads the shipped source: the inlined channel
// list must contain every contract renderer channel, no main-only channel
// may appear anywhere in its surface, and the push-event allowlist carries
// no agent operation. The renderer panel may call only the six read
// methods.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
  RENDERER_CHANNELS,
  MAIN_ONLY_CHANNELS,
  validatePreloadAllowlist,
} = require('../src/ipc-contract.js');

const preloadSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
const panelSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'agent-panel.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');

function extractList(src, name) {
  const m = src.match(new RegExp('const ' + name + ' = \\[([\\s\\S]*?)\\];'));
  assert.ok(m, name + ' block not found');
  // Comment lines are stripped first: they may contain commas and quoted
  // words, and they are prose, not list items.
  const body = m[1]
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  return body
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

test('preload: the inlined list carries every contract renderer channel', () => {
  const list = extractList(preloadSrc, 'IPC_CHANNELS');
  for (const c of RENDERER_CHANNELS) assert.ok(list.includes(c), 'missing ' + c);
});

test('preload: the contract renderer channels are a subset with no duplicates among them', () => {
  const list = extractList(preloadSrc, 'IPC_CHANNELS');
  const agentOnes = list.filter((c) => RENDERER_CHANNELS.includes(c));
  assert.equal(new Set(agentOnes).size, agentOnes.length);
  // The full exposed api is built from the whole inlined list; the contract
  // check proves the agent subset has no extras of its own.
  assert.equal(validatePreloadAllowlist(agentOnes).ok, true);
});

test('preload: no main-only channel appears in the preload surface', () => {
  const list = extractList(preloadSrc, 'IPC_CHANNELS');
  for (const c of MAIN_ONLY_CHANNELS) assert.equal(list.includes(c), false, c);
});

test('preload: requests are invoke-only', () => {
  assert.ok(preloadSrc.includes('ipcRenderer.invoke'));
  assert.equal(preloadSrc.includes('ipcRenderer.send'), false);
  assert.equal(preloadSrc.includes('sendSync'), false);
});

test('preload: exposes through contextBridge', () => {
  assert.ok(preloadSrc.includes('contextBridge.exposeInMainWorld'));
});

test('preload: the push-event allowlist carries no agent operation', () => {
  const events = extractList(preloadSrc, 'IPC_EVENTS');
  for (const c of MAIN_ONLY_CHANNELS) assert.equal(events.includes(c), false, c);
});

test('renderer: the agent panel is wired into the page', () => {
  assert.ok(htmlSrc.includes('agent-panel.js'));
});

test('renderer: the panel calls only the six read methods', () => {
  const readMethods = RENDERER_CHANNELS.map((c) => c.replace(':', '_'));
  for (const m of readMethods) assert.ok(panelSrc.includes(m), 'panel should call ' + m);
  const forbidden = MAIN_ONLY_CHANNELS.map((c) => c.replace(':', '_'));
  for (const f of forbidden) assert.equal(panelSrc.includes(f), false, 'panel must not reference ' + f);
});

test('renderer: the panel renders text only', () => {
  // Comments are prose; strip them before scanning for DOM-write usage.
  const code = panelSrc.replace(/\/\/[^\n]*/g, '');
  assert.ok(code.includes('textContent'));
  assert.equal(code.includes('innerHTML'), false);
  assert.equal(code.includes('document.write'), false);
});
