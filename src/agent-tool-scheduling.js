// Gate 2 scheduling gate: the schedule_create tool (24 Nov 2026).
//
// The FIRST agent-callable path into the M5 schedule book, implemented
// exactly as approved in docs/GATE2_SCHEDULING_FILE_OUTPUT_PROPOSAL.md
// (decision D-S1) and nothing more:
//
//   - capability "sensitive": the policy engine requires a FRESH one-time
//     approval for every call; a standing grant can NEVER authorize it.
//   - creation ONLY. The adapter performs exactly one mutation,
//     book.create(...). It never pauses, resumes, cancels, updates or
//     ticks. The product-owned tick stays the ONLY firing path and
//     delivery stays opt-in (proactive_enabled default false), so a
//     created schedule can never wake or notify anything until the user
//     opts in on the product surface.
//   - reminder scope ONLY: the registry schema pins scope to the single
//     value "reminder" and the adapter re-refuses anything else
//     (scope_deadline_refused). Agent-created deadlines stay out of scope.
//   - a bounded horizon: dueAt may not exceed now + 365 days
//     (due_at_too_far).
//   - exact-duplicate refusal: any record already in the book with the
//     same (scope, title, dueAt) is refused (duplicate_schedule), in any
//     state, cancelled included: the agent must not resurrect a
//     commitment the user cancelled.
//   - the book instance arrives by DEPENDENCY INJECTION. This module
//     never requires the scheduler module itself, so the wiring lock in
//     tests/agent-scheduler.test.js is only ever ADDed to, never relaxed.
//   - the injected audit is the WRITER for this entry: in a wired stack
//     main injects the persistence layer's durable audit wrapper (the same
//     writer the orchestrator uses), never the raw log, so sequence
//     numbers and persistence stay coordinated. Pure/unwired contexts may
//     inject the plain log.
//   - audit: on success one entry { actor 'agent', action
//     'schedule.create', tool 'schedule_create', decision 'allowed',
//     detail { schedule_id, scope, due_at } }, appended AFTER the create
//     so the approved id-bearing detail can exist. An append failure is
//     the approved failure mode: the step fails (audit_append_failed)
//     while the created schedule stays visible and cancellable on the
//     product surface; the run's own step events still record the failed
//     attempt. Detail keys follow the audit schema's lowercase rule.
//
// NOTHING IS REGISTERED: the production registry stays empty (pinned by
// tests and by src/main.js). Registering this definition into a live
// registry is the separately-approved enable step. No run can start
// until Stage-A decision D1 (the run entry point) is decided.
//
// Pure module: no requires, no I/O, no clock of its own.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CompanionAgentToolScheduling = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MAX_HORIZON_MS = 365 * 24 * 60 * 60 * 1000; // 365 days

  var SCHEDULING_TOOL_DEFINITION = {
    name: 'schedule_create',
    description: 'Create one user-approved reminder schedule (reversible; fires nothing; delivery stays opt-in)',
    capability: 'sensitive',
    critical: false,
    schema: {
      properties: {
        title: { type: 'string', required: true, maxLength: 120 },
        scope: { type: 'string', required: true, maxLength: 8, enum: ['reminder'] },
        due_at: { type: 'integer', required: true },
        notes: { type: 'string', maxLength: 500 },
      },
    },
  };

  function isPlainObject(v) {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
    var proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
  }

  function createSchedulingTool(opts) {
    var book = opts && opts.book;
    var clock = (opts && opts.clock) || function () { return Date.now(); };
    var audit = opts && opts.audit; // optional injected audit log
    if (!book || typeof book.create !== 'function' || typeof book.list !== 'function') {
      throw new Error('scheduling tool requires a schedule book');
    }

    function execute(args) {
      if (!isPlainObject(args)) return { ok: false, reason: 'args_invalid' };
      // Reminder scope only (the registry enum already refuses; re-check
      // here so a direct call cannot bypass the registry).
      if (args.scope !== 'reminder') return { ok: false, reason: 'scope_deadline_refused' };
      if (typeof args.due_at !== 'number' || !Number.isSafeInteger(args.due_at)) {
        return { ok: false, reason: 'due_at_invalid' };
      }
      var now = clock();
      if (args.due_at <= now) return { ok: false, reason: 'due_at_past' };
      if (args.due_at > now + MAX_HORIZON_MS) return { ok: false, reason: 'due_at_too_far' };

      // Exact-duplicate refusal across the whole book, any state
      // (cancelled included: never resurrect a cancelled commitment).
      var existing = book.list();
      for (var i = 0; i < existing.length; i++) {
        var r = existing[i];
        if (r.scope === args.scope && r.title === args.title && r.dueAt === args.due_at) {
          return { ok: false, reason: 'duplicate_schedule' };
        }
      }

      var created = book.create({
        title: args.title,
        scope: args.scope,
        dueAt: args.due_at,
        notes: args.notes,
      });
      if (!created || created.ok !== true) {
        return { ok: false, reason: (created && created.reason) || 'create_failed' };
      }

      if (audit) {
        var entry = audit.append({
          actor: 'agent',
          action: 'schedule.create',
          tool: SCHEDULING_TOOL_DEFINITION.name,
          decision: 'allowed',
          detail: {
            schedule_id: created.schedule.id,
            scope: created.schedule.scope,
            due_at: created.schedule.dueAt,
          },
        });
        if (!entry || entry.ok !== true) {
          // Approved failure mode: the step fails; the created schedule
          // remains visible and cancellable on the product surface.
          return { ok: false, reason: 'audit_append_failed' };
        }
      }

      return { ok: true, schedule: created.schedule };
    }

    return { definition: SCHEDULING_TOOL_DEFINITION, execute: execute };
  }

  return {
    createSchedulingTool: createSchedulingTool,
    SCHEDULING_TOOL_DEFINITION: SCHEDULING_TOOL_DEFINITION,
    MAX_HORIZON_MS: MAX_HORIZON_MS,
  };
});
