# Next-task audit and ranked proposal (24 Nov 2026, 10:30 PM IST)

Docs-only. Prepared after D-S1 landed (commit 13a8f9a): a pass over main
and the roadmap to find the highest-priority task that is already
authorized, unblocked, and needs no new product or security decision.
Result of that pass: THERE IS NONE. Every remaining work item is gated
on one of three things: an owner decision, physical device time, or an
unapproved proposal. This doc records the audit and ranks what would
come next, with the exact dependency and the approval each needs, so
the next session can start the moment a gate opens.

## Audit: what is done and clean

M0, M1, M5 are complete as specified. M4 memory v2 is decided and wired
(slices 1-2); M6 voice has slices 1-4 landed (push-to-talk, language
wiring, STT allowlist per the STT decision); M7 has its policy slice and
observation-session machine; M8 has slices 1-3 (integrations registry,
Device Access Centre policy core, workspace-views groundwork). Gate 2
has slices 1-4, persistence wiring, notification gates, run-driver
Stage A, the scheduling gate (3j.11, D-S1), and the run entry point
(3j.12, D1 option a, 25 Nov) - implemented and NOT enabled; the
production registry stays empty and requestRun has no caller, so no
run can start. Full suite 977/977, selftest PASS, both CI workflows
green on the D1 commit.

## Ranked next tasks (each with its gate)

1. RUN ENTRY POINT (Stage A decision D1). Dependency: none but Ninad's
   choice; unblocks EVERYTHING in the agent workstream - a created
   schedule is inert until a run can start, and the Stage B proposal
   (3j.10) explicitly records "no run can start until D1 is decided".
   STATUS 25 Nov 2026: DECIDED and IMPLEMENTED. Ninad picked option (a)
   (the scheduling gate as the run-request source) and the entry point
   is implemented as blueprint 3j.12 (commit below), with D-S2 and the
   schedule_create enablement kept as separate approval gates.
   Remaining approvals on this line: D-S2 (the scheduled driver kind)
   and the schedule_create enable step, each its own gate.
   STATUS 25 Nov 2026: the D-S2 decision brief is written and committed
   (docs/D_S2_DECISION_BRIEF.md): exact behavior if the kind is added,
   the plan-source gap, the stricter fire-time origin proof D-S2 needs
   beyond D1, tests that would change, risks, three alternatives
   (defer recommended), and the exact approval wording. Docs only; no
   gate moved.

2. WAKE-WORD VERIFICATION RESEARCH (docs only; standing direction "the
   search continues"). The two undecided items in docs/M6_VOICE_DECISIONS.md
   are (a) verify the third-party training centre's actual terms and
   data handling from primary sources, or confirm the self-training
   pipeline's dataset provenance end to end, and (b) the wake phrase.
   The research half needs NO approval and no downloads: a memo with
   per-source citations either finding a verified compliant path or
   documenting the dead end. The wake phrase itself is Ninad's call.
   After both: self-train, evaluate (reproducible eval script exists),
   then physical mic validation on M1 (device time).

3. STAGE B REVIEW (D-B1/D-B2). Dependency: the proposal (3j.10) is
   review-ready; D-B1 approves the first read_only tool
   (calendar_upcoming), D-B2 picks the grant-issuance path (proposal
   recommends defer). Approval needed: Ninad's explicit review.
   Per his 24 Nov direction the run-driver work is PAUSED at the
   proposal; nothing is implemented.

4. FILE-OUTPUT GATE REVIEW (D-F1/F2/F3). Dependency: Part 2 of the
   Gate 2 proposal is docs-only and unapproved. Approval needed:
   Ninad's explicit review; nothing is implemented meanwhile.

5. ENABLE STEP FOR schedule_create. Dependency: D1 (a run path) plus
   an owner-approved registration step. Until both exist the tool
   stays unregistered and the registry empty, exactly as approved.

6. M4 SUB-DECISIONS: the on-disk format for sensitive marks (owner
   sub-decision) and a UI for the mark/persist interfaces. persistSensitive()
   stays fail-closed (sensitive_storage_blocked) until the format is
   decided; no product surface passes sensitive entries yet.

7. M7 CAPTURE ENGINE. Dependency: real OS permission flows plus device
   testing on each desktop platform. The mode policy, settings keys and
   picker already shipped fail-closed; the engine stays disabled and
   unbuilt until then.

8. M8 OWNER PICKS: which connectors (verified against official APIs
   first), the review-and-wiring of the other ten workspace view
   schemas, and floating-companion customization. All await Ninad's
   selections; the shaper refuses unwired views (view_not_wired) by
   design.

9. GATE 1 DEVICE BENCHMARKS. Dependency: physical time on the OnePlus
   12R (llama.cpp on-device POC) and the M1 (desktop gateway POC) to
   produce measured tokens/s, RAM, battery, thermals before any Android
   AI architecture is committed. Nothing has run on a device yet.

## What needs no action

Nothing is broken or stale on main: suite green, selftest PASS, both
CI workflows green. The next executable session starts at whichever
gate opens first (1, 2, or 3), in that order of unblocking value.
