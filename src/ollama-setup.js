'use strict';

// Ollama onboarding. One clear path from "no local model" to "answering
// locally", with the user in control of every step:
//   detectOllama()  -> is Ollama running, and which models exist
//   setupState()    -> the single stage the UI should show
//   installPlan()   -> the OFFICIAL download page/command for this platform
//   pullModel()     -> stream /api/pull with progress and cancellation
//   diskVerdict()   -> does the disk hold the model plus headroom
//
// SAFETY RULES (mirrored by tests):
//   - This module never executes an installer, never spawns a process, and
//     never pipes a script from the network. Install stays with the user.
//   - The only URLs the app will open are the official ollama.com pages.
//   - A model is downloaded only after the user clicks the download button,
//     sees the size and a disk-space check, and can cancel at any point.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CompanionOllamaSetup = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const RECOMMENDED_MODEL = 'llama3.2:latest';

  // Approximate download sizes for models the app offers to pull, taken from
  // the Ollama library. Shown to the user before any download starts.
  const MODEL_SIZES = Object.freeze({
    'llama3.2:latest': { bytes: 2019393189, label: 'about 2 GB' },
  });

  // Official, documented install routes per platform. macOS and Windows are
  // guided: the app opens the official download page and the user installs.
  // Linux: the official install script, shown as a command the user runs in
  // their own terminal after reviewing it. The app never pipes it itself.
  const INSTALL = Object.freeze({
    darwin: Object.freeze({
      kind: 'guided',
      url: 'https://ollama.com/download/mac',
      fileHint: 'Ollama.zip',
      steps: Object.freeze([
        'Download Ollama from the official page that just opened.',
        'Unzip it and drag Ollama.app into Applications (macOS may ask to confirm).',
        'Open Ollama once. It then runs in the background.',
      ]),
    }),
    win32: Object.freeze({
      kind: 'guided',
      url: 'https://ollama.com/download/windows',
      fileHint: 'OllamaSetup.exe',
      steps: Object.freeze([
        'Download OllamaSetup.exe from the official page that just opened.',
        'Run it and accept the administrator prompt.',
        'Ollama starts in the background when the installer finishes.',
      ]),
    }),
    linux: Object.freeze({
      kind: 'command',
      command: 'curl -fsSL https://ollama.com/install.sh | sh',
      url: 'https://ollama.com/download/linux',
      steps: Object.freeze([
        'Review the install script at ollama.com/download/linux.',
        'Run the command yourself in a terminal. CompanionDesk will not run it for you.',
      ]),
    }),
  });

  function installPlan(platform) {
    return INSTALL[platform] || null;
  }

  // The app opens ONLY these official URLs, nothing else.
  function isOpenableUrl(url) {
    if (typeof url !== 'string') return false;
    return Object.values(INSTALL).some((p) => p.url === url);
  }

  function defaultOllamaUrl() {
    const env = typeof process !== 'undefined' && process.env ? process.env : {};
    return env.OLLAMA_URL || 'http://127.0.0.1:11434';
  }

  // Family semantics mirroring ai.status(): any llama3.2:* tag counts as the
  // model being loaded, so the setup card can never disagree with the chip.
  function modelPresent(models, name) {
    const family = String(name).split(':')[0];
    return (models || []).some((n) => String(n || '').split(':')[0] === family);
  }

  async function detectOllama({ fetchImpl = globalThis.fetch, ollamaUrl, timeoutMs = 1500 } = {}) {
    const out = { ok: true, running: false, version: null, models: [] };
    try {
      const res = await fetchImpl(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return out;
      const data = await res.json();
      out.running = true;
      out.models = (data.models || []).map((m) => String((m && m.name) || '')).filter(Boolean);
    } catch {
      return out;
    }
    try {
      const v = await fetchImpl(`${ollamaUrl}/api/version`, { signal: AbortSignal.timeout(timeoutMs) });
      if (v.ok) {
        const j = await v.json();
        out.version = String((j && j.version) || '') || null;
      }
    } catch { /* version is cosmetic */ }
    return out;
  }

  // One line of Ollama's NDJSON pull stream -> a plain progress record.
  function parsePullLine(obj) {
    const total = Number.isFinite(obj.total) ? obj.total : null;
    const completed = Number.isFinite(obj.completed) ? obj.completed : null;
    return {
      status: typeof obj.status === 'string' ? obj.status : '',
      completed,
      total,
      pct: total && completed !== null ? Math.min(100, Math.max(0, Math.round((completed / total) * 100))) : null,
    };
  }

  async function pullModel({ fetchImpl = globalThis.fetch, ollamaUrl, model, onProgress, signal } = {}) {
    const res = await fetchImpl(`${ollamaUrl}/api/pull`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, stream: true }),
      signal,
    });
    if (!res.ok) throw new Error(`ollama_http_${res.status}`);
    if (!res.body || typeof res.body.getReader !== 'function') throw new Error('no_stream_body');
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        if (obj.error) throw new Error(String(obj.error));
        if (onProgress) onProgress(parsePullLine(obj));
      }
    }
    return { ok: true, model };
  }

  // Pure: is there room for the model plus headroom?
  function diskVerdict({ freeBytes, neededBytes, headroom = 1.2 } = {}) {
    const need = Math.ceil(Number(neededBytes) * headroom);
    const free = Math.max(0, Number(freeBytes) || 0);
    return { ok: true, freeBytes: free, neededBytes: need, enough: free >= need };
  }

  // Pure: which single stage should the UI show right now?
  //   ready        nothing to do
  //   install      Ollama is not running; show the guided official install
  //   pull         Ollama runs; the recommended model needs downloading
  //   unsupported  web/mobile build: desktop Ollama cannot run here
  function setupState({ platform, mobile = false, ollamaRunning = false, modelPresent: present = false, model = RECOMMENDED_MODEL } = {}) {
    if (mobile) {
      return { stage: 'unsupported', model };
    }
    if (!ollamaRunning) {
      return { stage: 'install', plan: installPlan(platform), platform, model };
    }
    if (!present) {
      return { stage: 'pull', model, size: MODEL_SIZES[model] || { bytes: null, label: 'a few GB' } };
    }
    return { stage: 'ready', model };
  }

  return {
    RECOMMENDED_MODEL,
    MODEL_SIZES,
    installPlan,
    isOpenableUrl,
    defaultOllamaUrl,
    modelPresent,
    detectOllama,
    parsePullLine,
    pullModel,
    diskVerdict,
    setupState,
  };
});
