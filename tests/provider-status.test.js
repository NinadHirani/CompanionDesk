'use strict';

// M1 slice 4: provider health status for Settings. Pins the guarantees that
// matter: states are built ONLY from bounded local probes and the vault's
// masked booleans, the cloud is never probed here (the module does no I/O at
// all), and no key material can leak because none is ever passed in.

const test = require('node:test');
const assert = require('node:assert');
const PS = require('../src/provider-status');

const build = (over = {}) => PS.buildProviderStatus({
  ollamaUp: true,
  installed: ['llama3.2:latest', 'gemma3:4b'],
  chat: { model: 'llama3.2:latest', resolved: 'configured' },
  vision: { model: 'gemma3:4b', resolved: 'configured', visionVerified: true },
  secureStore: { supported: true, encryptionAvailable: true, configured: true },
  cloudEnabled: false,
  ...over,
});

test('reachable server reports the selected models as installed', () => {
  const s = build();
  assert.equal(s.ollama.reachable, true);
  assert.deepEqual(s.chat, { model: 'llama3.2:latest', installed: true });
  assert.deepEqual(s.vision, { model: 'gemma3:4b', capability: 'verified' });
});

test('a family name without a tag still matches the installed model', () => {
  const s = build({ chat: { model: 'llama3.2', resolved: 'configured' } });
  assert.equal(s.chat.installed, true);
  const other = build({ chat: { model: 'qwen2.5', resolved: 'configured' } });
  assert.equal(other.chat.installed, false);
});

test('an unreachable server never invents model facts', () => {
  const s = build({ ollamaUp: false, installed: null, chat: { model: 'llama3.2:latest', resolved: 'ollama_down' }, vision: { model: 'gemma3:4b', resolved: 'ollama_down', visionVerified: null } });
  assert.equal(s.ollama.reachable, false);
  assert.equal(s.chat.installed, null);
  assert.equal(s.vision.capability, 'unreachable');
});

test('an unprobed server stays unknown', () => {
  const s = build({ ollamaUp: null, installed: null });
  assert.equal(s.ollama.reachable, null);
  assert.equal(s.chat.installed, null);
  assert.equal(s.vision.capability, 'unknown');
});

test('vision capability is verified only when Ollama said so', () => {
  assert.equal(build({ vision: { model: 'gemma3:4b', visionVerified: null } }).vision.capability, 'unknown');
  assert.equal(build({ vision: { model: 'gemma3:4b', visionVerified: false } }).vision.capability, 'unknown');
  assert.equal(build({ vision: null }).vision.capability, 'unknown');
});

test('cloud states are distinguished without any network call', () => {
  assert.equal(build({ cloudEnabled: false, secureStore: { supported: true, encryptionAvailable: true, configured: false } }).cloud.state, 'off');
  assert.equal(build({ cloudEnabled: false, secureStore: { supported: true, encryptionAvailable: true, configured: true } }).cloud.state, 'configured_disabled');
  assert.equal(build({ cloudEnabled: true, secureStore: { supported: true, encryptionAvailable: true, configured: false } }).cloud.state, 'enabled_no_key');
  const armed = build({ cloudEnabled: true, secureStore: { supported: true, encryptionAvailable: true, configured: true } });
  assert.equal(armed.cloud.state, 'armed');
  assert.equal(armed.cloud.armed, true);
  assert.equal(armed.cloud.storage, 'os_vault');
});

test('no secure vault fails the cloud closed even with a key recorded', () => {
  const s = build({ cloudEnabled: true, secureStore: { supported: false, encryptionAvailable: false, configured: true } });
  assert.equal(s.cloud.state, 'no_secure_storage');
  assert.equal(s.cloud.armed, false);
  assert.equal(s.cloud.storage, 'unavailable');
  assert.equal(s.credentialStorage.available, false);
});

test('a missing vault report stays unknown, never a guess', () => {
  const s = build({ secureStore: null });
  assert.equal(s.cloud.storage, 'unknown');
  assert.equal(s.credentialStorage.available, null);
  assert.equal(s.cloud.armed, false);
});

test('malformed inputs never throw and fall back conservative', () => {
  for (const bad of [undefined, null, 'x', 42]) {
    const s = PS.buildProviderStatus({ ollamaUp: bad, installed: bad, chat: bad, vision: bad, secureStore: bad, cloudEnabled: bad });
    assert.equal(s.cloud.armed, false);
    assert.equal(s.chat.installed, null);
  }
});

test('the output carries no key material, whatever the inputs carry', () => {
  // Defense against an upstream shape change: even if the vault object grew
  // a stray key field, the status may not echo it.
  const s = build({ secureStore: { supported: true, encryptionAvailable: true, configured: true, apiKey: 'SECRET-KEY-MATERIAL-123' } });
  assert.ok(!JSON.stringify(s).includes('SECRET-KEY-MATERIAL-123'));
  const flat = Object.keys(s).sort();
  assert.deepEqual(flat, ['chat', 'cloud', 'credentialStorage', 'ollama', 'vision']);
  assert.deepEqual(Object.keys(s.cloud).sort(), ['armed', 'enabled', 'keySaved', 'state', 'storage']);
});

test('the module does no I/O: it exposes no way to reach the network', () => {
  assert.deepEqual(Object.keys(PS), ['buildProviderStatus', 'isInstalled']);
});
