'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildHealth, collectHealth } = require('../src/health');

const GOOD = {
  ollama: true, model: 'llama3.2:latest', modelLoaded: true, visionModel: 'gemma3:4b', hasVision: true,
  voice: { available: true }, modelsDir: '/m', screenPermission: 'granted', micPermission: 'granted',
  hotkey: 'CommandOrControl+Shift+Space', hotkeyRegistered: true, platform: 'darwin',
};
const byId = (r) => Object.fromEntries(r.items.map((i) => [i.id, i]));

test('everything set up: ready, and every item is ok', () => {
  const r = buildHealth(GOOD);
  assert.equal(r.ready, true);
  assert.ok(r.items.every((i) => i.status === 'ok'), JSON.stringify(r.items.map((i) => [i.id, i.status])));
  assert.deepEqual(r.items.map((i) => i.id), ['ollama', 'model', 'shortcut', 'voice', 'vision', 'screen', 'mic']);
});

test('no Ollama: not ready, the model is waiting on it, and the fix is clear', () => {
  const r = buildHealth({ ...GOOD, ollama: false, modelLoaded: false, hasVision: false });
  const i = byId(r);
  assert.equal(r.ready, false);
  assert.equal(i.ollama.status, 'needed');
  assert.match(i.ollama.fix.text, /ollama\.com/);
  assert.equal(i.model.status, 'needed');
  assert.equal(i.model.detail, 'Waiting for Ollama.');
  assert.equal(i.model.fix, null, 'no command until Ollama exists');
  assert.equal(i.vision.status, 'optional');
});

test('Ollama running without the model: gives the exact pull command, using the configured model', () => {
  const r = buildHealth({ ...GOOD, modelLoaded: false, model: 'llama3.2:latest' });
  assert.equal(r.ready, false);
  assert.deepEqual(byId(r).model.fix, { text: 'Download it once (a few GB):', command: 'ollama pull llama3.2:latest' });
  assert.equal(buildHealth({ ...GOOD, modelLoaded: false, model: 'qwen3:8b' }).items.find((i) => i.id === 'model').fix.command, 'ollama pull qwen3:8b');
});

test('optional features never block readiness', () => {
  const r = buildHealth({ ...GOOD, voice: { available: false, reason: 'no_binary' }, hasVision: false, hotkeyRegistered: false, screenPermission: 'denied', micPermission: 'denied' });
  assert.equal(r.ready, true);
  const i = byId(r);
  for (const id of ['shortcut', 'voice', 'vision', 'screen', 'mic']) assert.equal(i[id].status, 'optional', id);
  assert.equal(i.voice.fix.command, 'brew install whisper-cpp');
  assert.equal(i.vision.fix.command, 'ollama pull gemma3:4b');
  assert.match(i.screen.fix.text, /Screen Recording/);
  assert.match(i.mic.fix.text, /Microphone/);
});

test('voice: a missing model shows where to put it', () => {
  const r = buildHealth({ ...GOOD, voice: { available: false, reason: 'no_model' }, modelsDir: '/Users/a/Library/Application Support/CompanionDesk/models' });
  const v = byId(r).voice;
  assert.match(v.detail, /no model file/);
  assert.equal(v.fix.command, '/Users/a/Library/Application Support/CompanionDesk/models');
});

test('macOS-only permission items do not appear elsewhere', () => {
  const ids = buildHealth({ ...GOOD, platform: 'linux', screenPermission: null, micPermission: null }).items.map((i) => i.id);
  assert.ok(!ids.includes('screen') && !ids.includes('mic'));
});

test('a microphone that was never asked about is informational, not a problem', () => {
  const m = byId(buildHealth({ ...GOOD, micPermission: 'not-determined' })).mic;
  assert.equal(m.status, 'optional');
  assert.equal(m.fix, null);
  assert.match(m.detail, /first time you click Speak/);
});

test('collect gathers the facts from the app and tolerates a failing permission API', async () => {
  const calls = [];
  const deps = {
    ai: { status: async () => ({ ollama: true, model: 'llama3.2:latest', modelLoaded: true }), hasModel: async (n) => { calls.push(n); return false; } },
    voice: { status: () => ({ ok: true, available: false, reason: 'no_binary' }) },
    modelsDir: '/m', visionModel: 'gemma3:4b',
    systemPreferences: { getMediaAccessStatus: () => { throw new Error('boom'); } },
    hotkey: 'Alt+Shift+K', hotkeyRegistered: true, platform: 'darwin',
  };
  const r = await collectHealth(deps);
  assert.equal(r.ok, true);
  assert.equal(r.ready, true);
  assert.deepEqual(calls, ['gemma3:4b']);
  assert.equal(byId(r).screen.status, 'optional', 'an unreadable permission is treated as not granted');
  assert.equal(byId(r).vision.status, 'optional');
});

test('collect does not ask Ollama about a vision model when Ollama is down', async () => {
  let asked = false;
  const deps = {
    ai: { status: async () => ({ ollama: false, model: 'llama3.2:latest', modelLoaded: false }), hasModel: async () => { asked = true; return true; } },
    voice: { status: () => ({ ok: true, available: true }) }, modelsDir: '/m', visionModel: 'gemma3:4b',
    systemPreferences: {}, hotkey: 'Alt+Shift+K', hotkeyRegistered: false, platform: 'linux',
  };
  const r = await collectHealth(deps);
  assert.equal(asked, false);
  assert.equal(r.ready, false);
});
