'use strict';

// Gate 2 slice 3: the agent orchestrator. A bounded, declarative run loop
// over a pre-declared plan: plan, act, observe, verify, recover. There is no
// free-form agent loop here and no model call: the plan is an explicit input,
// every step names one registered tool and exact args, and every step carries
// its own executor closure so the pure module stays I/O-free. Authorization,
// approvals, the emergency stop and the audit log are the slice 1/2 modules;
// persistence stays out of this slice (the wiring layer calls
// agent-persistence around this module; there is no resume-after-restart).
//
// Fail-closed rules:
// - The emergency stop is checked before every step and pauses the run; only
//   an explicit resume continues, and it refuses while the stop is active.
// - A step flagged needsApproval never executes on its own: the orchestrator
//   pauses and waits for the caller to supply an approval id created by the
//   user's explicit yes. The orchestrator NEVER creates an approval itself.
// - The approval is verified against the exact tool and args and consumed
//   immediately before execution, once, on the attempt that runs.
// - Authorization is re-checked before every attempt; a denied authorization
//   aborts the run (denied access is never skippable).
// - An uninterpretable step result is a failure, not a success.
// - Every transition is audited with log-before-commit ordering: the audit
//   entry is accepted FIRST and the in-memory state moves only after. A run
//   is never registered, paused, resumed, advanced, skipped or finished
//   without its audit entry on record.
// - ANY audit append failure (a refused entry or a throwing sink) poisons
//   the orchestrator: every further operation returns audit_failed and
//   nothing at all executes while the sink is unhealthy. Recovery is a new
//   orchestrator instance, which is what a restart gives the wiring layer;
//   this module never continues on an unverified trail.
// - Nothing is ever resumed automatically after a restart (this module has
//   no persistence surface at all).
//
// Dual-mode: require() in Electron/Node, plain <script> in the web/mobile
// build (window.CompanionAgentOrchestrator).

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CompanionAgentOrchestrator = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const MAX_STEPS = 64;
  const MAX_SUMMARY = 200;
  const MAX_GOAL = 200;
  const MAX_RUN_ID = 128;
  const MAX_STEP_ID = 64;
  const MAX_TOOL = 128;
  const MAX_RETRIES = 3;
  const RECOVERIES = ['abort', 'skip'];

  function isPlainObject(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
  }

  function clip(s, n) {
    return typeof s === 'string' ? s.slice(0, n) : null;
  }

  // Observe: normalize one step result. Only { ok: boolean, summary? } shapes
  // and plain undefined/null (a void step) are interpretable; anything else
  // fails closed.
  function observeResult(raw) {
    if (raw === undefined || raw === null) return { ok: true, summary: null };
    if (isPlainObject(raw) && typeof raw.ok === 'boolean') {
      const summary = typeof raw.summary === 'string' ? clip(raw.summary, MAX_SUMMARY) : null;
      return { ok: raw.ok, summary };
    }
    return { ok: false, summary: null, malformed: true };
  }

  function planIssue(plan) {
    if (!Array.isArray(plan) || plan.length === 0) return 'plan_empty';
    if (plan.length > MAX_STEPS) return 'plan_too_long';
    const seen = new Set();
    for (const s of plan) {
      if (!s || typeof s !== 'object' || Array.isArray(s)) return 'step_invalid';
      if (typeof s.id !== 'string' || s.id.length === 0 || s.id.length > MAX_STEP_ID) return 'step_id_invalid';
      if (seen.has(s.id)) return 'step_id_duplicate';
      seen.add(s.id);
      if (typeof s.tool !== 'string' || s.tool.length === 0 || s.tool.length > MAX_TOOL) return 'step_tool_invalid';
      if (!isPlainObject(s.args)) return 'step_args_invalid';
      if (typeof s.run !== 'function') return 'step_run_missing';
      if (s.retries !== undefined && (typeof s.retries !== 'number' || !Number.isInteger(s.retries) || s.retries < 0 || s.retries > MAX_RETRIES)) return 'step_retries_invalid';
      if (s.recovery !== undefined && RECOVERIES.indexOf(s.recovery) === -1) return 'step_recovery_invalid';
      if (s.verify !== undefined && typeof s.verify !== 'function') return 'step_verify_invalid';
    }
    return null;
  }

  function createOrchestrator({ engine, approvals, emergencyStop, audit, clock } = {}) {
    if (!engine) throw new Error('engine required');
    if (!approvals) throw new Error('approvals required');
    if (!emergencyStop) throw new Error('emergencyStop required');
    if (!audit) throw new Error('audit required');
    const now = clock || (() => Date.now());

    const runs = new Map(); // runId -> run record (in-memory only, this slice)
    let activeRunId = null;
    // Once any append is refused or throws, the audit trail can no longer be
    // trusted to record what happens next. The orchestrator poisons itself:
    // every further operation refuses with audit_failed until a new instance
    // (a restart) replaces it. There is no in-process recovery.
    let auditHealthy = true;

    // Write one audit entry and CHECK the result. The audit log carries
    // bounded, typed detail objects only (the sanitizer's schema: lowercase
    // keys, at most 8, string values capped); anything that would not fit is
    // clipped or dropped here, never passed raw. A refused entry or a
    // throwing sink poisons the orchestrator and is reported to the caller,
    // never swallowed.
    function audited(action, detail) {
      const d = {};
      if (detail) {
        for (const [k, v] of Object.entries(detail)) {
          if (v === undefined || v === null) continue;
          if (typeof v === 'string') d[k] = v.length > MAX_SUMMARY ? v.slice(0, MAX_SUMMARY) : v;
          else if (typeof v === 'number' && Number.isFinite(v)) d[k] = v;
          else if (typeof v === 'boolean') d[k] = v;
        }
      }
      let res;
      try {
        res = audit.append({ actor: 'agent', action, detail: d });
      } catch (err) {
        auditHealthy = false;
        return { ok: false, reason: 'audit_append_threw' };
      }
      if (!res || res.ok !== true) {
        auditHealthy = false;
        return { ok: false, reason: 'audit_append_refused', errors: res && res.errors };
      }
      return { ok: true };
    }

    function poisoned() {
      return !auditHealthy ? { ok: false, reason: 'audit_failed' } : null;
    }

    function runState(run) {
      return {
        runId: run.runId,
        goal: run.goal,
        state: run.state,
        stepIndex: run.stepIndex,
        steps: run.plan.map((s) => s.id),
        attempts: run.attempts,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt || null,
        pendingApproval: run.pendingApproval ? { stepId: run.pendingApproval.stepId, tool: run.pendingApproval.tool, args: run.pendingApproval.args } : null,
      };
    }

    // Terminal transition, log-before-commit: the run is marked finished and
    // releases the active slot ONLY after the entry was accepted. On an
    // append failure the run keeps its prior state (and, for an active run,
    // holds the slot) and the caller sees audit_failed.
    function finish(run, state, action, body) {
      if (!audited(action, body || {}).ok) return false;
      run.state = state;
      run.finishedAt = now();
      if (activeRunId === run.runId) activeRunId = null;
      return true;
    }

    function startRun({ runId, goal, plan } = {}) {
      const p = poisoned();
      if (p) return p;
      if (typeof runId !== 'string' || runId.length === 0 || runId.length > MAX_RUN_ID) return { ok: false, reason: 'run_id_invalid' };
      if (activeRunId !== null) return { ok: false, reason: 'active_run_exists', activeRunId };
      if (runs.has(runId)) return { ok: false, reason: 'duplicate_run_id' };
      if (emergencyStop.isActive()) return { ok: false, reason: 'stop_active' };
      if (goal !== undefined && (typeof goal !== 'string' || goal.length > MAX_GOAL)) return { ok: false, reason: 'goal_invalid' };
      const issue = planIssue(plan);
      if (issue) return { ok: false, reason: issue };
      // A shaped preview of the run, used for the audit entry; the run is
      // registered only after the entry was accepted.
      const shaped = {
        runId,
        goal: clip(goal, MAX_GOAL),
        plan: plan.map((s) => ({
          id: s.id,
          tool: s.tool,
          args: s.args,
          run: s.run,
          verify: s.verify || null,
          retries: s.retries === undefined ? 0 : s.retries,
          recovery: s.recovery === undefined ? 'abort' : s.recovery,
          needsApproval: s.needsApproval === true,
        })),
        state: 'running',
        stepIndex: 0,
        attempts: {},
        startedAt: now(),
        finishedAt: null,
        pendingApproval: null,
      };
      if (!audited('run.started', { run_id: runId, goal: shaped.goal, steps: shaped.plan.length }).ok) {
        return { ok: false, reason: 'audit_failed' };
      }
      runs.set(runId, shaped);
      activeRunId = runId;
      return { ok: true, run: runState(shaped) };
    }

    function getRun(runId) {
      const run = runs.get(runId);
      return run ? runState(run) : null;
    }

    function pauseForApproval(run, step) {
      if (!audited('run.awaiting_approval', { run_id: run.runId, step_id: step.id, tool: step.tool }).ok) return false;
      run.state = 'awaiting_approval';
      run.pendingApproval = { stepId: step.id, tool: step.tool, args: step.args };
      return true;
    }

    function pauseForStop(run, step) {
      if (!audited('run.paused_stop', { run_id: run.runId, step_id: step ? step.id : null }).ok) return false;
      run.state = 'paused_stop';
      run.pendingApproval = null;
      return true;
    }

    // Explicit resume. For an approval pause, the caller must hand in an
    // approval id that the USER's yes created; it is verified here (exact
    // tool + args through the policy engine) and only consumed immediately
    // before the step executes. For a stop pause, the stop must be inactive.
    function resume(runId, { approvalId } = {}) {
      const p = poisoned();
      if (p) return p;
      const run = runs.get(runId);
      if (!run) return { ok: false, reason: 'run_unknown' };
      if (run.state === 'awaiting_approval') {
        const step = run.plan[run.stepIndex];
        if (!run.pendingApproval || run.pendingApproval.stepId !== step.id) return { ok: false, reason: 'no_pending_step' };
        if (typeof approvalId !== 'string' || approvalId.length === 0) return { ok: false, reason: 'approval_id_required' };
        const check = engine.authorize({ tool: step.tool, args: step.args, approvalId });
        if (!check.allowed) {
          // Surface the engine's own refusal detail (why the approval was
          // rejected) instead of flattening it away.
          return { ok: false, reason: check.reason || 'approval_rejected', approvalReason: check.approvalReason };
        }
        if (!audited('run.resumed', { run_id: run.runId, step_id: step.id, via: 'approval' }).ok) {
          return { ok: false, reason: 'audit_failed' };
        }
        run.pendingApproval.approvalId = approvalId;
        run.state = 'running';
        return { ok: true, run: runState(run) };
      }
      if (run.state === 'paused_stop') {
        if (emergencyStop.isActive()) return { ok: false, reason: 'stop_active' };
        if (!audited('run.resumed', { run_id: run.runId, step_id: run.plan[run.stepIndex] ? run.plan[run.stepIndex].id : null, via: 'stop' }).ok) {
          return { ok: false, reason: 'audit_failed' };
        }
        run.state = 'running';
        return { ok: true, run: runState(run) };
      }
      return { ok: false, reason: 'run_not_paused', state: run.state };
    }

    // Drive exactly one transition: execute the next step, or surface the
    // pause/complete state. The caller keeps calling step() until the run is
    // completed or aborted. Every transition is log-before-commit: an append
    // failure leaves the state exactly as it was and the caller sees
    // audit_failed; nothing further runs on this instance.
    function step(runId) {
      const p = poisoned();
      if (p) return p;
      const run = runs.get(runId);
      if (!run) return { ok: false, reason: 'run_unknown' };
      if (run.state === 'completed' || run.state === 'aborted') return { ok: false, reason: 'run_finished', state: run.state };
      if (run.state === 'paused_stop') return { ok: true, state: 'paused_stop', stepId: run.plan[run.stepIndex] ? run.plan[run.stepIndex].id : null };
      if (run.state === 'awaiting_approval') return { ok: true, state: 'awaiting_approval', stepId: run.pendingApproval ? run.pendingApproval.stepId : null };

      if (run.stepIndex >= run.plan.length) {
        if (!finish(run, 'completed', 'run.completed', { run_id: run.runId })) return { ok: false, reason: 'audit_failed' };
        return { ok: true, state: 'completed' };
      }
      const step = run.plan[run.stepIndex];

      // The stop outranks everything, checked before every step.
      if (emergencyStop.isActive()) {
        if (!pauseForStop(run, step)) return { ok: false, reason: 'audit_failed' };
        return { ok: true, state: 'paused_stop', stepId: step.id };
      }

      // An approval-gated step pauses until the user's yes arrives through
      // resume(). It never authorizes or executes on its own.
      if (step.needsApproval && !run.pendingApproval) {
        if (!pauseForApproval(run, step)) return { ok: false, reason: 'audit_failed' };
        return { ok: true, state: 'awaiting_approval', stepId: step.id, tool: step.tool };
      }

      const approvalId = run.pendingApproval && run.pendingApproval.stepId === step.id ? run.pendingApproval.approvalId : undefined;
      const check = engine.authorize({ tool: step.tool, args: step.args, approvalId });
      if (!check.allowed) {
        // Denied authorization is never skippable: the run aborts. The
        // denial is its own audit entry, and the terminal transition is
        // always audited as run.aborted.
        if (!audited('run.step_denied', { run_id: run.runId, step_id: step.id, tool: step.tool, reason: check.reason || 'denied' }).ok) {
          return { ok: false, reason: 'audit_failed' };
        }
        if (!finish(run, 'aborted', 'run.aborted', { run_id: run.runId, step_id: step.id, summary: 'authorization_denied' })) {
          return { ok: false, reason: 'audit_failed' };
        }
        return { ok: false, state: 'aborted', stepId: step.id, reason: check.reason || 'denied' };
      }

      // Consume the approval immediately before execution, exactly once.
      if (approvalId) {
        const used = approvals.consume(approvalId, { tool: step.tool, args: step.args });
        if (!used.ok) {
          if (!audited('run.step_denied', { run_id: run.runId, step_id: step.id, tool: step.tool, reason: used.reason || 'approval_consume_failed' }).ok) {
            return { ok: false, reason: 'audit_failed' };
          }
          if (!finish(run, 'aborted', 'run.aborted', { run_id: run.runId, step_id: step.id, summary: 'approval_consume_failed' })) {
            return { ok: false, reason: 'audit_failed' };
          }
          return { ok: false, state: 'aborted', stepId: step.id, reason: used.reason || 'approval_consume_failed' };
        }
        run.pendingApproval = null;
      }

      if (!audited('run.step_started', { run_id: run.runId, step_id: step.id, tool: step.tool }).ok) {
        // The tool closure is never invoked without its step_started entry.
        return { ok: false, reason: 'audit_failed' };
      }
      const attempt = (run.attempts[step.id] || 0) + 1;
      run.attempts[step.id] = attempt;

      let observed = null;
      let threw = null;
      try {
        observed = observeResult(step.run(step.args));
      } catch (err) {
        threw = err;
        observed = { ok: false, summary: null };
      }
      // Verify: the step's own check runs after the result normalizes; a
      // throwing verify is a failed verification, not a crash.
      if (observed.ok && step.verify) {
        try {
          const v = step.verify(observed);
          if (v && typeof v === 'object' && v.ok === false) observed = { ok: false, summary: clip(v.summary, MAX_SUMMARY) || 'verify_failed' };
        } catch (err) {
          observed = { ok: false, summary: 'verify_failed' };
        }
      }
      const outcomeAction = threw || !observed.ok ? 'run.step_failed' : 'run.step_succeeded';
      const outcomeSummary = threw ? 'step_threw' : observed.summary;
      if (!audited(outcomeAction, { run_id: run.runId, step_id: step.id, attempt, summary: outcomeSummary }).ok) {
        // The result is discarded, not committed: the run does not advance
        // and nothing further runs on this instance.
        return { ok: false, reason: 'audit_failed' };
      }

      if (observed.ok) {
        run.stepIndex += 1;
        run.state = 'running';
        return { ok: true, state: 'running', stepId: step.id, result: observed };
      }

      if (attempt <= step.retries) {
        // Bounded retry. An approval-gated step that consumed its approval
        // cannot retry without a fresh one: it goes back to the approval
        // pause, never re-executes on a used approval.
        if (step.needsApproval) {
          if (!pauseForApproval(run, step)) return { ok: false, reason: 'audit_failed' };
          return { ok: true, state: 'awaiting_approval', stepId: step.id, tool: step.tool, retrying: true };
        }
        return { ok: true, state: 'running', stepId: step.id, retrying: true, result: observed };
      }

      if (step.recovery === 'skip') {
        if (!audited('run.step_skipped', { run_id: run.runId, step_id: step.id, summary: observed.summary }).ok) {
          return { ok: false, reason: 'audit_failed' };
        }
        run.stepIndex += 1;
        return { ok: true, state: 'running', stepId: step.id, skipped: true };
      }
      if (!finish(run, 'aborted', 'run.aborted', { run_id: run.runId, step_id: step.id, summary: observed.summary || 'step_failed' })) {
        return { ok: false, reason: 'audit_failed' };
      }
      return { ok: false, state: 'aborted', stepId: step.id, result: observed };
    }

    function activeRun() {
      return activeRunId ? getRun(activeRunId) : null;
    }

    return { startRun, step, resume, getRun, activeRun };
  }

  return { createOrchestrator };
});
