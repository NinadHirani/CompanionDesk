'use strict';

// Deterministic task router (M1). Pure: no fs, no network, no timers. Given
// explicit facts about the task, capabilities, privacy mode, cloud consent,
// provider health and which models are actually installed, it returns one
// routing decision. It never guesses, never infers, and never downloads.
//
// Policy (in this order):
//  1. Only known tasks route at all: 'chat' and 'vision'.
//  2. Local-only tasks (vision/screen/image) NEVER route to the cloud, no
//     matter what is enabled, consented, or keyed.
//  3. Local first: if Ollama is healthy and a usable local model is
//     installed, that is the route, even when cloud is fully enabled.
//  4. A cloud route requires ALL of: the task is cloud-eligible, the user's
//     privacy mode allows cloud, cloud use is explicitly enabled in
//     settings, explicit consent, a key is available, and the cloud
//     provider is healthy. A saved key alone routes nothing.
//  5. A model that is not installed is not downloaded and not assumed: the
//     router refuses or falls to the next known candidate.
// Dual-mode: require() in Electron/Node, plain <script> in the web/mobile
// build (window.CompanionTaskRouter).

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CompanionTaskRouter = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const Registry = (typeof module === 'object' && module.exports)
    ? require('./provider-registry')
    : (typeof self !== 'undefined' && self.CompanionProviderRegistry);

  // Same matching semantics as model-selection/ai.hasModel: a configured id
  // WITH a tag must match exactly; without a tag, the family is enough.
  function isPresent(name, installed) {
    const wanted = String(name || '');
    if (!wanted) return false;
    return (installed || []).some((m) => {
      const n = String(m || '');
      return wanted.includes(':') ? n === wanted : n.split(':')[0] === wanted.split(':')[0];
    });
  }

  function hasCapability(caps, model, capability) {
    const c = caps ? caps[model] : undefined;
    if (!Array.isArray(c)) return null; // unknown, never assumed
    return c.includes(capability);
  }

  function refuse(reason) {
    return { ok: false, provider: null, model: null, reason, cloudUsed: false };
  }
  function route(provider, model, reason, cloudUsed) {
    return { ok: true, provider, model, reason, cloudUsed: Boolean(cloudUsed) };
  }

  function routeTask(input = {}) {
    const {
      task,
      capabilities = {},        // { [modelId]: ['chat','vision'] | null }
      privacyMode = 'standard', // 'standard' | 'local_only'
      cloudEnabled = false,     // explicit settings opt-in, default off
      cloudConsent = false,     // explicit consent for cloud use
      cloudKeyAvailable = false,
      providerHealth = {},      // { ollama: true|false, gemini: true|false }
      installedModels = [],     // what Ollama reports installed, right now
      requestedModel = null,    // the user's selected local model, if any
      localModel = (Registry && Registry.DEFAULTS.localChat) || 'llama3.2:latest',
      // Chat and vision models are configured independently (as in
      // src/model-selection.js); a vision task tries the vision model.
      localVisionModel = (Registry && Registry.DEFAULTS.localVision) || 'gemma3:4b',
      cloudModel = (Registry && Registry.DEFAULTS.cloudChat) || 'gemini-2.0-flash',
    } = input;

    if (!Registry || !Registry.isKnownTask(task)) return refuse('unknown_task');

    const ollamaUp = providerHealth.ollama !== false;
    let localFailure = null;
    const localCandidates = [];
    const push = (m) => { if (m && !localCandidates.includes(m)) localCandidates.push(m); };
    push(requestedModel);
    push(task === 'vision' ? localVisionModel : localModel);
    push(localModel);

    if (ollamaUp) {
      for (const candidate of localCandidates) {
        if (!isPresent(candidate, installedModels)) continue; // never auto-download
        if (Registry.isLocalOnlyTask(task) || task === 'vision') {
          const v = hasCapability(capabilities, candidate, 'vision');
          if (v === false) continue; // a text model never answers a screenshot question
          if (v === null) return refuse('vision_unverified');
        }
        return route('ollama', candidate, candidate === requestedModel ? 'requested_model' : 'local_available', false);
      }
      // Local could not serve: missing model, or no vision-capable model.
      if (task === 'vision') return refuse('no_vision_model_local');
      localFailure = 'no_local_model';
    } else {
      localFailure = 'ollama_down';
    }

    // Cloud is only ever considered when the local path could not serve,
    // for a cloud-eligible task, with every gate explicitly open. Refusal
    // reasons, in order: a task the cloud may never serve reports why LOCAL
    // failed; the user's privacy mode is named as the hard block it is;
    // while cloud use is not enabled in settings, the actionable fact is
    // still why local failed. A key alone never arms anything.
    localFailure = localFailure || 'no_local_model';
    if (!Registry.isCloudEligibleTask(task)) return refuse(localFailure);
    if (privacyMode === 'local_only') return refuse('privacy_local_only');
    if (!cloudEnabled) return refuse(localFailure);
    if (!cloudConsent) return refuse('no_cloud_consent');
    if (!cloudKeyAvailable) return refuse('no_cloud_key');
    if (providerHealth.gemini === false) return refuse('cloud_provider_down');
    const cloudCap = hasCapability(capabilities, cloudModel, 'chat');
    if (cloudCap === false) return refuse('cloud_model_unsuitable');
    return route('gemini', cloudModel, 'cloud_fallback', true);
  }

  return { routeTask, isPresent, hasCapability };
});
