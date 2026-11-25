# Changelog

All notable changes to CompanionDesk. Dates are commit dates (UTC).
Format: Keep a Changelog-ish sections; version tags follow the existing
preview-tag precedent. Nothing in this file claims a capability that is
gated, disabled, or unmeasured; every line matches the roadmap evidence.

## [Unreleased]

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
