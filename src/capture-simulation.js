/**
 * M7 capture-simulation slice (28 Nov 2026, owner-directed offline-safe
 * scope). A PURE policy simulator for the capture engine's consent gate:
 * no screen is captured, no permission flow runs, no device API is
 * touched. It mirrors the established rules so the policy logic is
 * testable offline before any real device lane opens:
 *   - capture is DISABLED by default; enabling is an explicit owner act;
 *   - consent is strictly per call and auto-resets to off after every
 *     capture attempt (the retrieval-consent rule, applied to capture);
 *   - a sensitive source is refused without explicit consent;
 *   - every decision, refusal included, writes an audit entry, held in a
 *     bounded window (most recent auditCap entries, oldest dropped); the
 *     processed/captured/refused totals stay exact forever.
 * The real capture engine and its permission flows stay excluded.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.captureSimulation = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function createCaptureSimulator(opts) {
    const o = Object.assign({ enabled: false, autoResetConsent: true, auditCap: 1000 }, opts || {});
    let enabled = o.enabled === true;
    const audit = [];
    const auditCap = o.auditCap;
    let captured = 0;
    let refused = 0;
    let processedTotal = 0;

    function isEnabled() { return enabled; }

    function setPolicy(patch) {
      if (!patch || typeof patch !== 'object') throw new Error('policy patch must be an object');
      if (patch.enabled !== undefined) {
        if (typeof patch.enabled !== 'boolean') throw new Error('enabled must be boolean');
        enabled = patch.enabled;
      }
      return { enabled: enabled };
    }

    function process(event) {
      if (!event || typeof event !== 'object') throw new Error('event must be an object');
      if (typeof event.ts !== 'number') throw new Error('event.ts must be a number');
      if (typeof event.source !== 'string' || event.source.length === 0) throw new Error('event.source must be a non-empty string');
      if (typeof event.kind !== 'string' || event.kind.length === 0) throw new Error('event.kind must be a non-empty string');
      if (typeof event.consent !== 'boolean') throw new Error('event.consent must be a boolean');
      if (typeof event.sensitive !== 'boolean') throw new Error('event.sensitive must be a boolean');

      let decision = 'captured';
      let reason = null;
      if (!enabled) {
        decision = 'refused'; reason = 'capture_disabled';
      } else if (event.sensitive && !event.consent) {
        decision = 'refused'; reason = 'sensitive_consent_required';
      } else if (!event.consent) {
        decision = 'refused'; reason = 'consent_reset';
      }

      audit.push({
        ts: event.ts, source: event.source, kind: event.kind,
        sensitive: event.sensitive, decision: decision, reason: reason,
      });
      if (audit.length > auditCap) audit.splice(0, audit.length - auditCap);
      if (decision === 'captured') captured++; else refused++;
      processedTotal++;
      return { decision: decision, reason: reason };
    }

    function auditEntries() { return audit.slice(); }
    function stats() { return { processed: processedTotal, captured: captured, refused: refused }; }

    return { isEnabled: isEnabled, setPolicy: setPolicy, process: process, audit: auditEntries, stats: stats };
  }

  return { createCaptureSimulator: createCaptureSimulator };
});
