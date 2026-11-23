'use strict';

// Provider abstraction. Local Ollama is the default and the ONLY thing the
// core app requires. A cloud provider (Gemini free tier today) is an opt-in
// fallback for harder tasks, configured by the user; nothing here is needed
// for the app to run, and no call leaves the machine unless a key was saved.
// fetchImpl is injectable so tests can run without any network.
// Dual-mode: require() in Electron/Node, plain <script> in the web/mobile
// build (window.CompanionAi).

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = { createAi: factory() };
  else root.CompanionAi = { createAi: factory() };
})(typeof self !== 'undefined' ? self : this, function () {
  const ENV = (typeof process !== 'undefined' && process.env) ? process.env : {};

  // Resolved lazily so script load order never matters in the web bundle.
  function registry() {
    if (typeof module === 'object' && module.exports) return require('./provider-registry');
    return (typeof self !== 'undefined' && self.CompanionProviderRegistry) || null;
  }
  function router() {
    if (typeof module === 'object' && module.exports) return require('./task-router');
    return (typeof self !== 'undefined' && self.CompanionTaskRouter) || null;
  }
  function faults() {
    if (typeof module === 'object' && module.exports) return require('./provider-faults');
    return (typeof self !== 'undefined' && self.CompanionProviderFaults) || null;
  }

  const DEFAULT_OLLAMA_URL = ENV.OLLAMA_URL || 'http://127.0.0.1:11434';
  const STATUS_TIMEOUT_MS = 1500;

  function createAi({
    fetchImpl = globalThis.fetch,
    ollamaUrl = DEFAULT_OLLAMA_URL,
    localModel = null,
    cloudModel = null,
    geminiKey = null,
    // Explicit opt-in (M1 task router policy). A saved key alone no longer
    // arms the fallback: cloudEnabled must be true in settings AND a key
    // must exist. Default false, so behavior is unchanged out of the box.
    cloudEnabled = false,
    // Bounded timeouts (M1 slice 2). Every network call carries one; a call
    // that exceeds it aborts instead of hanging forever, and there are no
    // retries anywhere in this file.
    probeTimeoutMs = 1500,
    chatTimeoutMs = 120000,
    cloudTimeoutMs = 30000,
  } = {}) {
    // Model ids are registry facts, not literals in this file: the defaults
    // come from the provider registry (src/provider-registry.js), with the
    // environment overriding and the caller overriding both (M1 acceptance).
    const RegDefaults = (registry() && registry().DEFAULTS) || {};
    localModel = localModel || ENV.LOCAL_MODEL || RegDefaults.localChat || '';
    cloudModel = cloudModel || ENV.CLOUD_MODEL || RegDefaults.cloudChat || '';

    // geminiKey may be a string or, on the desktop app, a getter into the
    // OS-encrypted store, so the key is read only when a cloud call actually
    // happens and the renderer never needs it.
    const keyFor = () => (typeof geminiKey === 'function' ? geminiKey() : geminiKey);
    // The settings-driven cloud opt-in wired at startup (src/main.js); the
    // routed path defaults to it, and a per-request argument may override.
    const cloudArmed = cloudEnabled === true;

    // One signal that honors BOTH the caller's cancellation and the call's
    // own bounded timeout. AbortSignal.any is available in Node 22, Electron
    // 43 and current browsers; without it the caller's signal wins and the
    // bound is dropped rather than overridden.
    function withTimeouts(signal, ms) {
      const bound = AbortSignal.timeout(ms);
      if (signal && typeof AbortSignal.any === 'function') return AbortSignal.any([signal, bound]);
      if (signal) return signal;
      return bound;
    }
    function isAbort(err) {
      return Boolean(err && (err.name === 'AbortError' || err.name === 'TimeoutError' || err.code === 'ABORT_ERR'));
    }
    // images: optional array of base64 strings attached to the user message (vision models).
    function messagesFor({ system, prompt, images, history }) {
      const user = images && images.length ? { role: 'user', content: prompt, images } : { role: 'user', content: prompt };
      const messages = system ? [{ role: 'system', content: system }] : [];
      // Past turns of the CURRENT conversation, local model only. The cloud
      // fallback never receives them (complete strips this argument).
      for (const turn of history || []) {
        if (!turn || typeof turn.content !== 'string' || !turn.content.trim()) continue;
        messages.push({ role: turn.role === 'assistant' ? 'assistant' : 'user', content: turn.content });
      }
      messages.push(user);
      return messages;
    }

    // Is a model with this name (ignoring the :tag) installed in Ollama right now?
    async function hasModel(name) {
      try {
        const res = await fetchImpl(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) });
        if (!res.ok) return false;
        const family = String(name).split(':')[0];
        const wantsTag = String(name).includes(':');
        return ((await res.json()).models || []).some((m) => {
          const n = String(m.name || '');
          return wantsTag ? n === name : n.split(':')[0] === family;
        });
      } catch {
        return false;
      }
    }

    async function status() {
      // "cloud" means the fallback is actually armed: enabled AND keyed.
      // fault is the typed, sanitized reason Ollama is unusable (slice 6).
      const F = faults();
      const out = { ollama: false, model: localModel, cloud: Boolean(cloudEnabled && keyFor()) };
      try {
        const res = await fetchImpl(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) });
        if (!res.ok) { out.fault = F.fault({ code: 'http_error', detail: String(res.status) }); return out; }
        let data;
        try { data = await res.json(); } catch { out.fault = F.fault({ code: 'malformed' }); return out; }
        out.ollama = true;
        out.fault = null;
        const family = localModel.split(':')[0];
        out.modelLoaded = (data.models || []).some((m) => String(m.name || '').startsWith(family));
        return out;
      } catch (err) {
        out.fault = F.fault(F.classifyFailure({ err, callerAborted: false }));
        return out;
      }
    }

    async function chatOllama({ system, prompt, model, temperature = 0.1, onToken, images, history, signal } = {}) {
      const res = await fetchImpl(`${ollamaUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: model || localModel,
          stream: true,
          options: { temperature },
          messages: messagesFor({ system, prompt, images, history }),
        }),
        signal: withTimeouts(signal, chatTimeoutMs),
      });
      if (!res.ok) throw new Error(`ollama_http_${res.status}`);

      const consume = (text) => {
        let full = '';
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          try {
            const ev = JSON.parse(line);
            const piece = ev.message && ev.message.content;
            if (piece) { full += piece; if (onToken) onToken(piece); }
          } catch { /* partial line: ignore */ }
        }
        return full;
      };

      if (res.body && typeof res.body.getReader === 'function') {
        const decoder = new TextDecoder();
        let buffer = '';
        let full = '';
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line) continue;
            try {
              const ev = JSON.parse(line);
              const piece = ev.message && ev.message.content;
              if (piece) { full += piece; if (onToken) onToken(piece); }
            } catch { /* partial line: ignore */ }
          }
        }
        return full || consume(buffer);
      }
      return consume(await res.text());
    }

    // Cloud fallback. Plain REST, no SDK, so the dependency tree stays light.
    async function chatGemini({ system, prompt, model, signal } = {}) {
      const key = keyFor();
      if (!key) throw new Error('no_cloud_key');
      // The key travels in a header, never a URL: a query parameter would end
      // up in logs, proxies and crash reports.
      const res = await fetchImpl(
        `https://generativelanguage.googleapis.com/v1beta/models/${model || cloudModel}:generateContent`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify({ contents: [{ parts: [{ text: (system ? system + '\n\n' : '') + prompt }] }] }),
          signal: withTimeouts(signal, cloudTimeoutMs),
        }
      );
      if (!res.ok) throw new Error(`gemini_http_${res.status}`);
      let data;
      try { data = await res.json(); } catch { throw new Error('gemini_bad_response'); }
      const parts = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
      const text = (parts || []).map((p) => p.text || '').join('');
      if (!text) throw new Error('gemini_empty_response');
      return text;
    }

    // Explicit connectivity check for a saved or just-typed Gemini key. No
    // prompt, no history, no model text: one GET on the models list. The
    // reason never contains the key.
    async function testGeminiKey({ key } = {}) {
      const useKey = key != null ? String(key) : keyFor();
      if (!useKey) return { ok: false, reason: 'no_cloud_key' };
      try {
        const res = await fetchImpl('https://generativelanguage.googleapis.com/v1beta/models', {
          headers: { 'x-goog-api-key': useKey },
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) return { ok: false, reason: `gemini_http_${res.status}` };
        return { ok: true };
      } catch {
        return { ok: false, reason: 'gemini_network_error' };
      }
    }

    // Models actually installed right now. models null means Ollama did not
    // answer; fault names why (slice 6), sanitized.
    async function listModelsDetailed(signal) {
      const F = faults();
      try {
        const res = await fetchImpl(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) });
        if (!res.ok) return { models: null, fault: F.fault({ code: 'http_error', detail: String(res.status) }) };
        let data;
        try { data = await res.json(); } catch { return { models: null, fault: F.fault({ code: 'malformed' }) }; }
        if (!data || !Array.isArray(data.models)) return { models: null, fault: F.fault({ code: 'malformed' }) };
        return { models: data.models, fault: null };
      } catch (err) {
        return { models: null, fault: F.fault(F.classifyFailure({ err, callerAborted: Boolean(signal && signal.aborted) })) };
      }
    }
    async function listModels() {
      return (await listModelsDetailed()).models;
    }

    // What a model can do, per Ollama's /api/show. capabilities null when
    // unreadable (absent model, old Ollama, bad answer); fault names why.
    async function modelCapabilitiesDetailed(name, signal) {
      const F = faults();
      try {
        const res = await fetchImpl(`${ollamaUrl}/api/show`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: name }),
          signal: withTimeouts(signal, probeTimeoutMs),
        });
        if (!res.ok) {
          // Ollama answers 404 for an unknown model: that is a fact about the
          // model list, not a generic server error.
          return { capabilities: null, fault: F.fault(res.status === 404 ? { code: 'model_missing' } : { code: 'http_error', detail: String(res.status) }) };
        }
        let data;
        try { data = await res.json(); } catch { return { capabilities: null, fault: F.fault({ code: 'malformed' }) }; }
        if (!data || !Array.isArray(data.capabilities)) return { capabilities: null, fault: F.fault({ code: 'capability_unknown' }) };
        return { capabilities: data.capabilities, fault: null };
      } catch (err) {
        return { capabilities: null, fault: F.fault(F.classifyFailure({ err, callerAborted: Boolean(signal && signal.aborted) })) };
      }
    }
    async function modelCapabilities(name, signal) {
      return (await modelCapabilitiesDetailed(name, signal)).capabilities;
    }

    // ---- M1 slice 2: per-ask routing -----------------------------------
    // The router (src/task-router.js) owns every routing decision. This
    // layer only GATHERS the facts it needs, live, with bounded timeouts:
    // whether Ollama answers right now, which models are installed, and
    // (for vision tasks) what the candidates can do. It never infers, never
    // downloads, and never calls the cloud except through the router's
    // gates, with consent for THIS request.

    // One bounded probe of the local server at request time. Any failure
    // (non-OK, timeout, network error) is an observation that the local
    // provider is not answering; healthy stays false and the router
    // refuses. Models are exact ids as Ollama serves them.
    async function probeLocal(signal) {
      const F = faults();
      try {
        const res = await fetchImpl(`${ollamaUrl}/api/tags`, { signal: withTimeouts(signal, probeTimeoutMs) });
        if (!res.ok) return { healthy: false, models: null, fault: F.fault({ code: 'http_error', detail: String(res.status) }) };
        let data;
        try { data = await res.json(); } catch { return { healthy: false, models: null, fault: F.fault({ code: 'malformed' }) }; }
        if (!data || !Array.isArray(data.models)) return { healthy: false, models: null, fault: F.fault({ code: 'malformed' }) };
        return { healthy: true, models: data.models.map((m) => String((m && m.name) || '')), fault: null };
      } catch (err) {
        return { healthy: false, models: null, fault: F.fault(F.classifyFailure({ err, callerAborted: Boolean(signal && signal.aborted) })) };
      }
    }

    // Bounded cloud health probe. Only ever run when the user has ALREADY
    // consented to this request going to the cloud: a saved key alone must
    // not even produce a health check.
    async function probeCloudHealthDetailed(signal) {
      const F = faults();
      const key = keyFor();
      if (!key) return { healthy: false, fault: null };
      try {
        const res = await fetchImpl('https://generativelanguage.googleapis.com/v1beta/models', {
          headers: { 'x-goog-api-key': key },
          signal: withTimeouts(signal, cloudTimeoutMs),
        });
        if (!res.ok) return { healthy: false, fault: F.fault({ code: 'http_error', detail: String(res.status) }) };
        return { healthy: true, fault: null };
      } catch (err) {
        return { healthy: false, fault: F.fault(F.classifyFailure({ err, callerAborted: Boolean(signal && signal.aborted) })) };
      }
    }
    async function probeCloudHealth(signal) {
      return (await probeCloudHealthDetailed(signal)).healthy;
    }

    // What a cloud call would receive, for the per-request confirmation.
    // Matches exactly what chatGemini sends below.
    // What the user is told Google would receive MUST describe the exact
    // payload this ask would send. Callers that know their prompt shape
    // (personal.js) pass cloudDisclosure with the real category list;
    // anything else gets the conservative generic one.
    function resolveCloudDisclosure(arg) {
      const generic = {
        provider: 'gemini',
        model: cloudModel,
        prompt: 'full',
        receives: ['the current prompt and system context exactly as passed'],
        never_sent: ['conversation history', 'screenshots or images'],
        note: 'rate limits and possible charges may apply',
      };
      if (!arg || typeof arg !== 'object' || !Array.isArray(arg.receives) || !arg.receives.length) return generic;
      return {
        provider: arg.provider || 'gemini',
        model: arg.model || cloudModel,
        prompt: arg.prompt === 'minimized' ? 'minimized' : 'full',
        receives: arg.receives.map(String),
        never_sent: Array.isArray(arg.never_sent) && arg.never_sent.length
          ? arg.never_sent.map(String)
          : generic.never_sent,
        note: arg.note || generic.note,
      };
    }

    function refusalError(reason, faultInfo) {
      const e = new Error(reason);
      e.reason = reason;
      e.code = reason;
      e.fault = faultInfo || null;
      return e;
    }

    // Probe-and-route only, no execution. The screen path uses this so its
    // decision comes from the same router the chat path uses.
    async function routeTask(task, {
      privacyMode = 'standard',
      cloudEnabled = cloudArmed,
      cloudConsent = false,
      model = null,
      visionModel = null,
      signal = null,
      ollamaHealth = null,       // null = probe live; false = "local failed, try cloud"
      installedModels = null,    // null = probe live
      geminiHealth = null,       // null = unknown; true/false = a fresh fact
    } = {}) {
      const R = router();
      if (!R || !R.routeTask) return { probe: { healthy: false, models: null }, decision: { ok: false, provider: null, model: null, reason: 'router_unavailable', cloudUsed: false } };
      const probe = (ollamaHealth === null)
        ? await probeLocal(signal)
        : { healthy: ollamaHealth, models: installedModels || [], fault: null };
      const installed = installedModels !== null ? installedModels : (probe.models || []);
      const capabilities = {};
      const capFaults = {};
      if (probe.healthy && task === 'vision') {
        for (const name of [model, visionModel, localModel]) {
          if (!name || capabilities[name] !== undefined) continue;
          const det = await modelCapabilitiesDetailed(name, signal);
          capabilities[name] = det.capabilities;
          capFaults[name] = det.fault
            ? { state: 'unknown', fault: det.fault }
            : (Array.isArray(det.capabilities) && det.capabilities.indexOf('vision') === -1
              ? { state: 'unsuitable' }
              : { state: 'ok' });
        }
      }
      // Diagnostics only: the requested model being absent from the live
      // list (same isPresent helper the router uses). The router itself
      // still refuses; this only explains why.
      const Rr = router();
      const modelMissing = Boolean(probe.healthy && model && Rr && Rr.isPresent && !Rr.isPresent(model, installed));
      // The cloud model's capability is a registry fact, verified at
      // registry time; per-model, never a family assumption.
      const Reg = registry();
      const cloudEntry = Reg && Reg.getModel ? Reg.getModel('gemini', cloudModel) : null;
      if (cloudEntry && Array.isArray(cloudEntry.capabilities)) capabilities[cloudModel] = cloudEntry.capabilities.slice();
      const decision = R.routeTask({
        task,
        capabilities,
        privacyMode,
        cloudEnabled,
        cloudConsent,
        cloudKeyAvailable: Boolean(keyFor()),
        providerHealth: { ollama: probe.healthy, gemini: geminiHealth === null ? undefined : geminiHealth },
        installedModels: installed,
        requestedModel: model || null,
        localModel,
        localVisionModel: visionModel || null,
        cloudModel,
      });
      return { probe, decision, faults: { probe: probe.fault || null, capabilities: capFaults, modelMissing } };
    }

    // Local chat failed AFTER the router picked it (model vanished, Ollama
    // died mid-call). Reconsider the cloud through the same gates, with
    // local now honestly reported as unable to serve. Never on abort.
    async function reconsiderCloud({ system, prompt, cloudArgs, task, privacyMode, cloudEnabled, cloudConsent, cloudDisclosure, model, visionModel, signal, localError }) {
      const { decision } = await routeTask(task, {
        privacyMode, cloudEnabled, cloudConsent, model, visionModel, signal,
        ollamaHealth: false, installedModels: [],
      });
      if (decision.ok && decision.provider === 'gemini') {
        const cp = { ...{ system, prompt }, ...(cloudArgs || {}) };
        return chatGemini({ system: cp.system, prompt: cp.prompt, model: decision.model, signal });
      }
      if (!decision.ok && decision.reason === 'gemini_health_unknown' && cloudConsent) {
        // The user consented to this cloud try; health is the only unknown.
        // Probe it now (bounded) and let the router decide with the fact.
        const healthy = await probeCloudHealth(signal);
        const again = await routeTask(task, {
          privacyMode, cloudEnabled, cloudConsent, model, visionModel, signal,
          ollamaHealth: false, installedModels: [], geminiHealth: healthy,
        });
        if (again.decision.ok && again.decision.provider === 'gemini') {
          const cp = { ...{ system, prompt }, ...(cloudArgs || {}) };
          return chatGemini({ system: cp.system, prompt: cp.prompt, model: again.decision.model, signal });
        }
        const refused = refusalError(again.decision.reason || 'cloud_provider_down');
        refused.localError = String((localError && localError.message) || localError);
        const Fc = faults();
        refused.localFault = Fc ? Fc.fault(Fc.classifyFailure({ err: localError, callerAborted: Boolean(signal && signal.aborted) })) : null;
        throw refused;
      }
      if (!decision.ok && decision.reason === 'no_cloud_consent' && !cloudConsent
          && cloudEnabled && keyFor() && privacyMode !== 'local_only') {
        // Every other gate is open; consent for THIS request is the only
        // missing human step. Nothing has been sent anywhere.
        return { needsCloudConsent: true, localError: String((localError && localError.message) || localError), cloud: resolveCloudDisclosure(cloudDisclosure) };
      }
      // A privacy refusal is the honest final word: the user's mode blocks
      // the cloud no matter what local did, so it names the failure, not
      // the local error underneath it.
      if (decision && decision.reason === 'privacy_local_only') throw refusalError('privacy_local_only');
      throw localError; // the honest local failure
    }

    async function completeRouted(args) {
      const {
        system, prompt, cloudArgs, images, history, onToken,
        task = 'chat',
        model = null,
        visionModel = null,
        privacyMode = 'standard',
        cloudEnabled = cloudArmed,
        cloudConsent = false,
        cloudDisclosure = null,
        signal = null,
      } = args || {};

      const { probe, decision } = await routeTask(task, {
        privacyMode, cloudEnabled, cloudConsent, model, visionModel, signal,
      });

      // The caller cancelled while the probes ran: surface that as the
      // cancellation it is. No retry, no cloud consideration (slice 6).
      if (probe.fault && probe.fault.code === 'cancelled') {
        const cancelledErr = refusalError('cancelled');
        cancelledErr.name = 'AbortError';
        throw cancelledErr;
      }

      if (decision.ok && decision.provider === 'ollama') {
        try {
          return await chatOllama({ system, prompt, images, history, onToken, model: decision.model, signal });
        } catch (err) {
          if (isAbort(err) || (signal && signal.aborted)) throw err;
          return reconsiderCloud({ system, prompt, cloudArgs, task, privacyMode, cloudEnabled, cloudConsent, cloudDisclosure, model, visionModel, signal, localError: err });
        }
      }
      if (decision.ok && decision.provider === 'gemini') {
        // Only reachable when consent was already true for this request.
        const cp = { ...{ system, prompt }, ...(cloudArgs || {}) };
        return chatGemini({ system: cp.system, prompt: cp.prompt, model: decision.model, signal });
      }
      // Refused. With consent already given and health merely UNKNOWN,
      // check cloud health now (bounded) and let the router decide again
      // with the fresh fact. Everything else is an honest refusal.
      if (!decision.ok && decision.reason === 'gemini_health_unknown') {
        const healthy = await probeCloudHealth(signal);
        const again = await routeTask(task, {
          privacyMode, cloudEnabled, cloudConsent, model, visionModel, signal,
          ollamaHealth: probe.healthy, installedModels: probe.models || [],
          geminiHealth: healthy,
        });
        if (again.decision.ok && again.decision.provider === 'gemini') {
          const cp = { ...{ system, prompt }, ...(cloudArgs || {}) };
          return chatGemini({ system: cp.system, prompt: cp.prompt, model: again.decision.model, signal });
        }
        throw refusalError(again.decision.reason || 'cloud_provider_down');
      }
      // Not consented yet: when cloud is armed in every other respect, the
      // per-request confirmation is the next human step. Nothing has been
      // sent anywhere, and nothing retries on its own after a decline.
      if (!decision.ok && decision.reason === 'no_cloud_consent' && !cloudConsent
          && cloudEnabled && keyFor() && privacyMode !== 'local_only') {
        const localReason = probe.healthy
          ? (task === 'vision' ? 'no_vision_model_local' : 'no_local_model')
          : 'ollama_down';
        return { needsCloudConsent: true, localError: localReason, localFault: probe.fault || null, cloud: resolveCloudDisclosure(cloudDisclosure) };
      }
      throw refusalError(decision.reason, probe.fault);
    }

    // Local-only legacy path. It predates the router and carries no
    // per-request cloud consent, so it must NEVER transmit: with the key
    // and cloud_enabled both present, a local failure stays a local
    // failure. The routed path (completeRouted) is the only route to the
    // cloud, and it requires the human per-request confirmation. Callers
    // that legitimately need the cloud must migrate to it. (Review fix,
    // 23 Nov 2026.)
    async function complete(args) {
      return chatOllama(args);
    }

    return { status, hasModel, chat: chatOllama, chatGemini, complete, completeRouted, routeTask, probeLocal, listModels, listModelsDetailed, modelCapabilities, modelCapabilitiesDetailed, probeCloudHealth, probeCloudHealthDetailed, testGeminiKey, localModel };
  }

  return createAi;
});
