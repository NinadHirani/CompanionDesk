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

test('every fact is either verified with sources or stays null; capabilities stay in the fixed vocabulary', () => {
  for (const providerId of Object.keys(Registry.MODELS)) {
    for (const m of Registry.listModels(providerId)) {
      assert.equal(typeof m.privacy, 'string', `${providerId}/${m.id} privacy is a transport fact`);
      assert.ok(Array.isArray(m.capabilities) && m.capabilities.length, `${providerId}/${m.id} capabilities listed`);
      for (const cap of m.capabilities) {
        assert.equal(Registry.isKnownCapability(cap), true, `${providerId}/${m.id} capability ${cap} must be in the vocabulary`);
      }
      if (m.verified) {
        assert.equal(typeof m.verified.at, 'string', `${providerId}/${m.id} verified.at`);
        assert.ok(Array.isArray(m.verified.sources) && m.verified.sources.every((s) => s.startsWith('https://')), `${providerId}/${m.id} verified.sources are URLs`);
        assert.ok(m.license || m.contextTokens, `${providerId}/${m.id} a verified entry carries at least one verified fact`);
      }
      // nothing is ever recorded without a verified object backing it
      if (m.license !== null || m.contextTokens !== null) assert.ok(m.verified, `${providerId}/${m.id} verified facts carry their verification`);
      // no benchmark or quality numbers live here
      assert.ok(!('benchmark' in m) && !('quality' in m), `${providerId}/${m.id} no quality claims in the registry`);
    }
  }
});

test('verified metadata: the three current ids carry their checked facts and open questions', () => {
  const llama = Registry.getModel('ollama', 'llama3.2:latest');
  assert.equal(llama.license, 'Llama 3.2 Community License');
  assert.equal(llama.contextTokens, 128000);
  assert.ok(llama.capabilities.includes('multilingual')); // Hindi is in the officially supported list
  const gemma = Registry.getModel('ollama', 'gemma3:4b');
  assert.equal(gemma.license, 'Gemma Terms of Use');
  assert.equal(gemma.contextTokens, 128000);
  assert.ok(gemma.capabilities.includes('vision') && gemma.capabilities.includes('multilingual'));
  const gemini = Registry.getModel('gemini', 'gemini-2.0-flash');
  assert.equal(gemini.license, null); // API model: no weights license fact to record
  assert.equal(gemini.contextTokens, 1048576);
  assert.ok(gemini.capabilities.includes('tool_use'));
  // VERIFIED (24 Nov 2026): retired June 1, 2026 on the Developer API
  // path (official developer forum) and the Agent Platform surface
  // (Google Cloud release notes, June 01 2026 breaking entry).
  assert.equal(gemini.status, 'retired');
  assert.equal(gemini.retiredOn, '2026-06-01');
  assert.ok(gemini.verified.notes.some((n) => n.includes('VERIFIED RETIRED')));
  assert.ok(gemini.verified.notes.some((n) => n.includes('DEVELOPER API')));
  assert.ok(gemini.verified.sources.some((s) => s.includes('docs.cloud.google.com')));
  assert.ok(gemini.verified.sources.some((s) => s.includes('discuss.ai.google.dev')));
});

test('isSelectable: retired ids can never be selected as a working provider', () => {
  assert.equal(Registry.isSelectable('gemini', 'gemini-2.0-flash'), false);
  assert.equal(Registry.isSelectable('ollama', 'llama3.2:latest'), true);
  assert.equal(Registry.isSelectable('ollama', 'gemma3:4b'), true);
  assert.equal(Registry.isSelectable('gemini', 'gemini-9.9-future'), true); // unknown: not registry-managed
});

test('capabilities and defaults match current app behavior', () => {
  assert.deepEqual(Registry.getModel('ollama', 'llama3.2:latest').capabilities, ['chat', 'multilingual']);
  assert.ok(Registry.getModel('ollama', 'gemma3:4b').capabilities.includes('vision'));
  assert.deepEqual(Registry.getModel('gemini', 'gemini-2.0-flash').capabilities, ['chat', 'tool_use', 'multilingual']);
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

test('capability vocabulary is fixed and conservative; unknown names are refused', () => {
  assert.deepEqual(Registry.CAPABILITIES, ['chat', 'vision', 'reasoning', 'coding', 'tool_use', 'multilingual']);
  assert.equal(Registry.isKnownCapability('tool_use'), true);
  assert.equal(Registry.isKnownCapability('agent-execution'), false);
  // no current entry claims reasoning or coding: nothing verified said they do
  for (const providerId of Object.keys(Registry.MODELS)) {
    for (const m of Registry.listModels(providerId)) {
      assert.ok(!m.capabilities.includes('reasoning') && !m.capabilities.includes('coding'), `${providerId}/${m.id} must not claim unverified reasoning/coding`);
    }
  }
});
