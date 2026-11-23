'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { routeTask } = require('../src/task-router');

// A fully-open cloud path for tests: everything the user would have to do.
const CLOUD_OPEN = {
  cloudEnabled: true,
  cloudConsent: true,
  cloudKeyAvailable: true,
  providerHealth: { ollama: true, gemini: true },
};

test('unknown tasks never route', () => {
  for (const task of [undefined, null, '', 'summarize', 'chat ']) {
    assert.equal(routeTask({ task }).ok, false, String(task));
    assert.equal(routeTask({ task }).reason, 'unknown_task');
  }
});

test('chat routes local-first even when cloud is fully enabled', () => {
  const d = routeTask({
    task: 'chat', installedModels: ['llama3.2:latest'], localModel: 'llama3.2:latest', ...CLOUD_OPEN,
  });
  assert.deepEqual({ ok: d.ok, provider: d.provider, model: d.model, cloudUsed: d.cloudUsed },
    { ok: true, provider: 'ollama', model: 'llama3.2:latest', cloudUsed: false });
  assert.equal(d.reason, 'local_available');
});

test('a requested local model is honored when installed, family match allowed', () => {
  const exact = routeTask({ task: 'chat', installedModels: ['qwen2.5:7b'], requestedModel: 'qwen2.5:7b', localModel: 'llama3.2:latest' });
  assert.equal(exact.model, 'qwen2.5:7b');
  assert.equal(exact.reason, 'requested_model');
  const family = routeTask({ task: 'chat', installedModels: ['qwen2.5:7b'], requestedModel: 'qwen2.5', localModel: 'llama3.2:latest' });
  assert.equal(family.model, 'qwen2.5');
  // exact-tag requests demand the exact tag
  const missingClosed = routeTask({ task: 'chat', installedModels: ['qwen2.5:3b'], requestedModel: 'qwen2.5:7b', localModel: 'llama3.2:latest' });
  assert.equal(missingClosed.reason, 'no_local_model'); // no silent model swap, no download
  const missingOpen = routeTask({ task: 'chat', installedModels: ['qwen2.5:3b'], requestedModel: 'qwen2.5:7b', localModel: 'llama3.2:latest', ...CLOUD_OPEN });
  assert.equal(missingOpen.ok, true); // the honest fallback is the cloud path...
  assert.equal(missingOpen.provider, 'gemini'); // ...never a substituted local model
});

test('a requested model that is missing falls to the default local model when installed', () => {
  const d = routeTask({ task: 'chat', installedModels: ['llama3.2:latest'], requestedModel: 'mistral:latest', localModel: 'llama3.2:latest' });
  assert.equal(d.model, 'llama3.2:latest');
  assert.equal(d.reason, 'local_available'); // still local, never cloud, never a download
  assert.ok(!d.cloudUsed);
});

test('no model is ever auto-downloaded: uninstalled models are not routed', () => {
  const d = routeTask({ task: 'chat', installedModels: [], requestedModel: 'mistral:latest', localModel: 'llama3.2:latest' });
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'no_local_model'); // cloud disabled by default
  assert.equal(d.cloudUsed, false);
});

test('local-only: vision never routes cloud, whatever is enabled or keyed', () => {
  for (const health of [{ ollama: true, gemini: true }]) {
    const d = routeTask({
      ...CLOUD_OPEN,
      task: 'vision', installedModels: ['gemma3:4b'],
      capabilities: { 'gemma3:4b': ['vision'] }, providerHealth: health,
    });
    assert.equal(d.ok, true);
    assert.equal(d.provider, 'ollama');
    assert.equal(d.cloudUsed, false);
  }
  const down = routeTask({
    ...CLOUD_OPEN, task: 'vision', installedModels: [], providerHealth: { ollama: false, gemini: true },
  });
  assert.equal(down.ok, false);
  assert.equal(down.reason, 'ollama_down'); // refused, not sent to the cloud
  assert.equal(down.cloudUsed, false);
});

test('vision capability: a text model refuses; unverified capability refuses closed', () => {
  const textOnly = routeTask({
    task: 'vision', installedModels: ['llama3.2:latest', 'gemma3:4b'],
    capabilities: { 'gemma3:4b': ['vision'], 'llama3.2:latest': ['chat'] },
    requestedModel: 'llama3.2:latest', localModel: 'gemma3:4b',
  });
  assert.equal(textOnly.model, 'gemma3:4b'); // text-only requested, capable default chosen
  const unknownCaps = routeTask({
    task: 'vision', installedModels: ['llama3.2:latest'], capabilities: { 'llama3.2:latest': null }, localModel: 'llama3.2:latest',
  });
  assert.equal(unknownCaps.ok, false);
  assert.equal(unknownCaps.reason, 'vision_unverified');
  const noVisionAtAll = routeTask({
    task: 'vision', installedModels: ['llama3.2:latest'], capabilities: { 'llama3.2:latest': ['chat'] }, localModel: 'llama3.2:latest',
  });
  assert.equal(noVisionAtAll.ok, false);
  assert.equal(noVisionAtAll.reason, 'no_vision_model_local');
});

test('a key alone routes nothing: cloud_enabled defaults off', () => {
  // Local failed AND the key is present AND consent is recorded, yet cloud
  // use is not enabled: nothing routes, and certainly not to the cloud.
  const d = routeTask({
    task: 'chat', installedModels: [], localModel: 'llama3.2:latest',
    cloudConsent: true, cloudKeyAvailable: true, providerHealth: { ollama: true, gemini: true },
  });
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'no_local_model');
  assert.equal(d.cloudUsed, false);
  assert.equal(d.provider, null);
  // Same with Ollama down entirely: still refused, never routed cloud.
  const down = routeTask({
    task: 'chat', installedModels: [], localModel: 'llama3.2:latest',
    cloudConsent: true, cloudKeyAvailable: true, providerHealth: { ollama: false, gemini: true },
  });
  assert.equal(down.ok, false);
  assert.equal(down.reason, 'ollama_down');
  assert.equal(down.cloudUsed, false);
});

test('consent is separate from the key and from the setting', () => {
  const base = { task: 'chat', installedModels: [], localModel: 'llama3.2:latest', providerHealth: { ollama: true, gemini: true } };
  const noConsent = routeTask({ ...base, cloudEnabled: true, cloudKeyAvailable: true });
  assert.equal(noConsent.reason, 'no_cloud_consent');
  const noKey = routeTask({ ...base, cloudEnabled: true, cloudConsent: true });
  assert.equal(noKey.reason, 'no_cloud_key');
  const both = routeTask({ ...base, cloudEnabled: true, cloudConsent: true, cloudKeyAvailable: true });
  assert.equal(both.ok, true);
  assert.equal(both.provider, 'gemini');
  assert.equal(both.reason, 'cloud_fallback');
  assert.equal(both.cloudUsed, true);
});

test('privacy mode local_only blocks cloud even with everything open', () => {
  const d = routeTask({
    task: 'chat', installedModels: [], localModel: 'llama3.2:latest',
    privacyMode: 'local_only', providerHealth: { ollama: true, gemini: true }, ...CLOUD_OPEN,
  });
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'privacy_local_only');
});

test('provider health is respected on both sides', () => {
  const geminiDown = routeTask({
    ...CLOUD_OPEN, task: 'chat', installedModels: [], localModel: 'llama3.2:latest',
    providerHealth: { ollama: true, gemini: false },
  });
  assert.equal(geminiDown.reason, 'cloud_provider_down');
  const ollamaDownCloudUp = routeTask({
    ...CLOUD_OPEN, task: 'chat', installedModels: ['llama3.2:latest'], localModel: 'llama3.2:latest',
    providerHealth: { ollama: false, gemini: true },
  });
  assert.equal(ollamaDownCloudUp.provider, 'gemini'); // local down, cloud open: the one path to cloud
  assert.equal(ollamaDownCloudUp.cloudUsed, true);
  const bothDown = routeTask({
    ...CLOUD_OPEN, task: 'chat', installedModels: [], localModel: 'llama3.2:latest',
    providerHealth: { ollama: false, gemini: false },
  });
  assert.equal(bothDown.ok, false);
  assert.equal(bothDown.reason, 'cloud_provider_down');
});

test('every refusal never names a model or provider to use', () => {
  const refusals = [
    routeTask({ task: 'chat', installedModels: [] }),
    routeTask({ task: 'vision', installedModels: [], providerHealth: { ollama: false } }),
    routeTask({ ...CLOUD_OPEN, task: 'chat', installedModels: [], providerHealth: { ollama: true, gemini: false } }),
  ];
  for (const r of refusals) {
    assert.equal(r.ok, false);
    assert.equal(r.provider, null);
    assert.equal(r.model, null);
    assert.equal(r.cloudUsed, false);
  }
});
