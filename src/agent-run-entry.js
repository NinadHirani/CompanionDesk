// Gate 2 run entry point (25 Nov 2026): Stage A decision D1, option (a) --
// the scheduling gate is the ONLY source of run requests.
//
// Decided by Ninad on 25 Nov 2026 and implemented exactly as proposed in
// docs/RUN_DRIVER_DESIGN.md section 4 and the D1 decision brief:
//
//   - A run request is born main-side. The renderer may never receive a
//     run-control channel (preload contract), model-driven execution is
//     forbidden, and the driver never plans; this module is the ONLY
//     caller of driver.run() in the entire app (wired in src/main.js).
//   - ORIGIN PROOF (fail closed): a request names a schedule, and the
//     durable audit must carry the scheduling gate's own creation entry
//     for exactly that schedule (action 'schedule.create', tool
//     'schedule_create', detail.schedule_id). A schedule created on the
//     product surface, or one whose creation audit entry never landed
//     (the approved audit_append_failed mode), can NEVER start a run.
//   - INTENT BEFORE START (audit-first): after the origin proof, this
//     module appends the durable user-intent entry (actor 'user', action
//     'run.request', detail { schedule_id, source: 'scheduling_gate' })
//     BEFORE calling driver.run(). An append failure refuses the run
//     (intent_audit_failed); nothing starts without its intent entry.
//   - KIND DISCIPLINE (D-S2 untouched): the entry always passes kind
//     'user' to the driver and refuses any caller-supplied kind that is
//     not 'user' (kind_refused). The driver's own allowlist stays exactly
//     ['user']; the scheduled kind joins only if D-S2 is separately
//     approved. This module never forms plans: the plan arrives from the
//     caller (the future D-S2 firing path); reminder-scope schedules
//     carry no plan data, so there is nothing here to form one from.
//   - FAIL-CLOSED REFUSALS, in order: args_invalid, kind_refused,
//     schedule_unknown, schedule_cancelled, origin_unverified,
//     intent_audit_failed. The driver's own pre-validation (registry
//     existence, capability, args schema) still runs inside driver.run();
//     an intent entry may exist for a request the driver refused -- that
//     is the audit record of the attempt, and no run started.
//   - NOTHING FIRES: schedule_create stays unregistered and disabled
//     (the separately-approved enable step), the production registry
//     stays EMPTY (pinned by tests and src/main.js), and nothing in the
//     shipped app calls requestRun. No run can start.
//
// Pure module: no requires, no I/O, no clock, no timers, no channels.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CompanionAgentRunEntry = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var RUN_SOURCE = 'scheduling_gate';

  function isPlainObject(v) {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
    var proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
  }

  function createRunEntry(opts) {
    var driver = opts && opts.driver;
    var book = opts && opts.book;
    var audit = opts && opts.audit;
    if (!driver || typeof driver.run !== 'function') {
      throw new Error('run entry requires a run driver');
    }
    if (!book || typeof book.list !== 'function') {
      throw new Error('run entry requires a schedule book');
    }
    if (!audit || typeof audit.append !== 'function' || typeof audit.snapshot !== 'function') {
      throw new Error('run entry requires a durable audit');
    }

    function requestRun(req) {
      if (!isPlainObject(req)) return { ok: false, reason: 'args_invalid' };

      var scheduleId = req.scheduleId;
      if (typeof scheduleId !== 'string' || scheduleId.length === 0 || scheduleId.length > 64) {
        return { ok: false, reason: 'args_invalid' };
      }

      // D-S2 boundary at the entry itself: only 'user' ever leaves here.
      if (req.kind !== undefined && req.kind !== 'user') {
        return { ok: false, reason: 'kind_refused' };
      }

      // Shape-only plan check; the FULL validation (registry existence,
      // capability, per-step args schema, retries, recovery) stays inside
      // driver.run(), which must remain the single enforcing point.
      var plan = req.plan;
      if (!Array.isArray(plan) || plan.length === 0) return { ok: false, reason: 'args_invalid' };
      for (var i = 0; i < plan.length; i++) {
        var s = plan[i];
        if (!isPlainObject(s) || typeof s.id !== 'string' || s.id.length === 0 ||
            typeof s.tool !== 'string' || !isPlainObject(s.args) || typeof s.run !== 'function') {
          return { ok: false, reason: 'args_invalid' };
        }
      }
      var goal = req.goal;
      if (goal !== undefined && (typeof goal !== 'string' || goal.length === 0)) {
        return { ok: false, reason: 'args_invalid' };
      }

      // 1. The named schedule must exist and must not have been cancelled
      //    (never resurrect a commitment the user revoked).
      var rec = null;
      try {
        var all = book.list();
        if (Array.isArray(all)) {
          for (var k = 0; k < all.length; k++) {
            if (all[k] && all[k].id === scheduleId) { rec = all[k]; break; }
          }
        }
      } catch (err) { rec = null; }
      if (!rec) return { ok: false, reason: 'schedule_unknown' };
      if (rec.cancelled) return { ok: false, reason: 'schedule_cancelled' };

      // 2. Origin proof from the durable audit: the scheduling gate's own
      //    creation entry for exactly this schedule id. An unreadable or
      //    empty audit refuses (fail closed), as does a schedule the gate
      //    never created.
      var originFound = false;
      try {
        var snap = audit.snapshot();
        var entries = (snap && snap.entries) || [];
        for (var j = 0; j < entries.length; j++) {
          var e = entries[j];
          if (e && e.action === 'schedule.create' && e.tool === 'schedule_create' &&
              e.detail && e.detail.schedule_id === scheduleId) {
            originFound = true;
            break;
          }
        }
      } catch (err) {
        return { ok: false, reason: 'origin_unverified' };
      }
      if (!originFound) return { ok: false, reason: 'origin_unverified' };

      // 3. Durable user-intent entry BEFORE startRun (audit-first). A
      //    failed or refused append refuses the whole request.
      var intent = null;
      try {
        intent = audit.append({
          actor: 'user',
          action: 'run.request',
          decision: 'allowed',
          detail: { schedule_id: scheduleId, source: RUN_SOURCE },
        });
      } catch (err) {
        intent = null;
      }
      if (!intent || intent.ok !== true) return { ok: false, reason: 'intent_audit_failed' };

      // 4. The ONLY call into driver.run() in the entire app, always with
      //    kind 'user'.
      var res = driver.run({ goal: goal, plan: plan, kind: 'user', runId: req.runId });
      if (res && typeof res === 'object' && !Array.isArray(res)) {
        res.scheduleId = scheduleId;
      }
      return res;
    }

    return { requestRun: requestRun };
  }

  return { createRunEntry: createRunEntry, RUN_SOURCE: RUN_SOURCE };
});
