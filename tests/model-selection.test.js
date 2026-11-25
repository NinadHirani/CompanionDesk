'use strict';

const test = require('node:test');
const assert = require('node:assert');
const MS = require('../src/model-selection');
const settings = require('../src/settings');
const screen = require('../src/screen');
const { createAi } = require('../src/ai');

const INSTALLED = ['llama3.2:latest', 'gemma3:4b', 'qwen2.5-coder:7b'];

// ---- chat resolution ---------------------------------------------------------

test('chat: a configured model that is installed is used as-is', () => {
  assert.deepEqual(MS.resolveChatModel({ configured: 'qwen2.5-coder:7b', installed: INSTALLED }), { model: 'qwen2.5-coder:7b', resolved: 'configured' });
});

test('chat: a configured name without a tag matches its installed family', () => {
  assert.deepEqual(MS.resolveChatModel({ configured: 'llama3.2', installed: INSTALLED }), { model: 'llama3.2', resolved: 'configured' });
});

test('chat: a configured model that disappeared falls back to the default', () => {
  assert.deepEqual(MS.resolveChatModel({ configured: 'mistral:7b', installed: INSTALLED }), { model: 'llama3.2:latest', resolved: 'fallback' });
});

test('chat: nothing installed still sends the default so the error path is unchanged', () => {
  assert.deepEqual(MS.resolveChatModel({ configured: '', installed: [] }), { model: 'llama3.2:latest', resolved: 'missing' });
});

// ---- vision resolution -------------------------------------------------------

const CAPS = { 'gemma3:4b': ['vision'], 'qwen2.5-coder:7b': ['tools', 'completion'], 'llama3.2:latest': ['tools'] };

test('vision: a configured verified vision model is used', () => {
  assert.deepEqual(MS.pickVisionModel({ configured: 'gemma3:4b', installed: INSTALLED, caps: CAPS }), { model: 'gemma3:4b', resolved: 'configured', visionVerified: true });
});

test('vision: a configured TEXT model is refused and the verified default is used instead', () => {
  assert.deepEqual(MS.pickVisionModel({ configured: 'qwen2.5-coder:7b', installed: INSTALLED, caps: CAPS }), { model: 'gemma3:4b', resolved: 'fallback', visionVerified: true });
});

test('vision: unknown capabilities allow an explicit choice but mark it unverified', () => {
  assert.deepEqual(MS.pickVisionModel({ configured: 'mystery:7b', installed: [...INSTALLED, 'mystery:7b'], caps: {} }), { model: 'mystery:7b', resolved: 'configured', visionVerified: null });
});

test('vision: the fallback default is never replaced by an unverified model', () => {
  assert.deepEqual(MS.pickVisionModel({ configured: '', installed: ['mystery:7b'], caps: {} }), { model: 'gemma3:4b', resolved: 'missing', visionVerified: null });
});

test('vision: when the default is absent, a verified alternative is picked', () => {
  assert.deepEqual(MS.pickVisionModel({ configured: '', installed: ['llava:7b', 'qwen2.5-coder:7b'], caps: { 'llava:7b': ['vision'] } }), { model: 'llava:7b', resolved: 'verified', visionVerified: true });
});

test('vision: nothing usable reports missing but still sends the default', () => {
  assert.deepEqual(MS.pickVisionModel({ configured: '', installed: ['qwen2.5-coder:7b'], caps: CAPS }), { model: 'gemma3:4b', resolved: 'missing', visionVerified: null });
});

// ---- settings validation -----------------------------------------------------

test('settings: valid model ids save; junk is refused; empty resets to default', () => {
  assert.deepEqual(settings.validatePatch({ ai_model_local: 'llama3.2:latest' }), { ok: true, clean: { ai_model_local: 'llama3.2:latest' }, errors: [] });
  assert.deepEqual(settings.validatePatch({ ai_model_vision: 'hf.co/org/model:Q4_K_M' }).ok, true);
  const bad = settings.validatePatch({ ai_model_local: 'llama 3' });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.errors, ['invalid_value:ai_model_local']);
  assert.equal(settings.validatePatch({ ai_model_local: '' }).clean.ai_model_local, '');
  assert.equal(settings.validatePatch({ ai_model_local: 42 }).ok, false);
  assert.equal(settings.isValidModelId('../../etc/passwd'), false);
});

test('settings: an invalid stored model id falls back to empty, not to the junk value', () => {
  assert.equal(settings.normalizeSettings({ ai_model_local: 'bad model; drop table', ai_model_vision: 'gemma3:4b' }).ai_model_local, '');
  assert.equal(settings.normalizeSettings({ ai_model_vision: 'gemma3:4b' }).ai_model_vision, 'gemma3:4b');
  assert.equal(settings.normalizeSettings({}).ai_model_local, '');
});

// ---- ai additions ------------------------------------------------------------

function mockFetch(routes) {
  return async (url, opts) => {
    for (const [match, handler] of routes) {
      const hit = typeof match === 'string' ? url.includes(match) : match(url, opts);
      if (hit) return handler(opts || {});
    }
    throw new Error('unrouted: ' + url);
  };
}

test('ai.listModels returns names, or null when Ollama is down', async () => {
  const up = createAi({ fetchImpl: mockFetch([['/api/tags', () => ({ ok: true, json: async () => ({ models: [{ name: 'llama3.2:latest' }] }) })]]) });
  assert.deepEqual(await up.listModels(), [{ name: 'llama3.2:latest' }]);
  const down = createAi({ fetchImpl: mockFetch([]) });
  assert.equal(await down.listModels(), null);
});

test('ai.modelCapabilities reports the capability list, or null when unreadable', async () => {
  const ai = createAi({ fetchImpl: mockFetch([['/api/show', (opts) => ({ ok: true, json: async () => ({ capabilities: JSON.parse(opts.body).model === 'gemma3:4b' ? ['vision'] : ['tools'] }) })]]) });
  assert.deepEqual(await ai.modelCapabilities('gemma3:4b'), ['vision']);
  assert.deepEqual(await ai.modelCapabilities('qwen2.5:7b'), ['tools']);
  const none = createAi({ fetchImpl: mockFetch([['/api/show', () => ({ ok: false })]]) });
  assert.equal(await none.modelCapabilities('gemma3:4b'), null);
});

test('ai.complete is local-only: the cloud is never called, so the local model name cannot leak', async () => {
  let cloudCalled = 0;
  const ai = createAi({
    geminiKey: 'k',
    cloudEnabled: true,
    fetchImpl: mockFetch([
      ['/api/chat', () => ({ ok: false, status: 500 })],
      [(url) => { if (url.includes('generativelanguage')) { cloudCalled += 1; return true; } return false; },
       () => ({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }) })],
    ]),
  });
  await assert.rejects(() => ai.complete({ prompt: 'hi', model: 'llama3.2:latest' }), /ollama_http_500/);
  assert.equal(cloudCalled, 0);
});

// ---- end-to-end resolution ---------------------------------------------------

function fakeAi(models, capsByModel) {
  return {
    localModel: MS.DEFAULT_CHAT_MODEL,
    listModels: async () => (models === null ? null : models.map((name) => ({ name }))),
    modelCapabilities: async (n) => (capsByModel && capsByModel[n]) || null,
  };
}

test('resolveModelSelection picks configured chat and verified vision end to end', async () => {
  const res = await MS.resolveModelSelection({ settings: { ai_model_local: 'qwen2.5-coder:7b' }, ai: fakeAi(INSTALLED, CAPS) });
  assert.equal(res.ollama, true);
  assert.deepEqual(res.chat, { model: 'qwen2.5-coder:7b', resolved: 'configured' });
  assert.deepEqual(res.vision, { model: 'gemma3:4b', resolved: 'fallback', visionVerified: true });
});

test('resolveModelSelection with Ollama down keeps both defaults and flags it', async () => {
  const res = await MS.resolveModelSelection({ settings: {}, ai: fakeAi(null) });
  assert.equal(res.ollama, false);
  assert.equal(res.chat.model, 'llama3.2:latest');
  assert.equal(res.vision.model, 'gemma3:4b');
  assert.equal(res.installed, null);
});

test('the capability probe cap is a ceiling: invalid maxProbes never zeroes it', async () => {
  const models = ['m1', 'm2', 'm3'];
  for (const bad of [0, -1, NaN, '2', null]) {
    const res = await MS.resolveModelSelection({ settings: {}, ai: fakeAi(models, {}), maxProbes: bad });
    assert.equal(Object.keys(res.caps).length, models.length, `maxProbes=${String(bad)} probes every model`);
  }
  const probed = [];
  const spyAi = {
    localModel: MS.DEFAULT_CHAT_MODEL,
    listModels: async () => models.map((name) => ({ name })),
    modelCapabilities: async (n) => { probed.push(n); return null; },
  };
  const res = await MS.resolveModelSelection({ settings: {}, ai: spyAi, maxProbes: 1 });
  assert.equal(probed.length, 1, 'a caller may only lower the cap');
  assert.equal(Object.keys(res.caps).length, 1);
});

test('the defaults in this module agree with screen.js', () => {
  assert.equal(MS.DEFAULT_VISION_MODEL, screen.DEFAULT_VISION_MODEL);
  assert.equal(MS.DEFAULT_CHAT_MODEL, 'llama3.2:latest');
});
