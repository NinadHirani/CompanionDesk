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
- Release groundwork: this changelog, and a first-run acceptance test
  pinning the standing privacy defaults on a fresh install.

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
