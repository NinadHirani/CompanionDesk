# D-S2 decision brief: the run-driver 'scheduled' kind (25 Nov 2026)

Prepared for Ninad's D-S2 review. DOCS ONLY: no code, no test, no gate
moved. Every claim below cites the current main docs or code (main at
95164e9, both CI workflows green). Nothing here changes any behavior:
the driver allowlist stays exactly ['user'], the scheduling tool stays
unregistered, the registry stays empty, and requestRun has no caller.

## 1. What D-S2 is

The proposal's decision list (docs/GATE2_SCHEDULING_FILE_OUTPUT_PROPOSAL.md,
D-S2): "Whether the run-driver 'scheduled' kind (Stage-A decision D7) is
ever enabled, as its own later gate, after D1 (run entry point) is
decided. Recommendation: defer; nothing in this proposal needs it."
D7 itself (docs/RUN_DRIVER_DESIGN.md): goal/plan provenance wording for
the ledger kind field. Stage A implemented D7 as: the ledger records
kind; the driver allowlist contains exactly 'user'; the 'scheduled'
kind is refused until the scheduling gate itself lands (blueprint 3j.9).

## 2. What would change exactly if the kind is added

Adding 'scheduled' to the driver's KINDS array changes exactly two
things (src/agent-run-driver.js): preValidate stops refusing it
(today: kind_invalid) and ledger rows then record kind 'scheduled'
alongside run ids in agent_runs. Nothing else in the driver changes:
the same orchestrator transitions, the same registry pre-validation,
the same emergency-stop and poison rules apply to every run regardless
of kind.

The D1 entry point (src/agent-run-entry.js) independently refuses any
caller-supplied kind that is not 'user' (kind_refused) and its static
test forbids the literal 'scheduled' in the module. So approving D-S2
as a driver change ALONE changes nothing observable: the entry still
refuses, and requestRun has no caller at all. A scheduled run would
need three things to land together:

  a. the driver kind (D-S2 itself),
  b. a main-side firing path that requests a scheduled run,
  c. a source for the run's PLAN.

## 3. The plan-source gap (the load-bearing finding)

The entry point never forms plans; the plan arrives from the caller.
schedule_create is reminder-scope-only (D-S1) and its record carries
title, scope, due_at and notes - NO plan data. There is therefore
nowhere for a scheduled run's plan to come from. Approving D-S2 today
buys nothing until a plan carrier exists, and designing one means
extending the D-S1-approved schedule schema (a new field carrying
executable steps), which changes the scheduling gate's threat model
and would be its own separate gate on top of D-S2. This is the
substance behind the proposal's "defer" recommendation, and it still
holds after D1.

## 4. How it relates to the D1 origin proof

D1 proves origin with the durable audit: a request may run only if the
audit carries the scheduling gate's own schedule.create entry
(tool schedule_create, detail.schedule_id) for the named schedule,
followed by the entry's own user-intent entry BEFORE startRun.

A scheduled run needs a STRICTER proof than "the schedule exists":
  - "due and fired now": tick() sets firedAt exactly once and returns
    due records, but tick writes no audit - the module contract says
    the caller audits delivery (src/agent-scheduler.js header). A D-S2
    firing path therefore needs a NEW durable audit contract, e.g.
    action schedule.fire written by main's tick caller BEFORE the run
    request, and the entry's scheduled-origin check would require
    schedule.create + schedule.fire for the same schedule id + dueAt
    reached + not already fired/consumed.
  - "exactly once": firedAt prevents re-firing, but the run request
    must carry the firing instance (a fire token) so a replayed request
    cannot start a second run. Today nothing consumes fire events, so
    the token design is free; it does not exist yet.
  - "who ticks": the proposal fixes one firing path - the product-owned
    tick in main.js is the ONLY firing path; a created schedule can
    never wake or notify anything until the user acts (proposal lines
    78-80). Multiple tick callers are the classic duplicate-run risk
    and the design already answers it.

## 5. Safety boundaries any D-S2 implementation must keep

  - Unattended execution has no human watching the approval pause, so
    a scheduled run must never reach a step the standing-grant deny
    ladder cannot authorize alone: anything sensitive (payments,
    filesystem, network, shell) is denied and the run aborts fail-closed,
    as today. The per-step interactive approval stays a user-kind-only
    affordance.
  - Reminder scope only (D-S1 unchanged): a scope change is a different
    commitment and stays its own gate.
  - Quiet hours and per-scope pause keep deferring fires (tick already
    implements both); a deferred fire is not a fire.
  - Emergency stop, the poison rule and the 3j.9 restart
    reconciliation (interrupted runs marked aborted, never auto-resumed)
    apply unchanged to scheduled runs.
  - Even after D-S2, the registry is empty, so no scheduled run could
    execute: the first lawful plan needs Stage B's first registered
    read-only tool (D-B1). D-S2 alone is inert.

## 6. What tests would change

Re-pins that flip if D-S2 is approved: the driver test that refuses
kind 'scheduled' (kind_invalid) becomes an accepted-path test; the
entry's kind_refused test for 'scheduled'/'agent'; the KINDS
deep-equal ['user'] assertions in tests/gate2-run-entry.test.js and
tests/gate2-run-driver.test.js; the scheduling-gate test header
comment; the entry module's static guard that forbids the literal
'scheduled' in code. The wiring lock and the D1 origin/intent tests
stay as they are. NEW tests a D-S2 slice owes: schedule.fire audit
contract, fire-token replay refusal, not-yet-due refusal,
already-fired refusal, quiet-hours deferral, and the unattended
sensitive-step refusal.

## 7. Risks

  - Replay/duplicate runs if the fire token or the one-firing-path rule
    is weak (bounded by section 4's design).
  - Unattended execution executing more than the user pictured (bounded
    by the deny ladder + empty registry + Stage B ordering).
  - Plan carriers that widen the schedule schema reopen D-S1's threat
    model (kept out by section 3's gate layering).
  - Audit-chain growth per scheduled run (bounded; the same shape as
    today's user runs).

## 8. Alternatives

  1. DEFER (the proposal's recommendation, and mine): decide D-S2
     together with the Stage B review (D-B1/D-B2), so the kind, the
     plan carrier and the first read-only tool are designed as one
     reviewed surface instead of three half-pieces.
  2. APPROVE AS INERT PLUMBING: add the driver kind and a
     scheduled-origin entry function with the schedule.fire + fire-token
     proof, still with no caller and no plan carrier - small, fully
     testable, zero behavior change, but the plan-carrier question
     stays open and its eventual design is the real gate.
  3. NEVER: scheduling stays reminder-only forever and every run stays
     explicitly user-initiated through the D1 entry; the model stays
     simplest and nothing in the current roadmap needs more.

## 9. The exact approval needed

One decision from Ninad: DEFER (recommended), approve-as-inert-plumbing,
or never. Approving D-S2 explicitly does NOT approve: schedule_create
registration/enablement (separate gate, standing rule), the schedule
schema plan carrier (its own future gate), Stage B (D-B1/D-B2), the
file-output gate (D-F1/F2/F3), or any other gated item. If DEFER: the
brief stays on file and D-S2 is revisited with the Stage B review.
