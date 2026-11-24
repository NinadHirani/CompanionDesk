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

// A payload must be a plain object: a literal (or Object.create(null))
// carrying only its own enumerable string-keyed data properties. Dates,
// class instances, arrays, inherited-key objects, accessors, symbol keys
// and non-enumerables are all refused, because a spread copy invokes
// enumerable getters and carries enumerable symbol keys, so validation
// must reject every one of them before any value is read or copied.
function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

const POLLUTING_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function validateRequest(channel, payload) {
  if (typeof channel !== 'string' || !RENDERER_CHANNELS.includes(channel)) {
    return { ok: false, reason: 'unknown_channel' };
  }
  if (payload === undefined || payload === null) return { ok: true, payload: {} };
  if (!isPlainObject(payload)) return { ok: false, reason: 'bad_payload' };
  const rules = FIELD_RULES[channel];
  const out = {};
  // Structural pass first. Reflect.ownKeys sees symbols and non-enumerables
  // that Object.keys skips; the descriptor check happens BEFORE any value is
  // read, so a getter (even a throwing one) is never invoked and a setter is
  // never triggered. Polluting keys are refused before any copy, so the
  // validated copy can never gain them.
  for (const key of Reflect.ownKeys(payload)) {
    if (typeof key === 'symbol') return { ok: false, reason: 'symbol_key' };
    const d = Object.getOwnPropertyDescriptor(payload, key);
    if (!d) return { ok: false, reason: 'inaccessible_key:' + key };
    if (d.get !== undefined || d.set !== undefined) {
      return { ok: false, reason: 'accessor_property:' + key };
    }
    if (d.enumerable === false) return { ok: false, reason: 'non_enumerable:' + key };
    if (POLLUTING_KEYS.has(key)) return { ok: false, reason: 'polluting_key:' + key };
    const rule = rules[key];
    if (!rule) return { ok: false, reason: 'unknown_field:' + key };
    const v = payload[key];
    if (v === undefined || v === null || typeof v === 'object' || typeof v === 'function') {
      return { ok: false, reason: 'bad_value:' + key };
    }
    if (rule.type === 'string') {
      if (typeof v !== 'string' || v.length === 0 || v.length > rule.max) {
        return { ok: false, reason: 'bad_value:' + key };
      }
    } else if (rule.type === 'int') {
      if (typeof v !== 'number' || !rule.range(v)) return { ok: false, reason: 'bad_value:' + key };
    } else {
      return { ok: false, reason: 'bad_rule:' + key };
    }
    out[key] = v; // primitive copy; accessors were refused, so no getter runs
  }
  return { ok: true, payload: out };
}

// Wiring-layer check: the preload's exposed surface must equal the
// contract's renderer allowlist exactly (no more, no less, no order
// dependence, and no duplicates: a repeated name would hide a missing
// channel behind a Set). Returns { ok: true } or
// { ok: false, missing, extra, duplicates }.
function validatePreloadAllowlist(exposed) {
  if (!Array.isArray(exposed)) {
    return { ok: false, missing: RENDERER_CHANNELS.slice(), extra: [], duplicates: [], reason: 'not_a_list' };
  }
  const want = new Set(RENDERER_CHANNELS);
  const have = new Set(exposed);
  const missing = RENDERER_CHANNELS.filter((c) => !have.has(c));
  const extra = exposed.filter((c) => !want.has(c));
  const seen = new Set();
  const duplicates = [];
  for (const c of exposed) {
    if (seen.has(c)) {
      if (!duplicates.includes(c)) duplicates.push(c);
    } else {
      seen.add(c);
    }
  }
  return missing.length === 0 && extra.length === 0 && duplicates.length === 0
    ? { ok: true }
    : { ok: false, missing, extra, duplicates };
}

// Refusal shape every denied request maps to, so the renderer sees one
// consistent fail-closed answer and nothing about internals. Only a string
// reason passes through (clipped to 64 chars); anything else renders as the
// fixed token 'refused'. String() is never called on an arbitrary value:
// on an object with a throwing toString it throws, on a symbol it throws,
// and on any object it can leak representation details into the renderer.
function refusalResponse(reason) {
  return { ok: false, error: 'refused', reason: typeof reason === 'string' ? reason.slice(0, 64) : 'refused' };
}

module.exports = { RENDERER_CHANNELS, MAIN_ONLY_CHANNELS, validateRequest, validatePreloadAllowlist, refusalResponse };
