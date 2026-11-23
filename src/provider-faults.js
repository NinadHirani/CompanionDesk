'use strict';

// Typed, sanitized provider fault diagnostics (M1 slice 6). Every probe and
// provider-call failure maps to a small fixed vocabulary, so the ask path,
// the vision path and the Settings status view can name WHY a provider is
// unusable without ever carrying raw server bodies, URLs, prompts, images,
// key material or file paths. detail is only ever a whitelisted token: an
// HTTP status number or an errno-style network code. Dual-mode: require() in
// Electron/Node, plain <script> in the web/mobile build
// (window.CompanionProviderFaults).

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CompanionProviderFaults = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const FAULT_CODES = Object.freeze([
    'unreachable', 'timeout', 'cancelled', 'http_error', 'malformed',
    'model_missing', 'capability_unknown', 'capability_unsuitable',
  ]);

  // Human strings for the Settings view. Every code must have one; the test
  // suite pins that coverage so a new code cannot ship silently unmapped.
  const faultDisplay = Object.freeze({
    unreachable: 'Not reachable',
    timeout: 'Timed out',
    cancelled: 'Cancelled',
    http_error: 'Server error',
    malformed: 'Unexpected response format',
    model_missing: 'Model not installed',
    capability_unknown: 'Capability unknown',
    capability_unsuitable: 'Not capable of this task',
  });

  const ERRNO_RE = /^E[A-Z0-9_]+$/;
  const HTTP_REASON_RE = /^(?:ollama|gemini)_http_(\d{3})$/;

  // Sanitize one caught failure into { code, detail }. The caller aborting
  // (user cancellation) outranks everything, including a timeout that fired
  // at the same moment. err.message is never copied: only our own strict
  // `*_http_<status>` reason strings are pattern-matched, and network codes
  // only via the errno field. Nothing else survives.
  function classifyFailure({ err, callerAborted = false, status = null } = {}) {
    if (callerAborted) return { code: 'cancelled', detail: null };
    if (status != null) return { code: 'http_error', detail: String(status) };
    const e = err || {};
    if (e.name === 'TimeoutError') return { code: 'timeout', detail: null };
    if (typeof e.code === 'string' && ERRNO_RE.test(e.code)) return { code: 'unreachable', detail: e.code };
    if (typeof e.message === 'string') {
      const m = HTTP_REASON_RE.exec(e.message);
      if (m) return { code: 'http_error', detail: m[1] };
    }
    return { code: 'unreachable', detail: null };
  }

  // Shape guard: only known codes ever leave this module, and detail is a
  // short token, never a message. Returns null for anything unrecognized.
  function fault(f) {
    if (!f || FAULT_CODES.indexOf(f.code) === -1) return null;
    return { code: f.code, detail: f.detail == null ? null : String(f.detail).slice(0, 32) };
  }

  // Settings-view text for one fault, or null when there is none to show.
  function describeFault(f) {
    const g = fault(f);
    if (!g || !faultDisplay[g.code]) return null;
    return g.detail ? `${faultDisplay[g.code]} (${g.detail})` : faultDisplay[g.code];
  }

  return { FAULT_CODES, faultDisplay, classifyFailure, fault, describeFault };
});
