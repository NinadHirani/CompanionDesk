'use strict';

// Provider status: one read-only snapshot of what can answer right now, for
// the Settings view. Built ONLY from facts already gathered by bounded local
// probes (the Ollama /api/tags and /api/show reads in src/ai.js) and the OS
// credential vault's masked booleans; this module itself does no I/O at all.
// It NEVER contacts the cloud: Gemini's reachability is probed only when the
// user explicitly tests the key or an already-consented cloud request runs.
// The output carries booleans and model names only - no key material can
// appear here because none is ever passed in.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CompanionProviderStatus = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // Fault objects arriving here come from upstream callers; nothing crosses
  // this module's output unnormalized (review fix, 23 Nov 2026). The shared
  // sanitizer (src/provider-faults.js) is used when present; without it the
  // module fails closed and emits no fault at all rather than an
  // unverified one.
  function faultsMod() {
    if (typeof module === 'object' && module.exports) return require('./provider-faults');
    return (typeof self !== 'undefined' && self.CompanionProviderFaults) || null;
  }
  function cleanFault(f) {
    const F = faultsMod();
    return F ? F.fault(f) : null;
  }
  // Same family-match semantics as ai.hasModel and model-selection: a name
  // without a tag matches any tag of the same family.
  function isInstalled(name, installed) {
    const wanted = String(name || '');
    if (!wanted) return false;
    return (installed || []).some((m) => {
      const n = String(m || '');
      return wanted.includes(':') ? n === wanted : n.split(':')[0] === wanted.split(':')[0];
    });
  }

  // ollamaUp: true / false / null (null = not probed or unknown).
  // installed: array of model names, or null when the server was unreachable.
  // chat: { model, resolved } from model-selection; vision: { model,
  // resolved, visionVerified }. secureStore: the masked status object
  // ({ supported, encryptionAvailable, configured }) or null. cloudEnabled:
  // the settings flag. Everything else is derived; nothing throws.
  function buildProviderStatus({ ollamaUp = null, installed = null, chat = null, vision = null, secureStore = null, cloudEnabled = false, ollamaFault = null, caps = null, capsFaults = null } = {}) {
    const up = ollamaUp === true;
    const down = ollamaUp === false;
    const chatModel = String((chat && chat.model) || '');
    const visionModel = String((vision && vision.model) || '');

    const chatInstalled = up && Array.isArray(installed) && chatModel ? isInstalled(chatModel, installed) : null;
    let capability;
    if (down) capability = 'unreachable';
    else if (!up) capability = 'unknown';
    else if ((vision && vision.visionVerified) === true) capability = 'verified';
    // Typed capability facts (slice 6): the chosen vision model exists but
    // /api/show says it cannot do vision at all is 'unsuitable', distinct
    // from 'unknown' (unreadable or not probed).
    else if (caps && visionModel && Array.isArray(caps[visionModel]) && caps[visionModel].indexOf('vision') === -1) capability = 'unsuitable';
    else capability = 'unknown';
    const visionFault = cleanFault(capsFaults && visionModel ? capsFaults[visionModel] : null);
    const chatFault = (up && chatInstalled === false) ? cleanFault({ code: 'model_missing', detail: null }) : null;

    const knownStorage = Boolean(secureStore && typeof secureStore === 'object');
    const supported = Boolean(secureStore && secureStore.supported);
    const keySaved = Boolean(secureStore && secureStore.configured);
    const enabled = cloudEnabled === true;
    let state;
    if (!keySaved && !enabled) state = 'off';
    else if (keySaved && !enabled) state = 'configured_disabled';
    else if (!keySaved && enabled) state = 'enabled_no_key';
    else state = supported ? 'armed' : 'no_secure_storage'; // key + enabled but no real vault: fail closed

    return {
      ollama: { reachable: ollamaUp === null ? null : up, fault: cleanFault(ollamaFault) },
      chat: { model: chatModel, installed: chatInstalled, fault: chatFault },
      vision: { model: visionModel, capability, fault: visionFault },
      cloud: {
        enabled,
        keySaved,
        armed: state === 'armed',
        state,
        storage: knownStorage ? (supported ? 'os_vault' : 'unavailable') : 'unknown',
      },
      credentialStorage: { available: knownStorage ? supported : null },
    };
  }

  return { buildProviderStatus, isInstalled };
});
