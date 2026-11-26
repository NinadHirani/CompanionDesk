# CompanionDesk next decisions sheet

Prepared by Fo, 26 Nov 2026 evening (docs-only, no code changed). The morning
decision sheet is fully executed: items 1, 2, 3, 5, 6 and 7 landed and are
CI-verified (run-driver Stage B, the schedule_create enable, the file-output
gate, M8 slice 4 schemas, the M4 sidecar, the M6 TTS decision); items 4 (M7
capture engine) and 8 (M9 release readiness) were deferred by Ninad.

Every remaining roadmap item is gated on one decision below or on the
physical device pass, with one exception: item 7 (the sensitive-memory UI)
is RESOLVED as of 26 Nov 2026 evening, commit `a0e69fc` -- Ninad reopened
the M2/M4 UI paths for that scoped slice and the memory panel landed.
Reply in chat with item numbers and choices; each approved item is
implemented red-first with targeted tests, the full suite plus selftest,
commit/push and exact-head CI verification, exactly as the morning sheet's
items were.

## 1. Physical device pass (no decision needed, only the pass)

docs/DEVICE_VALIDATION_CHECKLIST.md is ready and linked from the README.
Status: STILL PENDING as of 26 Nov 2026, 4:14 PM IST. Nothing in the repo,
CI, or build environment blocks it; the only missing input is the pass itself
(about 30-60 minutes on the MacBook Air M1 and OnePlus 12R, results back to
Fo). It unlocks device-verified claims, doubles as Gate 1 benchmarking
groundwork (`npm run test:benchmark` in the same session), and feeds M9
later.

## 2. M8 connectors -- RESOLVED (26 Nov 2026 evening)

Ninad approved (22:10 IST): build the Connector Settings/catalog with
free-first worldwide discovery and extensible integrations, and the
settings to manage connections. Prioritize free/open-source/free-tier/
self-hostable; surface paid requirements, costs and limits BEFORE
activation; secure credential storage (opaque references only); explicit
per-connector permission scopes; the full connection lifecycle
(connect/disconnect/reconnect/revoke/test); local-first where possible;
approval gates for sensitive/write/send/delete/external actions; NO
blanket auto-connect and NO connector or permission granted without his
explicit choice. Architecture is connector-ready and the catalog is
broad, but nothing is activated automatically. Implemented 26 Nov 2026
evening as src/connectors.js (pure policy core, 12 red-first tests,
AUTO_CONNECT false, unregistered in main.js, nothing connected).
Connecting a real service still needs a named service and an explicit
per-connector activation by Ninad.

## 3. Workspace renderer UI for the six wired views

The schemas are landed; no renderer surface shows them yet. Building the UI
touches overlay.js, main.js and index.html, which sit in the m84 closed set,
so this needs you to reopen those files for this specific work. Decision:
(a) approve the UI build with the m84 files reopened for it, or (b) keep
the views schema-only.

## 4. file_write registration (Gate 2)

The file-output gate (3j.13, D-F1/F2/F3) is implemented and tested but NOT
registered or wired; the production registry carries exactly one tool,
schedule_create. Decision: (a) register file_write with the root unset by
default (the enable step, mirroring the schedule_create approval), or
(b) keep it unregistered.

## 5. M7 capture engine (deferred item 4)

Decision: (a) green-light now (it brings the real permission flows and
device-testing needs with it), or (b) keep deferred.

## 6. M9 release readiness (deferred item 8)

A docs-only proposal exists (docs/M9_RELEASE_BRIEF.md); it is not a
definition. Decision: (a) define the phase now (say what M9 must contain),
or (b) keep deferred.

## 7. Sensitive-memory UI -- RESOLVED (26 Nov 2026 evening)

Done, not open: Ninad reopened the M2/M4 UI paths for this scoped slice and
the memory panel landed at `a0e69fc`: explicit mark/unmark with visible
status lines, session-only/nonpersistent labels from `persisted()`
provenance, the fail-closed persistSensitive refusal surfaced verbatim, and
consent-gated retrieval with the budget and matched-terms header. No
on-disk sensitive format was created and none is proposed.

## 8. Workspace row stores for files, workflows, models

Those three views have no owning row store yet, so they cannot be wired;
building the stores is new subsystem design (what each view should hold).
Decision: (a) pick what each should show and approve the build, or (b)
leave them unwired.

Not on this sheet: the wake-word lane stays closed per the owner's standing
closure; reopening it is always the owner's call and no question about it is
asked here.
