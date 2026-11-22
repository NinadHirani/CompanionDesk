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

  const DEFAULT_OLLAMA_URL = ENV.OLLAMA_URL || 'http://127.0.0.1:11434';
  const DEFAULT_LOCAL_MODEL = ENV.LOCAL_MODEL || 'llama3.2:latest';
  const DEFAULT_CLOUD_MODEL = ENV.CLOUD_MODEL || 'gemini-2.0-flash';
  const STATUS_TIMEOUT_MS = 1500;

  function createAi({
    fetchImpl = globalThis.fetch,
    ollamaUrl = DEFAULT_OLLAMA_URL,
    localModel = DEFAULT_LOCAL_MODEL,
    cloudModel = DEFAULT_CLOUD_MODEL,
    geminiKey = null,
  } = {}) {
    // images: optional array of base64 strings attached to the user message (vision models).
    function messagesFor({ system, prompt, images }) {
      const user = images && images.length ? { role: 'user', content: prompt, images } : { role: 'user', content: prompt };
      return system ? [{ role: 'system', content: system }, user] : [user];
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
      const out = { ollama: false, model: localModel, cloud: Boolean(geminiKey) };
      try {
        const res = await fetchImpl(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) });
        if (!res.ok) return out;
        const data = await res.json();
        out.ollama = true;
        const family = localModel.split(':')[0];
        out.modelLoaded = (data.models || []).some((m) => String(m.name || '').startsWith(family));
        return out;
      } catch {
        return out;
      }
    }

    async function chatOllama({ system, prompt, model, temperature = 0.1, onToken, images } = {}) {
      const res = await fetchImpl(`${ollamaUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: model || localModel,
          stream: true,
          options: { temperature },
          messages: messagesFor({ system, prompt, images }),
        }),
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
    async function chatGemini({ system, prompt, model } = {}) {
      if (!geminiKey) throw new Error('no_cloud_key');
      const res = await fetchImpl(
        `https://generativelanguage.googleapis.com/v1beta/models/${model || cloudModel}:generateContent?key=${encodeURIComponent(geminiKey)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: (system ? system + '\n\n' : '') + prompt }] }] }),
        }
      );
      if (!res.ok) throw new Error(`gemini_http_${res.status}`);
      const data = await res.json();
      const parts = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
      const text = (parts || []).map((p) => p.text || '').join('');
      if (!text) throw new Error('gemini_empty_response');
      return text;
    }

    // Local first; cloud only when a key exists and the local call failed.
    // args.cloudArgs, when given, REPLACES system/prompt for the cloud call
    // only. Callers that put personal context in the local prompt use it to
    // send a minimal prompt to the cloud instead. Without it the cloud gets
    // exactly what the local model got (unchanged behavior).
    async function complete(args) {
      try {
        return await chatOllama(args);
      } catch (err) {
        if (geminiKey) {
          const { cloudArgs, ...rest } = args || {};
          return chatGemini(cloudArgs ? { ...rest, ...cloudArgs } : rest);
        }
        throw err;
      }
    }

    return { status, hasModel, chat: chatOllama, chatGemini, complete };
  }

  return createAi;
});
