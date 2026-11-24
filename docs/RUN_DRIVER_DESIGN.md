# CompanionDesk run driver design proposal

Status: DESIGN ONLY (24 Nov 2026, blueprint 3j.8). Nothing here is
implemented, enabled or wired. No code changes accompany this document.
This proposal exists because blueprint 3j.7 verified that the running app
has no agent event source: every downstream piece exists (orchestrator,
emergency stop, persistence run ledger, notification desk, display
delivery, panel), but nothing ever drives a run, so no terminal outcome
is ever emitted. This document proposes the smallest safe main-owned run
driver, lists the open product decisions explicitly, and stages the work
so that NO execution capability is enabled without a separate explicit
approval checkpoint.

## 1. What already exists (verified, no new building)

  - src/agent-orchestrator.js: a bounded, declarative run loop over a
    pre-declared plan. No free-form loop, no model call, no I/O. States:
    running, awaiting_approval, paused_stop, completed (terminal),
    aborted (terminal). Log-before-commit on EVERY transition; any audit
    append failure poisons the instance (audit_failed forever until a
    restart replaces it). Plans carry executor closures, so a plan can
    only be formed by code in the main process, never by renderer data.
  - src/agent-persistence.js: the agent_runs ledger (run_id UNIQUE, kind,
    status in running/succeeded/failed/aborted, started_at, ended_at,
    summary <= 300) with startRun/finishRun, currently UNWIRED (zero
    callers). durableAudit() is the injection point: the orchestrator
    never sees the raw audit log; audit appends are durable-before-state
    by the persistence layer's own ordering.
  - src/emergency-stop.js: one global stop; while active EVERY tool
    authorization is refused (read-only included). activate(why, by) with
    actor user/agent/system; reset requires by === 'user'; state persists
    and hydrates (an active stop comes back active; a restart never
    resets it).
  - src/policy-engine.js: deny-by-default, the only door to tool
    execution. Order: stop active -> unknown tool -> forbidden capability
    -> malformed args (before any grant) -> no grant -> revoked/expired ->
    sensitive/critical requires a valid one-time approval bound to the
    exact argument set. Grants are per exact registered tool; wildcards
    are refused at grant time and can never exist.
  - src/tool-registry.js: capability classes read_only, reversible_write,
    sensitive, forbidden; typed schemas (max 16 fields, strings <= 500).
  - src/approval.js: 64-hex ids from secure randomness, TTL <= 15 min,
    tool + args digest bound, consume-once immediately before execution,
    hydrate invalidates outstanding approvals.
  - src/agent-surface.js + src/preload.js: the renderer sees exactly six
    reads plus the id-only notifications:ack. The contract comment states
    no main-only channel (run start/step/resume/abort, approvals, grants,
    stop, persistence) may EVER be added to the renderer allowlist.
  - 3j.6 display delivery and 3j.5 acknowledgement: unchanged by this
    design; the driver only creates desk records at terminal transitions.

## 2. The driver's role and non-role

The driver is PLUMBING, not a capability. It does exactly four things:
  1. Accept a fully-formed plan (already validated by main-side code) and
     call orchestrator.startRun.
  2. Drive step() in a single synchronous pass until the run reaches a
     terminal state or a pause.
  3. Mirror transitions into the persistence run ledger and durability
     checkpoints, in the ordering of section 6.
  4. Create allowlisted notifications at terminal transitions (section 8)
     and feed them into the existing 3j.6 reconciliation.

The driver NEVER: executes a tool itself, forms or rewrites plans,
creates approvals or grants, resumes runs on its own, schedules or timers
anything, touches the network, reads secrets, or exposes any new renderer
surface. Every step still passes through the policy engine unchanged; the
driver cannot bypass it because the driver never calls tool closures
directly, only orchestrator.step().

## 3. Lifecycle and state machine (exact, from the orchestrator)

States: RUNNING, AWAITING_APPROVAL, PAUSED_STOP, COMPLETED (terminal),
ABORTED (terminal).

Allowed transitions (every one audited log-before-commit; an audit
failure leaves state untouched and poisons the instance):

  (none)        -> RUNNING              startRun: validated plan (<= 64
                                           steps, each one registered
                                           tool + plain-data args + run
                                           closure), no active run, stop
                                           inactive. run.started first.
  RUNNING       -> RUNNING              step succeeded (advance), bounded
                                           retry (attempts <= retries <= 3),
                                           or recovery 'skip'.
  RUNNING       -> AWAITING_APPROVAL    step.needsApproval pauses BEFORE
                                           authorization. run.awaiting_approval.
  RUNNING       -> PAUSED_STOP          emergency stop active before a step.
                                           run.paused_stop.
  AWAITING_APPROVAL -> RUNNING          resume(runId, {approvalId}): the
                                           id must be a pending, unexpired
                                           approval whose digest matches the
                                           exact tool + args (policy
                                           authorize re-checks); run.resumed.
                                           The approval is CONSUMED once,
                                           immediately before execution.
  PAUSED_STOP   -> RUNNING              resume; refused while the stop is
                                           active (stop must be inactive).
  RUNNING       -> COMPLETED            stepIndex >= plan.length. run.completed.
  RUNNING       -> ABORTED              authorization denied (never
                                           skippable), approval consume
                                           failed, or retries exhausted with
                                           recovery 'abort'. run.aborted.

Driver pass semantics: one synchronous main-process pass = startRun, then
step() repeatedly until terminal or pause. A retrying step re-executes
within the same pass (bounded by MAX_RETRIES). A pause ENDS the pass; the
next pass happens only when the user acts (an approval yes, or a stop
reset). There are NO timers, NO polling, NO auto-resume: a paused run
stays paused indefinitely and expiry is enforced by the approval desk at
resume time, not by a timer.

## 4. Who can request a run, and how user intent is represented

Hard architectural facts (not choices): the renderer may never receive a
run-control channel (preload contract); model-driven execution is
forbidden as a standing user constraint; the driver never plans. So a run
request must be born main-side, and the user's intent must be an
explicit, auditable, per-run yes that exists BEFORE startRun.

Proposed representation: a run request is a plan plus an explicit user
authorization recorded in the durable audit log BEFORE the run starts
(actor 'user'). The orchestrator's own run.started entry (actor 'agent')
then references it. No run starts without a prior user-intent entry.

Which main-side source may CREATE that user-intent entry is OPEN
(decision D1). The candidates, smallest first:
  a. The future scheduling gate: a run is created only from a task the
     user explicitly scheduled, the schedule itself being the recorded
     intent. No new renderer channel; intent is durable and auditable.
  b. A plan-level approval record on the existing approval desk (a new
     planApproval kind beside tool approvals), created by a user gesture
     through a surface that does not yet exist.
  c. A local developer-only entry point (CLI/flag), explicitly
     temporary, never a product path.
Nothing in this design permits the renderer, a model, or the driver to
request a run.

## 5. Main-process validation and renderer boundary

  - Plan formation is main-side code only; plans are validated by the
    orchestrator (planIssue) AND, new in the driver, against the registry
    BEFORE startRun: every step's tool must be registered, its args must
    validate against the tool's schema, and no step may reference a
    forbidden-capability tool. A plan that fails pre-validation never
    reaches startRun; nothing partially executes.
  - Run ids are driver-generated (format run-<utc-compact>-<6 hex>,
    matching RUN_ID_RE); renderer-supplied ids are never used because the
    renderer supplies nothing.
  - The renderer boundary is unchanged: six reads plus notifications:ack.
    Run state reaches the renderer only through the existing runs:get
    projection (bounded by projectRun). The driver adds no channel, no
    handler, no preload entry.
  - Existing exposure to review at Stage C (flagged, not new):
    runState() includes the pending step's tool AND args in the runs:get
    projection; whether projected args should be redacted is decision D6.

## 6. Durable audit-before-transition and persistence ordering

Per transition, in this exact order:
  1. orchestrator transition: audit entry accepted (durableAudit, the
     persistence layer's durable-before-state ordering) BEFORE the
     in-memory state moves. An append failure poisons the orchestrator;
     nothing further executes on the instance. This is existing,
     unchanged behavior.
  2. run ledger mirror: startRun inserts the agent_runs row AFTER
     orchestrator.startRun succeeded; finishRun updates the row AFTER the
     orchestrator's terminal transition. A ledger failure (persist,
     duplicate id, run_not_running) is logged (bounded) and NEVER changes
     run state or outcome: the ledger is bookkeeping, not authorization.
  3. durability checkpoint: persistence.save() after every PAUSE
     (awaiting_approval, paused_stop) and every TERMINAL transition, not
     after every step (bounded write frequency). A save failure is
     logged and never aborts a run; the saver is fail-closed (the
     previous on-disk state stays byte-for-byte intact), and the next
     checkpoint retries the whole snapshot. The before-quit save remains
     the last line.

Terminal mapping: orchestrator completed -> ledger 'succeeded';
orchestrator aborted -> ledger 'aborted'. The ledger's 'failed' state
stays reserved and unused by this design.

## 7. Stop/cancel semantics and race handling

  - The stop outranks everything and is checked before every step
    (existing). A paused_stop run resumes only through an explicit
    resume after a user reset (reset_requires_user; a restart never
    resets it, because the stop state hydrates).
  - Race bound, documented and accepted: if the stop activates while a
    step's closure is executing, that closure runs to completion and its
    outcome is audited normally; the NEXT step() call pauses. The driver
    does not preempt a running closure. The stop's worst-case latency is
    therefore exactly one in-flight step; no unbounded work can start
    after the stop, because the pre-step check refuses everything.
  - The same one-step bound applies between approval consume and closure
    start (consume happens immediately before execution).
  - Approval expiry versus a long-paused run: enforced at resume time by
    the approval desk (approval_expired); no timer, no wake-up. The user
    simply approves again.
  - Cancel of a PAUSED run: the orchestrator has no cancel. Proposing to
    leave paused runs parked (they hold only the single active-run slot)
    is decision D3; a driver-level audited abandon path would be new
    code and is NOT proposed by default.

## 8. Notifications at terminal transitions (the 3j.7 payoff)

  - Allowlist: exactly two events create notifications: run COMPLETED and
    run ABORTED. No notification for step events, retries, skips, pauses,
    polls, rendering, focus, or visibility. (Whether a stop-pause
    deserves one is decision D5.)
  - Creation happens ONLY when persistence.finishRun returned ok (first
    transition of that run_id); finishRun refuses a replay with
    run_not_running, which is the primary dedupe. A secondary desk-scan
    fallback (same style as 3j.6) guards restart replay.
  - Content: generic allowlisted title and body per event ("Agent run
    completed." / "Agent run was stopped.") plus the sanitized run id
    (RUN_ID_RE already bounds it). No goal text, no step names, no tool
    names, no args, no summaries, no errors, no secrets.
  - Failures: a notification-creation or delivery failure is logged
    (bounded) and has ZERO effect on the run outcome, the audit order,
    or persistence. Successful creations feed the existing
    runDisplayDelivery() path. Acknowledgement policy (3j.5) and display
    store semantics (3j.3/3j.6) are untouched.

## 9. Restart and recovery (never auto-resume)

  - The orchestrator has no persistence surface and is replaced wholesale
    by a restart; nothing resumes, ever. This is existing behavior and a
    standing constraint.
  - Ledger rows still 'running' at startup are artifacts of a crash or
    quit mid-run. Proposed reconciliation (decision D4): mark them
    'aborted' with ended_at and summary 'interrupted_by_restart', plus
    ONE bounded system audit entry (run.interrupted), and NO notification
    (an interrupted run never reached a real terminal outcome). The
    alternative (leave rows 'running' forever) is listed for decision.
  - An active emergency stop hydrates active; paused runs do not exist
    after a restart (in-memory only), so a post-restart stop can only be
    cleared by the user, and no plan can be mid-flight.

## 10. Bounded inputs/outputs, redaction, prompt-injection treatment

  - Inputs: plan <= 64 steps, step id <= 64 chars, tool name <= 128, args
    plain data validated against typed schemas (max 16 fields, strings
    <= 500), goal <= 200 chars, run id <= 64. All existing orchestrator
    and registry bounds, applied before startRun.
  - Outputs: step results normalize to { ok, summary <= 200 } or fail
    closed (observeResult); audit detail is the sanitizer's allowlisted
    typed schema (<= 8 keys, strings <= 200); ledger summary <= 300;
    notification bodies are fixed generic strings plus a sanitized run
    id. Nothing unbounded can leave the run.
  - Redaction: the driver never places goal text, tool names, args,
    summaries or error text into notifications. Goal text appears only in
    the audit entry and ledger row, both bounded by the sanitizer.
  - Prompt injection: goal and summary strings are treated as data only.
    They are never parsed, never executed, never rendered as
    instructions, and never echoed into notification copy. The existing
    injection corpus (tests/gate2-injection-corpus) keeps gating any
    grant widening; the driver adds no new natural-language surface.
  - Secrets: the driver holds no secret-store reference, reads no
    credentials, and its code will carry a static test asserting no
    secureStore/keychain/network/child_process references.

## 11. Threat model and abuse cases

  Threat                                 | Existing or proposed control
  ---------------------------------------|-----------------------------------
  Malicious or manipulated plan          | Plans are main-side code only;
                                         | per-run user intent audited before
                                         | start; policy denies ungranted and
                                         | forbidden tools per step.
  Model-driven execution creeping in     | The driver never calls a model and
                                         | never forms plans; a static test
                                         | asserts no model/provider imports.
  Grant creep / wildcard grants          | Refused at grant time by the
                                         | policy engine (existing); the
                                         | driver never grants.
  Injection via goal/summary strings     | Bounded, data-only, never echoed
                                         | into notifications (section 10).
  DoS via giant plans or retries         | MAX_STEPS 64, retries <= 3,
                                         | synchronous bounded pass.
  Audit tampering / unverified trail     | Hash-chained audit; append failure
                                         | poisons the orchestrator
                                         | (existing).
  Notification flooding                  | Terminal-only allowlist + ledger
                                         | dedupe (section 8).
  Renderer overreach                     | No new channel; the existing
                                         | six-reads-plus-ack contract is
                                         | asserted unchanged by tests.
  Stop race                              | One in-flight step bound,
                                         | documented (section 7).
  Secret leakage                         | Driver never touches the secret
                                         | store; static scan.
  Crash mid-run                          | Never auto-resumed; ledger
                                         | reconciliation per D4; failed save
                                         | leaves prior state intact.

## 12. Fail-closed matrix

  Condition                        | Driver behavior
  ---------------------------------|------------------------------------
  Plan fails pre-validation        | Refused before startRun; nothing runs.
  Audit append refused/throws      | Orchestrator poisoned; run frozen in
                                   | prior state; caller sees audit_failed.
  Ledger insert/update fails       | Logged; run continues; no state change.
  save() fails                     | Logged; run continues; prior on-disk
                                   | state intact (fail-closed saver).
  Policy denies a step             | Run aborts; denial audited (existing).
  Approval missing/expired/mismatched | Step stays paused; resume refused.
  Emergency stop active            | Every authorization refused; runs
                                   | pause; resume needs a user reset.
  Notification creation fails      | Logged; run outcome unaffected.
  Unknown run id / replayed finish | Refused; no notification (dedupe).

## 13. Tests and CI/device verification plan

  - Unit (node:test, the existing pattern): the full transition table of
    section 3 driven through a fixture registry with no-op closures;
    pre-validation refusals (unregistered tool, forbidden capability,
    oversized plan/args); stop race (activate between steps and during a
    closure); approval expiry and digest mismatch; ledger ordering and
    replay idempotence; save-failure non-interference; restart
    reconciliation (D4); notification allowlist, dedupe, content bounds
    and no-effect-on-outcome; poison behavior.
  - Static guards: no timers, no renderer channels, no model or provider
    imports, no secret-store references, no network, no child_process in
    the driver; preload allowlist unchanged; panel unchanged.
  - Full suite + selftest, then CI (394133195), CI (macOS + Linux)
    (426611659), Android APK dispatched by workflow id (426707674);
    exact run ids recorded in the blueprint per slice, as in 3j.5/3j.6.
  - Device verification: Stage A needs no device behavior (no production
    tools registered); Stage B is verifiable on-device only through a
    real read-only tool and the panel's existing reads; no on-device
    execution claim is made before its gate.

## 14. Staged implementation gates (each ends with an explicit approval checkpoint)

  Stage 0 (this document): design reviewed and decided by Ninad. Nothing
    enabled.
  Stage A: driver module + wiring, EMPTY production registry (zero tools
    registered in the app build), ledger mirroring, restart
    reconciliation, terminal notifications. With no registered tools,
    every plan fails pre-validation, so NO step can ever execute in the
    shipped app; tests exercise the loop through fixture registries only.
    Checkpoint: Ninad reviews and approves before Stage B.
  Stage B: the FIRST real read_only tool registered, plus explicit
    per-tool user grants. Real read-only runs become possible; terminal
    notifications go live for real. Checkpoint: review before Stage C.
  Stage C: the first reversible_write tool with per-call approvals.
    BLOCKED on decision D2 (how the user's approval yes reaches main);
    Stage C does not start until D2 is decided.
  Must remain disabled at EVERY stage: shell/filesystem/browser/OS
  unrestricted tools, capability 'sensitive' tools, model-driven
  execution, auto-resume, driver timers or scheduling, network egress
  from the driver, file output, any renderer run-control or approval
  channel, any widening of the 3j.5 acknowledgement semantics.

## 15. Open decisions for Ninad (nothing here is decided)

  D1  Run request source: (a) future scheduling gate (recommended as the
      smallest safe path), (b) plan-level approval records, (c) temporary
      developer-only entry point. Who forms plans in (b)/(c) is part of
      the same decision.
  D2  Approval delivery: the preload contract forbids adding approvals
      (and all run-control) channels to the renderer allowlist, and 3j.5
      forbids broadening notifications:ack. Stage C therefore has no
      lawful approval path until a deliberate contract change is decided.
      Options: a one-time explicit contract amendment adding ONE narrow
      approvals channel, or an out-of-renderer surface. This decision
      blocks Stage C only.
  D3  Paused-run lifecycle: park indefinitely (proposed default) or add
      an audited abandon path.
  D4  Ledger restart reconciliation: mark running rows aborted with a
      system audit entry (proposed), or leave them.
  D5  Notification allowlist breadth: completed + aborted only
      (proposed), or also stop-pauses.
  D6  Runs:get projection: keep including pending-approval args
      (existing) or redact args from projections at Stage C.
  D7  Goal/plan provenance wording for the ledger 'kind' field once D1
      lands.
