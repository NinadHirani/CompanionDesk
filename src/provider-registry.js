'use strict';

// Provider and model registry (M1). Pure data and pure lookups: no fs, no
// network, no side effects. It DESCRIBES providers and specific model ids;
// the task router (src/task-router.js) decides where a task may run, and
// settings hold the user's choices. Nothing here downloads, installs, or
// contacts anything.
//
// Rules this file keeps:
//  - Every model entry is an EXACT id and version (for Ollama, the exact
//    tag). There are no family-level entries, and nothing is inferred from a
//    model family: "llama3.2" is not "llama3.2:latest", and a different tag
//    is a different entry that needs its own verified metadata.
//  - License, context length, and cost are UNKNOWN until verified. They are
//    null here on purpose. Never fill them in from family knowledge.
//  - Privacy attributes state where data goes for that provider, which is a
//    fact of the transport, not a claim about any specific model.
// Dual-mode: require() in Electron/Node, plain <script> in the web/mobile
// build (window.CompanionProviderRegistry).

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CompanionProviderRegistry = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const PROVIDERS = Object.freeze({
    ollama: Object.freeze({
      id: 'ollama',
      name: 'Ollama (local)',
      locality: 'local',
      cloud: false,
      requiresKey: false,
      health: 'HTTP GET /api/tags on the local Ollama server',
      notes: 'The default and only required provider. Prompts and images stay on this device.',
    }),
    gemini: Object.freeze({
      id: 'gemini',
      name: 'Google Gemini (cloud, optional)',
      locality: 'cloud',
      cloud: true,
      requiresKey: true,
      consentRequired: true,
      health: 'HTTP GET /v1beta/models on the Generative Language API',
      notes: 'Optional fallback, off unless the user both saves a key and enables cloud use in settings.',
    }),
  });

  // Exact-id model entries. license: verified license name, null until
  // verified (never inferred from the family). contextTokens: verified
  // context window, null until verified. cost: verified cost note, null
  // until verified. privacy states where the prompt and attachments go.
  const MODELS = Object.freeze({
    ollama: Object.freeze({
      'llama3.2:latest': Object.freeze({
        id: 'llama3.2:latest',
        provider: 'ollama',
        version: 'latest tag as served by the installed model',
        capabilities: Object.freeze(['chat']),
        license: null, // unverified for this exact id
        contextTokens: null, // unverified
        cost: 'free (runs on this device; no data leaves it)',
        privacy: 'prompt, history and any images stay on this device',
        role: 'default local chat model',
      }),
      'gemma3:4b': Object.freeze({
        id: 'gemma3:4b',
        provider: 'ollama',
        version: '4b as served by the installed model',
        capabilities: Object.freeze(['chat', 'vision']),
        license: null, // unverified for this exact id
        contextTokens: null, // unverified
        cost: 'free (runs on this device; no data leaves it)',
        privacy: 'prompt, history and any images stay on this device',
        role: 'default local vision (screen/image) model',
      }),
    }),
    gemini: Object.freeze({
      'gemini-2.0-flash': Object.freeze({
        id: 'gemini-2.0-flash',
        provider: 'gemini',
        version: '2.0-flash as served by the API',
        capabilities: Object.freeze(['chat']),
        license: null, // unverified for this exact id
        contextTokens: null, // unverified
        cost: null, // unverified; free-tier quotas may apply, verify before enabling
        privacy: 'prompt, cloudArgs and any attached images are sent to Google',
        role: 'optional cloud chat fallback',
      }),
    }),
  });

  // Defaults preserved from the app's existing model-selection settings
  // (src/model-selection.js). The registry does not change them.
  const DEFAULTS = Object.freeze({
    localChat: 'llama3.2:latest',
    localVision: 'gemma3:4b',
    cloudChat: 'gemini-2.0-flash',
  });

  const TASKS = Object.freeze(['chat', 'vision']);
  // Screen/image analysis never leaves the device, whatever the settings say.
  const LOCAL_ONLY_TASKS = Object.freeze(['vision']);
  // Tasks a cloud provider may serve, and only with explicit consent.
  const CLOUD_ELIGIBLE_TASKS = Object.freeze(['chat']);

  function isLocalOnlyTask(task) { return LOCAL_ONLY_TASKS.includes(task); }
  function isCloudEligibleTask(task) { return CLOUD_ELIGIBLE_TASKS.includes(task); }

  function listProviders() { return Object.keys(PROVIDERS).map((k) => PROVIDERS[k]); }
  function getProvider(id) { return PROVIDERS[id] || null; }
  function listModels(providerId) {
    const m = MODELS[providerId];
    return m ? Object.keys(m).map((k) => m[k]) : [];
  }
  function getModel(providerId, modelId) {
    const m = MODELS[providerId];
    return (m && m[modelId]) || null; // exact id only; no family fallback
  }
  function isKnownTask(task) { return TASKS.includes(task); }

  return {
    PROVIDERS, MODELS, DEFAULTS, TASKS, LOCAL_ONLY_TASKS, CLOUD_ELIGIBLE_TASKS,
    isLocalOnlyTask, isCloudEligibleTask, isKnownTask,
    listProviders, getProvider, listModels, getModel,
  };
});
