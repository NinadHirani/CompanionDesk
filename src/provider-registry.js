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
//    null here on purpose. Never fill them in from family knowledge. When a
//    fact IS verified against a primary source, it carries a `verified`
//    object with the verification date and the exact sources; anything not
//    sourced stays null. No benchmark or quality claim is recorded here:
//    those come only from measured runs (Gate 1), never from model cards.
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

  // Fixed capability vocabulary. A capability is recorded on an entry only
  // when its primary source documents it for that exact id; reasoning and
  // coding stay UNRECORDED for every current entry (no verified source
  // claims them here; model-card marketing is not a verified claim).
  const CAPABILITIES = Object.freeze(['chat', 'vision', 'reasoning', 'coding', 'tool_use', 'multilingual']);

  // Exact-id model entries. license: verified license name, null until
  // verified (never inferred from the family). contextTokens: verified
  // context window, null until verified. cost: verified cost note, null
  // until verified. privacy states where the prompt and attachments go.
  // verified: null until facts are checked against a primary source, then
  // { at, sources, notes? } - the date, the exact URLs read, and anything
  // the sources could NOT settle (open questions are recorded, never
  // resolved by guesswork).
  const MODELS = Object.freeze({
    ollama: Object.freeze({
      'llama3.2:latest': Object.freeze({
        id: 'llama3.2:latest',
        provider: 'ollama',
        version: 'latest tag as served by the installed model',
        capabilities: Object.freeze(['chat', 'multilingual']),
        license: 'Llama 3.2 Community License', // custom, commercial; not an OSI open-source license
        contextTokens: 128000, // text models 1B and 3B, per Meta's model card
        cost: 'free (runs on this device; no data leaves it)',
        privacy: 'prompt, history and any images stay on this device',
        role: 'default local chat model',
        verified: Object.freeze({
          at: '2026-11-24',
          sources: [
            'https://github.com/meta-llama/llama-models/blob/main/models/llama3_2/MODEL_CARD.md',
            'https://github.com/meta-llama/llama-models/blob/main/models/llama3_2/LICENSE',
          ],
          notes: ['1B and 3B are text models, 128k context, multilingual text in/out; Hindi is in the officially supported language list', 'community license terms govern use and redistribution; read before any redistribution'],
        }),
      }),
      'gemma3:4b': Object.freeze({
        id: 'gemma3:4b',
        provider: 'ollama',
        version: '4b as served by the installed model',
        capabilities: Object.freeze(['chat', 'vision', 'multilingual']),
        license: 'Gemma Terms of Use', // Google's custom open-weight terms, not an OSI license
        contextTokens: 128000, // 4B size, per the Gemma 3 model card
        cost: 'free (runs on this device; no data leaves it)',
        privacy: 'prompt, history and any images stay on this device',
        role: 'default local vision (screen/image) model',
        verified: Object.freeze({
          at: '2026-11-24',
          sources: [
            'https://ai.google.dev/gemma/docs/core/model_card_3',
          ],
          notes: ['4B takes image+text input and outputs text; 128K-token context; 140+ languages', 'images are encoded at 896x896 to 256 tokens each, per the model card'],
        }),
      }),
    }),
    gemini: Object.freeze({
      'gemini-2.0-flash': Object.freeze({
        id: 'gemini-2.0-flash',
        provider: 'gemini',
        version: '2.0-flash as served by the API',
        capabilities: Object.freeze(['chat', 'tool_use', 'multilingual']),
        license: null, // an API model, not redistributed weights; no verified license fact to record
        contextTokens: 1048576, // input context, per Google's documented model spec
        cost: null, // free-tier quotas may apply; verify current terms before enabling
        privacy: 'prompt, cloudArgs and any attached images are sent to Google',
        role: 'optional cloud chat fallback',
        status: 'retired', // selectable as a working provider: never. The gateway refuses before any cloud probe or call.
        retiredOn: '2026-06-01',
        verified: Object.freeze({
          at: '2026-11-24',
          sources: [
            'https://docs.cloud.google.com/gemini-enterprise-agent-platform/release-notes (June 01, 2026 entry: "Gemini 2.0 Flash and 2.0 Flash-Lite are discontinued" - model serving and Provisioned Throughput both)',
            'https://discuss.ai.google.dev/t/request-for-access-review-403-permission-denied-on-gemini-tts-preview-mode/180122/2 (official Gemini developer forum, Google staff: "gemini-2.0-flash was retired on June 1, 2026")',
            'https://ai.google.dev/gemini-api/docs/models (renders blank in our tooling; context and tool-use facts rest on multiple consistent secondary reports)',
          ],
          notes: [
            'VERIFIED RETIRED June 1, 2026, read live from both sources on 24 Nov 2026. Path distinction recorded: CompanionDesk\'s fallback uses the Gemini DEVELOPER API (generativelanguage.googleapis.com/v1beta, key in the x-goog-api-key header, never Vertex); the release note is on the Gemini Enterprise Agent Platform surface, and the official developer forum states the retirement for the Developer API path - both name the same date.',
            'The default cloud model setting is unchanged and the user\'s key is preserved; no replacement model is registered or substituted silently. Registering a current cloud fallback (a newer Flash id may require billing) is Ninad\'s explicit decision.',
            'function calling (tool_use) is documented for this id by secondary sources; treated as verified-by-consensus, not primary-source-confirmed',
          ],
        }),
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
  function isKnownCapability(cap) { return CAPABILITIES.includes(cap); }
  // A retired model id can never be selected as a working provider.
  // Unknown ids are not managed here (the router's capability check
  // already refuses them), so they pass through.
  function isSelectable(providerId, modelId) {
    const m = getModel(providerId, modelId);
    return !m || m.status !== 'retired';
  }

  return {
    PROVIDERS, MODELS, DEFAULTS, TASKS, LOCAL_ONLY_TASKS, CLOUD_ELIGIBLE_TASKS, CAPABILITIES,
    isLocalOnlyTask, isCloudEligibleTask, isKnownTask, isKnownCapability, isSelectable,
    listProviders, getProvider, listModels, getModel,
  };
});
