# Changelog

All notable changes to CompanionDesk. Dates are commit dates (UTC).
Format: Keep a Changelog-ish sections; version tags follow the existing
preview-tag precedent. Nothing in this file claims a capability that is
gated, disabled, or unmeasured; every line matches the roadmap evidence.

## [Unreleased]

### Added - Gate 2 3j.9 Stage C: per-call approval delivery (28 Nov 2026)

- Decision D2 resolved as the out-of-renderer surface: a run parked at
  awaiting_approval raises a native main-side dialog. Approve issues the
  exact one-run approval and resumes through the driver; deny,
  dismissal, or any dialog failure parks the run (D3). No renderer
  channel was added and the preload contract is untouched; step
  arguments never leave main (D6). A sensitive step still needs its
  per-tool standing grant first; approve without one fails closed.
- New src/approval-dialog.js (pure prompt builder + approval surface,
  bounded copy, fail-closed at every branch) and an optional
  fire-and-forget onAwaitingApproval hook on the run driver whose
  failure never changes a run outcome. Wired in main; nothing starts a
  run in this build (D1/D-S2 stand).

### 28 November 2026
- M9 defined by Ninad in chat: the coordinated-release brief
  (docs/M9_RELEASE_BRIEF.md) is adopted as the phase definition - one
  versioned, installable macOS build of the landed M0-M5 and Gate 2 slices
  plus the release engineering around it, no new product capability. The
  governing definition lives in docs/IMPLEMENTATION_ROADMAP.md; signing
  spend, public distribution and any auto-update feed stay Ninad's
  explicit decisions, and no release exists yet.
- Gate 2 file-output enable (approved by Ninad on 28 Nov 2026): the
  file_write tool is registered as the fourth production tool, mirroring
  the schedule_create enable step. Every call runs the pure policy core
  first: one text file into one user-configured root directory (strict
  basename, .ics/.txt/.md only), text only at most 64 KiB,
  refuse-if-exists (overwrite is out of scope), a symlink escape guard,
  and an atomic write (temp file + rename in the same directory, mode
  0o600, no execute bit) through the real fs-backed io adapter. The
  sensitive class demands a fresh one-time approval digest-bound to the
  exact name and content for every call - a standing grant can never
  authorize a write. The root is read only main-side from the
  file_output_root setting and stays UNSET by default, so every call is
  refused (file_output_root_unconfigured) until the owner configures a
  folder on a product surface; the renderer and the model can never set
  or widen it. Found and fixed in the same slice: the registration block
  read agentRegistry before assigning it, so the first boot threw inside
  buildAgent and the agent runtime stayed blocked; the assignment now
  precedes the defines (pinned by the enable test).
- Connector registry defect fixed (decision-sheet item 9, resolved under
  Ninad's standing authorization of 28 Nov 2026): the connector_status
  definition now registers on the strict registry (capability
  reversible_write, description within the 400-character limit, the
  object-typed params field validated inside the tool); the runtime
  registry carries it as the third tool with its own consent gates
  unchanged (write/send still come back approval_required).
- Gate 2 run-driver Stage B enable (same authorization): calendar_upcoming
  is registered as the fifth tool, a read-only projection of the
  user-imported local calendars (uid/location dropped, 200-character
  titles, 100 rows, 32 KiB envelope); the calendar service arrives by
  dependency injection at the plan-forming site and the closed ICS
  generator files stay untouched. Registration alone starts no run:
  requestRun still has no caller.
- File-output root config surface (same authorization):
  src/file-output-config.js (pure validation/store policy: absolute
  paths only, trimmed, at most 512 characters, no control characters;
  empty clears back to the unset default) plus a dedicated Workspace
  panel control wired through two new IPC channels; setting or clearing
  rebuilds the file-output tool instance without a restart. The renderer
  and the model can never set the root on their own; settings.js and the
  row-store categories stay untouched.
- In-place credential update: a connected connector's stored key can be
  replaced without disconnecting (two explicit clicks; the secret never
  renders, logs or persists anywhere but the OS vault; refusals surface
  verbatim).
- Flagged for an owner decision (connector band, untouched): the connector
  tool definition's registry define() returns ok:false against the strict
  registry (bad_description, bad_capability, bad_field_type:params), so
  the connector status/request tool never actually joined the production
  registry; the guardrail tests still pass because they count source
  literals. Fixing the definition is connector-band work awaiting Ninad's
  go-ahead (docs/NEXT_DECISIONS.md item 9).

### 26 November 2026
- Gate 2 run-driver Stage B: the first read-only tool, calendar_upcoming
  (blueprint 3j.10, approved by Ninad on 26 Nov 2026). A bounded projection
  of the local calendars the user imported, built by dependency injection
  (the tool module requires neither src/calendar.js nor src/ics.js), with
  uid and location dropped always, titles capped at 200 characters, rows
  capped at 100 in the service's own order, and a 32768-byte envelope cap
  that drops trailing rows. The step result body never reaches run state or
  the renderer projection. Grant, revocation and hydrate-skip entries now
  land in the audit before they take effect; a refused append refuses the
  grant (fail closed). Nothing is registered: D-B2 option (a) keeps the
  production registry empty, and the enable step stays a separate review.
  Suite 1197/1197 green, selftest, pack and the web bundle green.
- Decision sheet resolved: Ninad approved the remaining defaults on
  26 Nov 2026 (schedule_create enable with guardrails, file-output
  D-F1/F2/F3 root unset by default, M8 schemas-first, M4 sensitive sidecar
  markings with session-only sensitive content, M6 OS-native TTS only) and
  explicitly deferred M7 (capture engine) and M9 (release readiness).

### 25 November 2026
- Gate 2 scheduling: run entry point implemented (blueprint 3j.12) as the
  single lawful consumer of the scheduling gate's audit record; nothing
  fires (the run-driver kind stays 'user' only, D-S2 decided DEFER, and
  the scheduling tool stays unregistered).
- D-S2 decision recorded: DEFER; the scheduled kind stays out of the
  driver allowlist and the decision brief stays on file for the Stage B
  review.
- First-run polish: the privacy step shows a short heading with its
  explanation below it; choice questions now honor arrow keys and their
  roving focus, question changes are announced to screen readers, and
  "Skip the rest" needs a confirming second click (it ends the interview
  for good).
- Screen capture hardening: a window whose title is missing or blank can
  no longer be captured (error title_unavailable). The picker already
  refused to list untitled windows; the capture path now refuses them
  too, before any pixels are requested and again if the title goes
  blank between the title check and the pixel step, since an
  unverifiable title cannot be checked against the private-title
  rules.
- Screen-mode policy fixes: background cadence config is now defined only
  for background mode (it previously answered session-mode callers with
  the 30 s background floor), and its exclusions are validated like the
  observation module's (typed, non-empty, length- and count-capped,
  normalized for matching) instead of accepted as any array.
- Device Access Centre hardening: an explicit enable is now reversible
  (disable requires a user action and revokes that capability's grants
  first), grant scopes are validated as typed, non-empty, length- and
  count-capped strings, the audit log is bounded in memory, and the
  app-count bound no longer refuses a re-grant to an app already on the
  books.
- Proactive scheduler fixes: editing a schedule's due time now clears the
  stale quiet-hours deferral (a moved due no longer fires at the old
  deferred moment), and a failed audit append or save now rolls back
  pause/resume/cancel and edits to the exact last durable state instead
  of leaving a phantom in memory; the schedule book's update rollback
  test shared the wrong clock and is fixed.
- Release groundwork: this changelog, a first-run acceptance test
  pinning the standing privacy defaults on a fresh install, the first-run
  privacy explainer step, and a release-metadata preflight
  (scripts/release-check.js, wired into the test suite CI runs on every
  push) that validates the package.json / changelog / tag-convention
  consistency. It reads files only; it builds, signs, and publishes
  nothing.

### 24 November 2026
- M4 memory v2: the owner resolved all four open decisions; measured
  ranker wired into the persona/chat path (budgets chat 12 / screen 6 /
  goal 8 / vision 0; screen-derived asks retrieve zero memory); the v2
  store contract wired as the in-session memory view. Sensitive entries
  stay session-only and fail closed (no on-disk format yet).
- M6 voice: push-to-talk session machine (voice off until enabled, no
  audio retention, cancellable), transcription language wiring against
  the verified whisper.cpp language table, OS-native speech output
  groundwork (off until enabled, nothing speaks on its own), and the
  wake-word subsystem with its training pipeline. Wake stays disabled
  by default; no model trained, downloaded, or activated.
- M7 screen understanding: mode policy (manual default; background needs
  its own explicit consent and is desktop-only) and the observation
  session machine. No capture engine; nothing captures.
- M8: integrations registry (ships empty, least-privilege scopes),
  Device Access Centre policy core (nothing granted by default, no
  wildcards, no unrestricted access), and workspace-views groundwork
  (conversations view wired; every other view refuses until its schema
  is reviewed).
- M1 review fix: stricter errno allowlist and status normalization in
  provider fault classification.

### 23 November 2026
- M0 product foundation: model selection (separate local/vision pickers,
  installed-models-only, safe fallback), conversation history
  (device-only, last ten turns), Gemini key in the OS credential vault
  (fail-closed, cloud off by default with per-request consent).
- M1 intelligence core: deterministic task router, provider health
  snapshot, typed provider faults, per-ask routing with live local
  probes.

## [v0.1.0-android-preview.2] - 2026-11-24

Second Android preview tag on the distribution build path. No device
measurements yet (Gate 1 benchmarks need physical OnePlus 12R time).

## [v0.1.0-android-preview.1] - 2026-11-22

First Android preview tag; repository-only benchmark scaffold, no
on-device results claimed.

[v0.1.0-android-preview.2]: https://github.com/NinadHirani/CompanionDesk/releases/tag/v0.1.0-android-preview.2
[v0.1.0-android-preview.1]: https://github.com/NinadHirani/CompanionDesk/releases/tag/v0.1.0-android-preview.1
