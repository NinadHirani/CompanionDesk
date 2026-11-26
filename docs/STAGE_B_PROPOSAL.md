# Stage B proposal: the first read-only tool (24 Nov 2026)

Status: **APPROVED AND IMPLEMENTED (26 Nov 2026).** Ninad approved the
decision-sheet defaults on 26 Nov 2026, including Stage B exactly as
proposed here. D-B1 (the calendar_upcoming tool) is implemented in
src/agent-tool-calendar.js with tests in tests/stage-b-calendar-tool.test.js
(15 tests, full suite 1197 green, selftest, pack and build:web green).
D-B2 option (a): the production registry stays EMPTY and main.js registers
nothing; the enable/registration step and the grant mechanism remain a
separate later review. Section 5's grant.granted / grant.revoked /
hydrate-skip audit entries are implemented in the policy engine behind an
optional audit sink (audit-first: a refused append refuses the grant);
production wiring of that sink arrives with the enable step. The tool
module requires neither src/calendar.js nor src/ics.js: the service is
dependency-injected, so the closed generator files stay untouched.

## 1. The candidate: `calendar_upcoming` (capability read_only)

The narrowest genuinely useful read-only tool is a wrapper around the
already-pure, already-tested function `calendar.upcoming(db, payload,
todayIso)` (src/calendar.js), the same function the existing
`calendar:upcoming` IPC handler calls. It lists occurrences from the user's
own imported .ics calendars for the next N days.

Why this one first:

  - Local-only by construction: it reads the app's own SQLite calendar
    store, filled only by files the user imported themselves. No network,
    no shell, no filesystem paths, no OS calls. `db` is passed in by main,
    exactly like every existing IPC handler.
  - Bounded by construction: the service already fail-closes the payload
    (`days` must be an integer 1..60, default 7) and returns a sorted,
    finite list.
  - Useful for the app's core domain: an agent run step that reads the
    user's week ("summarise my next deadlines") is the natural first
    capability of the run driver, and it needs no account, no network, and
    no consent surface beyond the calendar the user already imported.
  - Smallest possible blast radius: the worst case is reading titles and
    times the user typed into their own calendar.

Alternatives considered and rejected for first place: a grades/gradebook
read (more personal data per row for the same shape of utility) and a digest
read (duplicates an existing surface the user already sees directly).

## 2. Exact data scope and data minimization

  Input (registry schema, one field): `{ days?: integer 1..60 }`. No other
  field exists, so nothing can widen the window.

  The service's raw occurrences carry `{ uid, title, location, date, time,
  allDay }`. The tool does NOT return that shape. It returns a trimmed
  projection built inside the tool implementation, before anything is
  persisted:

  - Kept: `title` (capped at 200 chars), `date`, `time`, `allDay`.
  - Dropped, always, with no payload flag to re-add them in Stage B:
    `uid` (internal identifier, no user value) and `location` (the single
    most private field in an event: where the user will physically be).
  - Envelope: `{ ok, count, truncated, unsupportedCount, calendars }`,
    where `calendars` is the list of user-chosen calendar names.
  - Row cap: the first 100 occurrences in the service's existing sort
    order; `truncated: true` when more exist. Byte cap: if the serialized
    projection would exceed 32,768 bytes, trailing rows are dropped and
    `truncated` is set. Both numbers are proposed constants, kept in sync
    with tool-registry LIMITS, and locked by test.

  Errors fail closed: any malformed payload returns `bad_request` from the
  service and is surfaced as a step failure, never a partial result.

## 3. Threat model

  T1  Data exposure through a run. The worst case is calendar titles and
      dates entering the ledger. Mitigations: explicit per-tool user grant
      (nothing runs without it), the emergency stop blocks everything
      including read-only calls, output caps above, and the Stage A
      projection lock (D6) keeps step arguments out of renderer
      projections. Stage B adds a locked test that the step RESULT body
      never appears in the runs:get projection either: the renderer sees
      status fields only, as today.

  T2  Prompt injection via untrusted calendar content. An imported .ics can
      carry adversarial titles ("ignore previous instructions"). Stage B
      has no model-driven execution and no LLM step, so nothing consumes
      the text yet; the 200-char title cap bounds any future injection
      payload. Standing rule written into the design: any later step that
      feeds tool output to a model treats it as untrusted data, never as
      instructions, and this is re-reviewed before any such step is built.

  T3  Ledger bloat. Capped outputs above; the ledger stores the trimmed
      projection only, with the truncation marker.

  T4  Grant widening. The policy engine already refuses wildcard grants,
      capability-name grants, and anything wider than one registered tool
      at grant time. Grants are persisted and re-validated against the
      registry on every hydrate; anything stale is skipped, not repaired.

  T5  Check-then-execute race. The executor calls authorize() and then
      re-checks the emergency stop immediately before invoking the tool,
      so a stop flipped between the two checks still blocks execution.

## 4. Policy and approval requirements

  - The tool definition is capability `read_only`, `critical: false`,
    never `sensitive`, so no one-time approval is ever required for it.
    Approval mechanics for writes remain Stage C and stay blocked on D2.
  - Execution requires an explicit per-tool user grant for exactly
    `calendar_upcoming`, with a TTL or explicit expiry. No grant, no run
    step; expired or revoked grants deny at authorize() time.
  - The emergency stop overrides everything (policy check 1), grants and
    read-only included.
  - The executor is ONE main-side closure, the single caller of
    authorize() plus the tool function, mirroring the driver's
    single-caller rule: it authorizes, re-checks the stop, invokes the one
    registered function with the db handle, trims and caps the output
    BEFORE it returns to the orchestrator, and writes nothing of its own.

## 5. Audit semantics

  - Unchanged from Stage A: run.started / step_started / step_succeeded /
    step_failed are mirrored in the ledger by the orchestrator, and
    authorization denials surface as ordinary step failures the ledger
    already records.
  - Added by Stage B: `grant.granted` and `grant.revoked` as bounded audit
    entries (actor: user, detail: tool name, expiry, no arguments), and a
    single bounded system audit entry when hydrate skips stale grant rows.
    Audit happens before the state takes effect, matching the
    audit-before-transition ordering used everywhere else.
  - No new notification kinds (D5's allowlist stays completed + aborted).

## 6. Tests and CI

  - Registry accepts the definition; schema rejects every malformed
    payload (`bad_request` paths), including out-of-range `days`.
  - Projection: `uid` and `location` never present in any output; row cap
    and byte cap enforced with `truncated` markers; title cap enforced.
  - Executor denials: no_grant, grant_revoked, grant_expired, stop_active,
    invalid_args; happy path with a valid grant.
  - Driver end-to-end with the real tool in a fixture registry: plan
    completes, terminal notification fires (existing D5 tests unchanged).
  - Projection lock extended: result bodies never appear in runs:get
    output (static test, like the D6 lock).
  - The shipped build still registers nothing: the production registry
    stays empty in main.js; tests exercise the loop through fixture
    registries only. CI is the existing two workflows, full npm test.

## 7. Rollback plan

  - This document is docs-only; rollback is a revert.
  - The Stage B implementation slice, when separately approved, is one
    commit adding the tool module, executor, and tests; the registration
    line is a single constant in main. Reverting it returns the registry
    to empty, pre-validation refuses every plan (`plan_tool_unknown`),
    and nothing executes. No data migration, no ledger format change, no
    uninstall step.
  - Published releases are untouched by Stage B work: Android preview 2
    and the README direct-download link stay exactly as they are unless
    Ninad separately asks for a new build.

## 8. The concrete decisions Ninad must make before implementation

  D-B1  Approve `calendar_upcoming` as the first tool (or name a
        different one; grades-read and digest-read were considered and
        ranked second).

  D-B2  The grant-issuance path. `policyEngine.grantTool()` exists and is
        tested but has NO caller in the app. Options:
        (a) narrowest: the Stage B slice ships tool + executor + tests
            with the registry still empty, and registration plus the
            first grant happen in a tiny later slice through whatever
            mechanism is then decided;
        (b) a settings-file grant the user edits by hand;
        (c) a renderer settings channel, which is a deliberate preload
            contract amendment of the same weight as D2.
        Recommendation: (a). It keeps every shipped build fail-closed
        until both the run entry point (D1) and the grant path exist, and
        it still delivers the whole Stage B code surface for review now.

  Honest dependency note: even with the tool registered and granted, NO
  run can start until D1 (the user-initiated run entry point) is decided.
  Registration alone cannot make anything execute: the driver has no
  caller and the ledger refuses unknown kinds. Stage B's "real read-only
  runs become possible" therefore lands only when D1 lands.

  UPDATE 25 Nov 2026: D1 was decided (option a, the scheduling gate as
  the run-request source) and IMPLEMENTED (blueprint 3j.12): the run
  entry point exists and is the only caller of driver.run(), but
  requestRun has NO caller in this build and the registry stays empty,
  so nothing executes yet. Stage B review (D-B1/D-B2) remains a
  separate, unapproved gate; if approved it supplies the first lawful
  plan for the entry.
