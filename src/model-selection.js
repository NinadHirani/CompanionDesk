'use strict';

// Model selection: which installed Ollama model answers, without ever
// pulling anything on its own. Pure logic over the list of models Ollama
// reports as installed; the settings layer validates ids, this layer picks
// and falls back. Dual-mode: require() in Electron/Node, plain <script> in
// the web/mobile build (window.CompanionModelSelection).
//
// Chat and screen-vision models are configured INDEPENDENTLY: a text model
// must never silently answer a screenshot question. The vision picker
// accepts a model Ollama reports with the "vision" capability, or a model
// whose capabilities it could not read (the UI marks that unverified), and
// falls back to the known vision default otherwise.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CompanionModelSelection = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const DEFAULT_CHAT_MODEL = 'llama3.2:latest';
  const DEFAULT_VISION_MODEL = 'gemma3:4b';
  const MAX_PROBES = 20; // /api/show calls per resolution, at most

  // Ollama reports installed models with names like "llama3.2:latest". A
  // configured name WITH a tag must match exactly; without a tag the family
  // is enough (same semantics as ai.hasModel).
  function isPresent(name, installed) {
    const wanted = String(name || '');
    if (!wanted) return false;
    return (installed || []).some((m) => {
      const n = String(m || '');
      return wanted.includes(':') ? n === wanted : n.split(':')[0] === wanted.split(':')[0];
    });
  }

  // configured: stored setting ('' = use the default). Returns the model to
  // send and how it was decided. 'missing' still sends the fallback, so the
  // existing model-absent error path and its friendly message are unchanged.
  function resolveChatModel({ configured, fallback = DEFAULT_CHAT_MODEL, installed } = {}) {
    if (configured && isPresent(configured, installed)) return { model: configured, resolved: 'configured' };
    return { model: fallback, resolved: isPresent(fallback, installed) ? 'fallback' : 'missing' };
  }

  // caps: { modelName: ['vision', ...] | null }. null means capabilities
  // could not be read (an older Ollama, or the model vanished mid-check);
  // such a model is allowed only as an EXPLICIT user choice, never picked
  // by the picker itself, and the UI marks it unverified.
  function visionStatus(name, caps) {
    const c = caps && caps[name];
    if (!Array.isArray(c)) return 'unknown';
    return c.includes('vision') ? 'vision' : 'text';
  }

  function pickVisionModel({ configured, fallback = DEFAULT_VISION_MODEL, installed, caps } = {}) {
    if (configured && isPresent(configured, installed)) {
      const s = visionStatus(configured, caps);
      if (s === 'vision') return { model: configured, resolved: 'configured', visionVerified: true };
      if (s === 'unknown') return { model: configured, resolved: 'configured', visionVerified: null };
      // 'text': Ollama says this model cannot see images. Refuse it.
    }
    if (isPresent(fallback, installed)) {
      const s = visionStatus(fallback, caps);
      if (s !== 'text') return { model: fallback, resolved: 'fallback', visionVerified: s === 'vision' ? true : null };
    }
    const verified = (installed || []).find((n) => visionStatus(n, caps) === 'vision');
    if (verified) return { model: verified, resolved: 'verified', visionVerified: true };
    return { model: fallback, resolved: 'missing', visionVerified: null };
  }

  // One resolution for a whole ask/status cycle. ai must provide
  // listModels() (array of {name} or null when Ollama is unreachable) and
  // modelCapabilities(name) (array or null).
  async function resolveModelSelection({ settings = {}, ai, chatFallback = DEFAULT_CHAT_MODEL, visionFallback = DEFAULT_VISION_MODEL, maxProbes = MAX_PROBES } = {}) {
    const installed = await ai.listModels();
    if (installed === null) {
      return {
        ollama: false,
        installed: null,
        caps: null,
        chat: { model: chatFallback, resolved: 'ollama_down' },
        vision: { model: visionFallback, resolved: 'ollama_down', visionVerified: null },
      };
    }
    const names = installed.map((m) => String((m && m.name) || '')).filter(Boolean);
    const caps = {};
    await Promise.all(names.slice(0, maxProbes).map(async (n) => { caps[n] = await ai.modelCapabilities(n); }));
    return {
      ollama: true,
      installed: names,
      caps,
      chat: resolveChatModel({ configured: settings.ai_model_local, fallback: chatFallback, installed: names }),
      vision: pickVisionModel({ configured: settings.ai_model_vision, fallback: visionFallback, installed: names, caps }),
    };
  }

  // Profile-aware DEFAULT, used ONLY when the user picked no chat model of
  // their own ('' in settings). A profile never overrides an explicit choice
  // and never pulls anything. lightweight/balanced keep the smallest known
  // default; on a powerful machine the 4B model is the better starting point
  // (the registry lists it chat- and vision-capable).
  const PROFILE_CHAT_FALLBACK = Object.freeze({
    lightweight: DEFAULT_CHAT_MODEL,
    balanced: DEFAULT_CHAT_MODEL,
    powerful: DEFAULT_VISION_MODEL, // gemma3:4b: chat + vision capable
  });
  function chatFallbackForProfile(profile) {
    return PROFILE_CHAT_FALLBACK[profile] || DEFAULT_CHAT_MODEL;
  }

  // What Settings shows as a recommendation for a profile. Every name must
  // already be installed (Ollama's own list); when the preferred default is
  // absent the answer is null ("keep the current default"), never a pull.
  // lightweight recommends no vision model: vision models are the heavy ones.
  function recommendedForProfile(profile, installed) {
    const names = Array.isArray(installed) ? installed : null;
    if (!names) return null;
    const want = {
      lightweight: { chat: DEFAULT_CHAT_MODEL, vision: null },
      balanced: { chat: DEFAULT_CHAT_MODEL, vision: DEFAULT_VISION_MODEL },
      powerful: { chat: DEFAULT_VISION_MODEL, vision: DEFAULT_VISION_MODEL },
    }[profile] || { chat: DEFAULT_CHAT_MODEL, vision: null };
    return {
      chat: isPresent(want.chat, names) ? want.chat : null,
      vision: want.vision && isPresent(want.vision, names) ? want.vision : null,
    };
  }

  return { DEFAULT_CHAT_MODEL, DEFAULT_VISION_MODEL, isPresent, resolveChatModel, pickVisionModel, resolveModelSelection, chatFallbackForProfile, recommendedForProfile };
});
