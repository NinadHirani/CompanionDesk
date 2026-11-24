'use strict';
// Gate 2 slice 6 (narrow): the renderer<->main IPC contract.
//
// This module is the security decision every wiring step must conform to.
// It is pure data + validation: no Electron, no I/O, no process access,
// so it is testable without the app shell and the shell cannot drift
// from it.
//
// Standing boundaries this contract encodes:
//   - The renderer surface is READ-ONLY. The preload allowlist must be
//     exactly RENDERER_CHANNELS: status, audit snapshot, run state,
//     provider status, and the harmless tools' record reads. Nothing
//     that executes, grants, approves, or stops is ever exposed.
//   - Every write path (run start/step/resume, approvals, grants,
//     emergency stop, persistence) is MAIN_ONLY_CHANNELS: reachable only
//     from main-process code the user controls, never from the renderer,
//     and never added to the preload allowlist.
//   - Fail closed: an unknown channel is refused, payloads must match
//     the declared shape exactly (no extra keys, strict types), and a
//     request that fails validation is never forwarded.
//   - The allowlist is asserted, not assumed: validatePreloadAllowlist
//     proves a wiring layer's exposed surface equals the contract's
//     renderer set exactly, so the shell cannot silently widen it.

const RENDERER_CHANNELS = [
  'status:get',
  'runs:get',
  'audit:read',
  'providers:get',
  'notifications:read',
  'reminders:read',
];

// Documented main-process-only operations. These names are deliberately
// spelled out here so a review can diff them against the preload surface:
// none of them may ever appear there.
const MAIN_ONLY_CHANNELS = [
  'run:start',
  'run:step',
  'run:resume',
  'run:abort',
  'approval:request',
  'approval:consume',
  'grants:grant',
  'grants:revoke',
  'stop:activate',
  'stop:reset',
  'persistence:write',
  'persistence:hydrate',
];

// Per-channel payload validators. Every channel's payload is a plain
// object; unknown keys are refused; values are strictly typed. A channel
// taking no fields accepts only {}.
function intIn(min, max) {
  return (v) => Number.isInteger(v) && v >= min && v <= max;
}
const FIELD_RULES = {
  'status:get': {},
  'runs:get': {
    runId: { type: 'string', max: 64, optional: true },
  },
  'audit:read': {
    limit: { type: 'int', range: intIn(1, 500), optional: true },
    fromSeq: { type: 'int', range: intIn(0, 2 ** 31 - 1), optional: true },
  },
  'providers:get': {
    name: { type: 'string', max: 64, optional: true },
  },
  'notifications:read': {
    limit: { type: 'int', range: intIn(1, 500), optional: true },
  },
  'reminders:read': {
    limit: { type: 'int', range: intIn(1, 500), optional: true },
  },
};

function validateRequest(channel, payload) {
  if (typeof channel !== 'string' || !RENDERER_CHANNELS.includes(channel)) {
    return { ok: false, reason: 'unknown_channel' };
  }
  if (payload === undefined || payload === null) return { ok: true, payload: {} };
  if (typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, reason: 'bad_payload' };
  }
  const rules = FIELD_RULES[channel];
  for (const key of Object.keys(payload)) {
    const rule = rules[key];
    if (!rule) return { ok: false, reason: 'unknown_field:' + key };
    const v = payload[key];
    if (v === undefined) return { ok: false, reason: 'bad_value:' + key };
    if (rule.type === 'string') {
      if (typeof v !== 'string' || v.length === 0 || v.length > rule.max) {
        return { ok: false, reason: 'bad_value:' + key };
      }
    } else if (rule.type === 'int') {
      if (typeof v !== 'number' || !rule.range(v)) return { ok: false, reason: 'bad_value:' + key };
    }
  }
  return { ok: true, payload: { ...payload } };
}

// Wiring-layer check: the preload's exposed surface must equal the
// contract's renderer allowlist exactly (no more, no less, no order
// dependence). Returns { ok: true } or { ok: false, missing, extra }.
function validatePreloadAllowlist(exposed) {
  if (!Array.isArray(exposed)) return { ok: false, missing: RENDERER_CHANNELS, extra: [], reason: 'not_a_list' };
  const want = new Set(RENDERER_CHANNELS);
  const have = new Set(exposed);
  const missing = RENDERER_CHANNELS.filter((c) => !have.has(c));
  const extra = exposed.filter((c) => !want.has(c));
  return missing.length === 0 && extra.length === 0 ? { ok: true } : { ok: false, missing, extra };
}

// Refusal shape every denied request maps to, so the renderer sees one
// consistent fail-closed answer and nothing about internals.
function refusalResponse(reason) {
  return { ok: false, error: 'refused', reason: String(reason).slice(0, 64) };
}

module.exports = { RENDERER_CHANNELS, MAIN_ONLY_CHANNELS, validateRequest, validatePreloadAllowlist, refusalResponse };
