'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Registry = require('../src/provider-registry');

test('providers: ollama local-only, gemini optional cloud needing key and consent', () => {
  const ollama = Registry.getProvider('ollama');
  const gemini = Registry.getProvider('gemini');
  assert.equal(ollama.locality, 'local');
  assert.equal(ollama.cloud, false);
  assert.equal(ollama.requiresKey, false);
  assert.equal(gemini.locality, 'cloud');
  assert.equal(gemini.cloud, true);
  assert.equal(gemini.requiresKey, true);
  assert.equal(gemini.consentRequired, true);
  assert.deepEqual(Registry.listProviders().map((p) => p.id).sort(), ['gemini', 'ollama']);
  assert.equal(Registry.getProvider('openai'), null); // only described providers exist
});

test('models are exact ids; no family-level entries, no inference across tags', () => {
  assert.ok(Registry.getModel('ollama', 'llama3.2:latest'));
  assert.equal(Registry.getModel('ollama', 'llama3.2'), null); // no-tag id is not an entry
  assert.equal(Registry.getModel('ollama', 'llama3:latest'), null); // different family/tag
  assert.equal(Registry.getModel('ollama', 'llama3.2:4b'), null); // another tag needs its own entry
  assert.ok(Registry.getModel('gemini', 'gemini-2.0-flash'));
  assert.equal(Registry.getModel('gemini', 'gemini-1.5-flash'), null);
  // every Ollama entry is a fully-tagged id; every Gemini entry a full
  // versioned model name; no bare family names anywhere
  for (const id of Object.keys(Registry.MODELS.ollama)) assert.ok(id.includes(':'), id);
  for (const id of Object.keys(Registry.MODELS.gemini)) assert.ok(/^[a-z0-9.-]+$/.test(id) && id.includes('-'), id);
});

test('license, context and cost are unknown until verified, for every entry', () => {
  for (const providerId of Object.keys(Registry.MODELS)) {
    for (const m of Registry.listModels(providerId)) {
      assert.equal(m.license, null, `${providerId}/${m.id} license must stay unverified`);
      assert.equal(m.contextTokens, null, `${providerId}/${m.id} context must stay unverified`);
      assert.equal(typeof m.privacy, 'string', `${providerId}/${m.id} privacy is a transport fact`);
      assert.ok(Array.isArray(m.capabilities) && m.capabilities.length, `${providerId}/${m.id} capabilities listed`);
    }
  }
});

test('capabilities and defaults match current app behavior', () => {
  assert.deepEqual(Registry.getModel('ollama', 'llama3.2:latest').capabilities, ['chat']);
  assert.ok(Registry.getModel('ollama', 'gemma3:4b').capabilities.includes('vision'));
  assert.deepEqual(Registry.getModel('gemini', 'gemini-2.0-flash').capabilities, ['chat']);
  assert.equal(Registry.DEFAULTS.localChat, 'llama3.2:latest');
  assert.equal(Registry.DEFAULTS.localVision, 'gemma3:4b');
  assert.equal(Registry.DEFAULTS.cloudChat, 'gemini-2.0-flash');
});

test('task eligibility: chat may go cloud; vision is local-only', () => {
  assert.equal(Registry.isCloudEligibleTask('chat'), true);
  assert.equal(Registry.isCloudEligibleTask('vision'), false);
  assert.equal(Registry.isLocalOnlyTask('vision'), true);
  assert.equal(Registry.isLocalOnlyTask('chat'), false);
  assert.equal(Registry.isKnownTask('summarize'), false);
});
