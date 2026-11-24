'use strict';

// M5 slice 1 (wiring): the proactive scheduler's USER surface.
//
// The renderer reaches the scheduler through six product channels, exactly
// like settings:*: an explicit user gesture in the UI creates, pauses,
// resumes, cancels or edits a schedule, or reads the list. This is NOT the Gate 2
// agent contract: ipc-contract.js RENDERER_CHANNELS stays read-only, the
// agent registry never sees the scheduler, and no agent path can create,
// pause or fire a schedule. "Proactive actions run only on schedules the
// user set" is enforced by that split.
//
// Boundaries this module enforces:
//   - Every payload is a plain object with strictly typed, length-capped
//     fields; unknown keys, accessors, symbols and polluting keys are
//     refused before any value is read (mirrors ipc-contract's rules).
//   - Every write goes through the persistence layer's durable audit
//     guarantees: the audit row and the state commit together, and a
//     failed append or save rolls the in-memory record back so nothing
//     converges as a phantom.
//   - Refusals are bounded plain reasons; internal errors never cross.

const MAX_TITLE = 120;
const MAX_NOTES = 500;
const MAX_ID = 16;
const SCOPES = ['reminder', 'deadline'];
const POLLUTING_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function bad(reason) { return { ok: false, reason }; }

function validatePayload(payload, rules) {
  if (payload === undefined || payload === null) {
    const required = Object.keys(rules).find((k) => !rules[k].optional);
    return required ? bad('missing_field:' + required) : { ok: true, payload: {} };
  }
  if (!isPlainObject(payload)) return bad('bad_payload');
  const out = {};
  for (const key of Reflect.ownKeys(payload)) {
    if (typeof key === 'symbol') return bad('symbol_key');
    const d = Object.getOwnPropertyDescriptor(payload, key);
    if (!d) return bad('inaccessible_key:' + key);
    if (d.get !== undefined || d.set !== undefined) return bad('accessor_property:' + key);
    if (d.enumerable === false) return bad('non_enumerable:' + key);
    if (POLLUTING_KEYS.has(key)) return bad('polluting_key:' + key);
    const rule = rules[key];
    if (!rule) return bad('unknown_field:' + key);
    const v = payload[key];
    if (v === undefined || v === null || typeof v === 'object' || typeof v === 'function') return bad('bad_value:' + key);
    if (rule.type === 'string') {
      if (typeof v !== 'string' || v.length === 0 || v.length > rule.max) return bad('bad_value:' + key);
      out[key] = v;
    } else if (rule.type === 'int') {
      if (!Number.isSafeInteger(v) || v < rule.min || v > rule.max) return bad('bad_value:' + key);
      out[key] = v;
    } else {
      return bad('bad_rule:' + key);
    }
  }
  for (const k of Object.keys(rules)) {
    if (!rules[k].optional && !(k in out)) return bad('missing_field:' + k);
  }
  return { ok: true, payload: out };
}

// Durable write helper: mutate, audit, save, and roll the mutation back if
// the audit row or the save failed, so the store never converges a phantom.
function durableWrite(persistence, entry, mutate, rollback) {
  const applied = mutate();
  if (!applied || applied.ok !== true) return applied;
  const a = persistence.appendAudit(entry);
  if (!a || a.ok !== true) {
    rollback();
    return { ok: false, reason: (a && a.reason) || 'audit_refused' };
  }
  const s = persistence.save();
  if (!s || s.ok !== true) {
    rollback();
    return { ok: false, reason: 'persist_failure' };
  }
  return applied;
}

function projectRecord(r) {
  if (!r || typeof r !== 'object') return null;
  return {
    id: typeof r.id === 'string' ? r.id : null,
    title: typeof r.title === 'string' ? r.title.slice(0, MAX_TITLE) : null,
    scope: SCOPES.includes(r.scope) ? r.scope : null,
    dueAt: Number.isSafeInteger(r.dueAt) ? r.dueAt : null,
    notes: typeof r.notes === 'string' ? r.notes.slice(0, MAX_NOTES) : null,
    createdAt: Number.isSafeInteger(r.createdAt) ? r.createdAt : null,
    paused: r.paused === true,
    cancelled: r.cancelled === true,
    deferredTo: Number.isSafeInteger(r.deferredTo) ? r.deferredTo : null,
    firedAt: Number.isSafeInteger(r.firedAt) ? r.firedAt : null,
  };
}

function createSchedulerSurface({ schedules, persistence } = {}) {
  if (!schedules || typeof schedules.create !== 'function' || typeof schedules.list !== 'function') {
    throw new TypeError('scheduler surface needs a schedule book');
  }
  if (!persistence || typeof persistence.appendAudit !== 'function' || typeof persistence.save !== 'function') {
    throw new TypeError('scheduler surface needs the persistence layer');
  }

  const CREATE_RULES = {
    title: { type: 'string', max: MAX_TITLE },
    scope: { type: 'string', max: 16 },
    dueAt: { type: 'int', min: 0, max: Number.MAX_SAFE_INTEGER },
    notes: { type: 'string', max: MAX_NOTES, optional: true },
  };
  const ID_RULES = { id: { type: 'string', max: MAX_ID } };
  const LIST_RULES = { limit: { type: 'int', min: 1, max: 500, optional: true } };
  const UPDATE_RULES = {
    id: { type: 'string', max: MAX_ID },
    title: { type: 'string', max: MAX_TITLE, optional: true },
    dueAt: { type: 'int', min: 0, max: Number.MAX_SAFE_INTEGER, optional: true },
  };

  function audit(entry) {
    return persistence.appendAudit(entry);
  }

  function create(f) {
    if (!SCOPES.includes(f.scope)) return { ok: false, reason: 'scope_invalid' };
    const made = schedules.create({ title: f.title, scope: f.scope, dueAt: f.dueAt, notes: f.notes });
    if (!made.ok) return made;
    const dur = durableWrite(
      persistence,
      { actor: 'user', action: 'schedules.created', detail: { id: made.schedule.id, scope: made.schedule.scope, due_at: made.schedule.dueAt } },
      () => ({ ok: true }),
      () => { schedules.remove(made.schedule.id); }
    );
    if (!dur.ok) return dur;
    return { ok: true, schedule: projectRecord(schedules.list().find((s) => s.id === made.schedule.id)) };
  }

  function scopeOp(f, op, action) {
    const dur = durableWrite(
      persistence,
      { actor: 'user', action, detail: { id: f.id } },
      () => op(f.id),
      () => {}
    );
    if (!dur.ok) return dur;
    return { ok: true, schedule: projectRecord(dur.schedule) };
  }

  // The audit log validates detail keys (lowercase) and values (no
  // undefined), so the edit entry carries only what the caller changed.
  function updateDetail(payload) {
    const d = { id: payload.id };
    if (payload.title !== undefined) d.title = payload.title;
    if (payload.dueAt !== undefined) d.due_at = payload.dueAt;
    return d;
  }

  const handlers = {
    'schedules:create': async (payload) => {
      const v = validatePayload(payload, CREATE_RULES);
      if (!v.ok) return v;
      try { return create(v.payload); } catch (e) { return bad('refused'); }
    },
    'schedules:list': async (payload) => {
      const v = validatePayload(payload, LIST_RULES);
      if (!v.ok) return v;
      try {
        const limit = v.payload.limit || 500;
        return { ok: true, schedules: schedules.list().slice(0, limit).map(projectRecord).filter(Boolean) };
      } catch (e) { return bad('refused'); }
    },
    'schedules:pause': async (payload) => {
      const v = validatePayload(payload, ID_RULES);
      if (!v.ok) return v;
      try { return scopeOp(v.payload, (id) => schedules.pause(id), 'schedules.paused'); } catch (e) { return bad('refused'); }
    },
    'schedules:resume': async (payload) => {
      const v = validatePayload(payload, ID_RULES);
      if (!v.ok) return v;
      try { return scopeOp(v.payload, (id) => schedules.resume(id), 'schedules.resumed'); } catch (e) { return bad('refused'); }
    },
    'schedules:cancel': async (payload) => {
      const v = validatePayload(payload, ID_RULES);
      if (!v.ok) return v;
      try { return scopeOp(v.payload, (id) => schedules.cancel(id), 'schedules.cancelled'); } catch (e) { return bad('refused'); }
    },
    'schedules:update': async (payload) => {
      const v = validatePayload(payload, UPDATE_RULES);
      if (!v.ok) return v;
      if (v.payload.title === undefined && v.payload.dueAt === undefined) return bad('nothing_to_update');
      try {
        const before = schedules.list().find((s) => s.id === v.payload.id);
        if (!before) return bad('schedule_unknown');
        const dur = durableWrite(
          persistence,
          { actor: 'user', action: 'schedules.updated', detail: updateDetail(v.payload) },
          () => schedules.update(v.payload),
          () => schedules.update({ id: v.payload.id, title: before.title, dueAt: before.dueAt })
        );
        if (!dur.ok) return dur;
        return { ok: true, schedule: projectRecord(dur.schedule) };
      } catch (e) { return bad('refused'); }
    },
  };

  function registerIpc(dispatch) {
    if (!dispatch || typeof dispatch.handle !== 'function') throw new TypeError('dispatcher needs handle(channel, fn)');
    for (const channel of Object.keys(handlers)) dispatch.handle(channel, handlers[channel]);
  }

  return { handlers, registerIpc };
}

module.exports = { createSchedulerSurface, validatePayload };
