'use strict';

// CLAUDE.md rule 4: the allowlist lives in src/ipc-channels.js, is mirrored
// inline in src/preload.js, and main.js must register a handler for each
// channel. Nothing enforced that before; this does.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { IPC_CHANNELS, IPC_EVENTS } = require('../src/ipc-channels');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');

function preloadChannels() {
  const m = read('preload.js').match(/const IPC_CHANNELS = \[([\s\S]*?)\];/);
  assert.ok(m, 'preload.js must declare IPC_CHANNELS inline');
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

function handledChannels() {
  // Update handlers are registered by the controller in src/updater.js,
  // which registers update:status in both the disabled and the active path.
  return [...new Set([
    ...read('main.js').matchAll(/ipcMain\.handle\(\s*'([^']+)'/g),
    ...read('updater.js').matchAll(/ipc\.handle\(\s*'([^']+)'/g),
  ].map((x) => x[1]))];
}

test('channel names are unique and shaped like area:action', () => {
  assert.equal(new Set(IPC_CHANNELS).size, IPC_CHANNELS.length);
  for (const c of IPC_CHANNELS) assert.match(c, /^[a-z]+:[A-Za-z]+$/);
});

test('preload mirrors the allowlist exactly', () => {
  assert.deepEqual([...preloadChannels()].sort(), [...IPC_CHANNELS].sort());
});

test('main registers a handler for every channel and no others', () => {
  assert.deepEqual([...handledChannels()].sort(), [...IPC_CHANNELS].sort());
});

test('push events: preload mirrors the event allowlist exactly', () => {
  const m = read('preload.js').match(/const IPC_EVENTS = \[([\s\S]*?)\];/);
  assert.ok(m, 'preload.js must declare IPC_EVENTS inline');
  assert.deepEqual([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort(), [...IPC_EVENTS].sort());
});

test('push events: only allowlisted events are sent, and each one is sent somewhere', () => {
  const sent = new Set();
  for (const f of ['main.js', 'overlay.js']) for (const m of read(f).matchAll(/\bsend\(\s*'([^']+)'/g)) sent.add(m[1]);
  assert.deepEqual([...sent].sort(), [...IPC_EVENTS].sort());
});

test('event names never collide with invoke channels', () => {
  for (const e of IPC_EVENTS) assert.ok(!IPC_CHANNELS.includes(e), e);
});
