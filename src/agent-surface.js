'use strict';
// Gate 2 wiring slice 1 (main side): the read-only agent surface.
//
// Main owns the agent runtime. The renderer sees exactly the six read
// channels of src/ipc-contract.js, every request validated, every refusal
// bounded. This module is pure: it builds handlers from reader functions
// and can register them on any dispatcher with a handle(channel, fn)
// method, so tests drive it without Electron.
//
// Boundaries this module enforces:
//   - Handlers exist ONLY for RENDERER_CHANNELS. No main-only channel
//     (run start/step/resume/abort, approvals, grants, emergency stop,
//     persistence) is built, named, or reachable here.
//   - Every payload passes validateRequest before a reader runs; a
//     request that fails validation is never forwarded.
//   - Reader output is shaped to bounded plain data before it leaves:
//     arrays capped (never above the contract's 500 ceiling), every record
//     reduced to own string-keyed primitive fields with strings clipped
//     and non-finite numbers dropped, one nested plain-object level kept
//     (the audit sanitizer's detail shape). Nothing raw crosses.
//   - A reader that throws maps to the standard refusal; the error text
//     never reaches the renderer.

const { RENDERER_CHANNELS, validateRequest, refusalResponse } = require('./ipc-contract.js');

const MAX_RESULTS = 500;
const MAX_KEY = 32;
const MAX_STR = 200;
const MAX_HASH = 128;

function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

// depth bounds how many nested plain-object levels survive: 1 at the top
// (a record's fields), 0 inside them. Arrays, symbols, bigints and
// functions never survive.
function boundedValue(v, depth) {
  if (v === null) return null;
  const t = typeof v;
  if (t === 'string') return v.length > MAX_STR ? v.slice(0, MAX_STR) : v;
  if (t === 'number') return Number.isFinite(v) ? v : null;
  if (t === 'boolean') return v;
  if (depth > 0 && isPlainObject(v)) {
    const out = {};
    for (const k of Object.keys(v)) {
      if (k.length === 0 || k.length > MAX_KEY) continue;
      const nested = boundedValue(v[k], depth - 1);
      if (nested !== null) out[k] = nested;
    }
    return out;
  }
  return null; // dropped
}

function boundedRecord(rec, depth) {
  if (!isPlainObject(rec)) return null;
  const out = {};
  for (const key of Object.keys(rec)) {
    if (key.length === 0 || key.length > MAX_KEY) continue;
    const raw = rec[key];
    if (raw === null) {
      out[key] = null;
      continue;
    }
    const v = boundedValue(raw, depth);
    if (v !== null) out[key] = v;
  }
  return out;
}

function boundedRecords(list, max) {
  if (!Array.isArray(list)) return [];
  const cap = Number.isInteger(max) && max > 0 && max <= MAX_RESULTS ? max : MAX_RESULTS;
  const out = [];
  for (const rec of list.slice(0, cap)) {
    const r = boundedRecord(rec, 1);
    if (r !== null) out.push(r);
  }
  return out;
}

// One run-state record flattened to bounded primitives. Steps become a
// joined, clipped string; pending-approval args (arbitrary objects) are
// dropped and only the step id and tool name survive.
function projectRun(state) {
  if (!state || typeof state !== 'object') return null;
  const out = {};
  for (const k of ['runId', 'goal', 'state', 'stepIndex', 'attempts', 'startedAt', 'finishedAt']) {
    if (!(k in state)) continue;
    if (state[k] === null) {
      out[k] = null;
      continue;
    }
    const v = boundedValue(state[k], 0);
    if (v !== null) out[k] = v;
  }
  if (Array.isArray(state.steps)) {
    out.stepsCount = state.steps.length;
    out.stepsJoined = state.steps.join(',').slice(0, MAX_STR);
  }
  if (state.pendingApproval && typeof state.pendingApproval === 'object') {
    out.pendingStepId = boundedValue(state.pendingApproval.stepId, 0);
    out.pendingTool = boundedValue(state.pendingApproval.tool, 0);
  }
  return out;
}

function createAgentSurface(readers) {
  const r = readers || {};
  for (const name of ['status', 'listRuns', 'readAudit', 'listProviders', 'listNotifications', 'listReminders']) {
    if (typeof r[name] !== 'function') throw new TypeError('agent surface needs a ' + name + ' reader');
  }

  function handlerFor(channel, read) {
    return async (payload) => {
      const v = validateRequest(channel, payload);
      if (!v.ok) return refusalResponse(v.reason);
      let data;
      try {
        data = await read(v.payload);
      } catch (e) {
        return refusalResponse('refused'); // never leak reader internals
      }
      return { ok: true, data };
    };
  }

  const handlers = {
    'status:get': handlerFor('status:get', () => boundedRecord(r.status(), 1)),
    'runs:get': handlerFor('runs:get', (f) => {
      const found = r.listRuns(f.runId);
      const states = Array.isArray(found) ? found.map(projectRun).filter(Boolean) : [];
      return { runs: boundedRecords(states, MAX_RESULTS) };
    }),
    'audit:read': handlerFor('audit:read', (f) => {
      const snap = r.readAudit(f) || {};
      const entries = Array.isArray(snap.entries) ? snap.entries : [];
      return {
        base: boundedRecord(snap.base, 1),
        entries: boundedRecords(entries, f.limit),
        lastHash: typeof snap.lastHash === 'string' ? snap.lastHash.slice(0, MAX_HASH) : null,
        verified: snap.verified === true,
      };
    }),
    'providers:get': handlerFor('providers:get', (f) => {
      const found = r.listProviders(f.name);
      return { providers: boundedRecords(Array.isArray(found) ? found : [], MAX_RESULTS) };
    }),
    'notifications:read': handlerFor('notifications:read', (f) => {
      const found = r.listNotifications(f.limit);
      return { notifications: boundedRecords(Array.isArray(found) ? found : [], f.limit) };
    }),
    'reminders:read': handlerFor('reminders:read', (f) => {
      const found = r.listReminders(f.limit);
      return { reminders: boundedRecords(Array.isArray(found) ? found : [], f.limit) };
    }),
  };

  function registerIpc(dispatch) {
    if (!dispatch || typeof dispatch.handle !== 'function') throw new TypeError('dispatcher needs handle(channel, fn)');
    for (const channel of RENDERER_CHANNELS) dispatch.handle(channel, handlers[channel]);
    return RENDERER_CHANNELS.slice();
  }

  return { handlers, registerIpc, channels: RENDERER_CHANNELS.slice() };
}

module.exports = { createAgentSurface, boundedRecord, boundedRecords, projectRun };
