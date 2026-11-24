'use strict';

// Gate 2 slice 3j.9, Stage A: the agent run driver. The driver is the ONLY
// main-side code that may drive an orchestrator run, so startRun/step/resume
// finally have exactly one caller with exactly one review point. Stage A
// scope, per the approved design and decisions D1-D7:
//
//   D1  Runs exist only as explicit user-initiated plans. No source in this
//       build calls the driver yet; the entry point that creates a run
//       request from a user gesture is a LATER gate. Until then the driver
//       is constructed, tested, and never fired by the app.
//   D2  Write-capable tools stay OUT of the registry (see tool-registry:
//       the shipped registry is constructed empty and main registers
//       nothing). Pre-validation here refuses forbidden-capability tools
//       before a run ever starts.
//   D3  A paused run parks indefinitely. The ledger row keeps its
//       'running' status; nothing in Stage A resumes anything on its own.
//   D4  At startup, runs still marked 'running' in the ledger are marked
//       'aborted' with one bounded system audit entry (see
//       agent-persistence.reconcileInterruptedRuns). No notification is
//       created for an interrupted run: it was never driven by this
//       session.
//   D5  Terminal notifications exist for COMPLETED and ABORTED only. They
//       carry generic allowlisted copy plus the sanitized run id. Ledger
//       transitions happen first; a notification failure never changes a
//       run's outcome.
//   D6  Step arguments never reach the renderer: projectRun in
//       agent-surface.js projects pendingStepId/pendingTool only, and a
//       static test locks that in.
//   D7  The ledger records a run 'kind'. Stage A allows exactly one kind,
//       'user'. A 'scheduled' kind joins the allowlist only when the
//       scheduling gate itself lands; until then it is refused, fail
//       closed.
//
// Stage B (real tool implementations, approval mechanics end to end) and
// Stage C (renderer run controls) are NOT in this slice.

// Keep in sync with tool-registry LIMITS.
const MAX_PLAN_STEPS = 64;
const MAX_RETRIES = 3;
const MAX_GOAL = 200;
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// D7 allowlist. Deliberately one entry.
const KINDS = ['user'];

// D5: terminal notification copy, allowlisted, generic, plus the run id.
const TERMINAL_NOTIFICATIONS = {
  completed: { title: 'Agent run completed', body: (id) => 'Run ' + id + ' completed.' },
  aborted: { title: 'Agent run stopped', body: (id) => 'Run ' + id + ' was stopped.' },
};

// Orchestrator terminal state -> ledger status.
const TERMINAL_STATUS = { completed: 'succeeded', aborted: 'aborted' };

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CompanionRunDriver = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function createRunDriver({ orchestrator, persistence, notifications, registry, clock, randomHex } = {}) {
    for (const name of ['startRun', 'step', 'resume', 'getRun']) {
      if (!orchestrator || typeof orchestrator[name] !== 'function') {
        throw new TypeError('run driver needs an orchestrator with ' + name);
      }
    }
    if (!persistence || typeof persistence.startRun !== 'function' || typeof persistence.finishRun !== 'function') {
      throw new TypeError('run driver needs persistence with startRun and finishRun');
    }
    if (!notifications || typeof notifications.create !== 'function' || typeof notifications.list !== 'function') {
      throw new TypeError('run driver needs notifications with create and list');
    }
    if (!registry || typeof registry.get !== 'function' || typeof registry.validateArgs !== 'function') {
      throw new TypeError('run driver needs a tool registry with get and validateArgs');
    }
    const nowMs = typeof clock === 'function' ? clock : Date.now;
    const rand = typeof randomHex === 'function' ? randomHex : null;

    // Stage A has no sandboxed randomness source requirement beyond the
    // standard module; run ids are identifiers, not secrets.
    function defaultRandomHex(n) {
      // eslint-disable-next-line no-undef
      const crypto = require('crypto');
      return crypto.randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n);
    }

    function generateRunId() {
      const compact = new Date(nowMs()).toISOString().replace(/[-:]/g, '').replace(/\./g, '');
      const hex = (rand || defaultRandomHex)(6);
      return ('run-' + compact + '-' + hex).slice(0, 64);
    }

    // Pre-validation, fail closed, BEFORE anything starts. The orchestrator
    // re-validates everything (defense in depth); this pass exists to
    // refuse registry-level problems with a clear reason and to enforce
    // D2/D7 boundaries the orchestrator cannot see.
    function preValidate({ goal, plan, kind, runId }) {
      if (KINDS.indexOf(kind) === -1) return { ok: false, reason: 'kind_invalid' };
      if (runId !== undefined && (typeof runId !== 'string' || !RUN_ID_RE.test(runId))) {
        return { ok: false, reason: 'run_id_invalid' };
      }
      if (goal !== undefined && (typeof goal !== 'string' || goal.length === 0 || goal.length > MAX_GOAL)) {
        return { ok: false, reason: 'goal_invalid' };
      }
      if (!Array.isArray(plan) || plan.length === 0 || plan.length > MAX_PLAN_STEPS) {
        return { ok: false, reason: 'plan_invalid' };
      }
      const seen = new Set();
      for (const step of plan) {
        if (!isPlainObject(step)) return { ok: false, reason: 'plan_invalid' };
        if (typeof step.id !== 'string' || step.id.length === 0 || step.id.length > 64) {
          return { ok: false, reason: 'plan_invalid' };
        }
        if (seen.has(step.id)) return { ok: false, reason: 'plan_invalid' };
        seen.add(step.id);
        if (typeof step.tool !== 'string' || step.tool.length === 0 || step.tool.length > 64) {
          return { ok: false, reason: 'plan_invalid' };
        }
        if (!isPlainObject(step.args)) return { ok: false, reason: 'plan_invalid' };
        if (typeof step.run !== 'function') return { ok: false, reason: 'plan_invalid' };
        if (step.retries !== undefined && (!Number.isInteger(step.retries) || step.retries < 0 || step.retries > MAX_RETRIES)) {
          return { ok: false, reason: 'plan_invalid' };
        }
        if (step.recovery !== undefined && step.recovery !== 'abort' && step.recovery !== 'skip') {
          return { ok: false, reason: 'plan_invalid' };
        }
        if (step.needsApproval !== undefined && typeof step.needsApproval !== 'boolean') {
          return { ok: false, reason: 'plan_invalid' };
        }
        const def = registry.get(step.tool);
        if (!def) return { ok: false, reason: 'plan_tool_unknown' };
        if (def.capability === 'forbidden') return { ok: false, reason: 'plan_tool_forbidden' };
        const va = registry.validateArgs(step.tool, step.args);
        if (!va || va.ok !== true) return { ok: false, reason: 'plan_args_invalid' };
      }
      return { ok: true, runId: runId === undefined ? null : runId };
    }

    // D5 secondary fallback: if the desk already carries the exact record
    // this pass would create (a restart-replay guard), do not create a
    // duplicate. A broken list reader is caught and never stops the run.
    function deskHas(body) {
      try {
        const existing = notifications.list();
        return Array.isArray(existing) && existing.some((r) => r && r.body === body);
      } catch (err) {
        return false;
      }
    }

    function createTerminalNotification(status, runId, report) {
      const spec = TERMINAL_NOTIFICATIONS[status];
      if (!spec) return;
      const body = spec.body(runId);
      if (deskHas(body)) {
        report.notified = false;
        report.notifyReason = 'already_delivered';
        return;
      }
      try {
        const r = notifications.create({ title: spec.title, body, priority: 'normal' });
        if (r && r.ok === true) {
          report.notified = true;
          report.notificationId = (r.notification && r.notification.id) || null;
        } else {
          report.notified = false;
          report.notifyReason = String((r && r.reason) || 'notification_refused');
        }
      } catch (err) {
        report.notified = false;
        report.notifyReason = 'notification_error';
      }
    }

    // Drive the run from wherever it stands to its next stop: a terminal
    // state, a pause (approval / stop), a refusal, or the defensive loop
    // guard. Never throws; never treats an unknown shape as progress.
    function driveToStop(runId, planLen) {
      const cap = Math.max(planLen, 1) * (MAX_RETRIES + 1) + 8;
      let guard = 0;
      for (;;) {
        guard += 1;
        if (guard > cap) return { stopped: 'loop_guard' };
        let r;
        try {
          r = orchestrator.step(runId);
        } catch (err) {
          return { error: 'step_error' };
        }
        if (!r || typeof r !== 'object') return { error: 'step_invalid' };
        if (r.ok === false) {
          if (r.state === 'aborted') return { terminal: 'aborted' };
          return { error: String(r.reason || 'step_refused') };
        }
        if (r.state === 'completed') return { terminal: 'completed' };
        if (r.state === 'paused_stop' || r.state === 'awaiting_approval') return { paused: r.state };
        if (r.state === 'running') continue;
        return { error: 'step_state_invalid' };
      }
    }

    // Shared terminal/pause handling after a drive pass. Ledger first,
    // notification second, save last; a later failure never undoes an
    // earlier committed step.
    function finishPass(runId, driven, report) {
      if (driven.terminal) {
        const status = TERMINAL_STATUS[driven.terminal];
        report.state = driven.terminal;
        const f = persistence.finishRun({ runId, status });
        if (f && f.ok === true) {
          report.ledgerFinished = true;
          createTerminalNotification(driven.terminal, runId, report);
        } else {
          report.ledgerFinished = false;
          report.ledgerFinishReason = String((f && f.reason) || 'persist_failure');
          // No notification without a committed ledger transition: the
          // primary dedupe source is the ledger itself.
        }
      } else if (driven.paused) {
        // D3: parked indefinitely; the ledger row keeps 'running'.
        report.state = driven.paused;
      } else {
        // Refusal or guard: the orchestrator froze or refused; the ledger
        // row (if any) stays as it is and is reconciled at restart (D4).
        report.stopped = driven.stopped || driven.error || 'unknown';
      }
      try {
        const sv = persistence.save();
        report.saved = !!(sv && sv.ok === true);
        if (!report.saved) report.saveReason = String((sv && sv.reason) || 'persist_failure');
      } catch (err) {
        report.saved = false;
        report.saveReason = 'save_error';
      }
      return report;
    }

    function run({ goal, plan, kind, runId } = {}) {
      const pre = preValidate({ goal, plan, kind, runId });
      if (!pre.ok) return { ok: false, reason: pre.reason };
      const id = pre.runId || generateRunId();
      let s;
      try {
        s = orchestrator.startRun({ runId: id, goal, plan });
      } catch (err) {
        return { ok: false, runId: id, reason: 'start_error' };
      }
      if (!s || s.ok !== true) {
        return { ok: false, runId: id, reason: String((s && s.reason) || 'start_refused') };
      }
      const report = {
        ok: true,
        runId: id,
        kind,
        steps: plan.length,
        ledgerStarted: false,
        ledgerFinished: false,
        notified: false,
        saved: false,
      };
      try {
        const l = persistence.startRun({ runId: id, kind });
        if (l && l.ok === true) {
          report.ledgerStarted = true;
        } else {
          // duplicate_run_id on a restart replay is bookkeeping only; the
          // in-memory run proceeds and the ledger note stands.
          report.ledgerStartReason = String((l && l.reason) || 'persist_failure');
        }
      } catch (err) {
        report.ledgerStartReason = 'persist_error';
      }
      const driven = driveToStop(id, plan.length);
      return finishPass(id, driven, report);
    }

    function resume(runId, { approvalId } = {}) {
      if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) {
        return { ok: false, reason: 'run_id_invalid' };
      }
      let r;
      try {
        r = orchestrator.resume(runId, { approvalId });
      } catch (err) {
        return { ok: false, runId, reason: 'resume_error' };
      }
      if (!r || r.ok !== true) {
        return { ok: false, runId, reason: String((r && r.reason) || 'resume_refused') };
      }
      const state = r.run && typeof r.run === 'object' ? r.run : null;
      const planLen = state && Array.isArray(state.plan) ? state.plan.length : 8;
      const report = {
        ok: true,
        runId,
        resumed: true,
        ledgerStarted: true,
        ledgerFinished: false,
        notified: false,
        saved: false,
      };
      const driven = driveToStop(runId, planLen);
      return finishPass(runId, driven, report);
    }

    return {
      run,
      resume,
      kinds: KINDS.slice(),
      maxPlanSteps: MAX_PLAN_STEPS,
    };
  }

  return { createRunDriver, KINDS, TERMINAL_NOTIFICATIONS, TERMINAL_STATUS, RUN_ID_RE };
});
