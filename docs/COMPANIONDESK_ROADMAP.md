# CompanionDesk Roadmap (general-purpose desktop companion)

Updated Nov 27, 2026 (status refresh). Direction set Oct 28, 2026: CompanionDesk is a
**general-purpose, local-first desktop AI companion** inspired by the
companion functionality in potlakai/nus-desktop (floating companion/Knot,
voice, screen awareness, point-at-element guidance, reusable step workflows,
memory, safe computer assistance). CompanionDesk is NOT a NUS-for-students
product: student features are one optional skill/module, never the core
identity. Not to be confused with the original potlakai/nus student prompt
project.

The forward plan now lives in docs/IMPLEMENTATION_ROADMAP.md (gated phases
M0-M8) with the vision in docs/PRODUCT_BLUEPRINT.md. This file records the
original direction, the standing constraints, and the completed-work
history, kept consistent with those documents.

Standing constraints (updated Nov 27, 2026): local-first and free-first; no
billing/Supabase/Stripe; no required cloud key (optional, disclosed Gemini
only, key in the OS credential vault, double-gated behind cloud_enabled);
chat and vision models are user settings backed by the provider registry and
task router; macOS desktop-first for the Electron app, with an Android
webview preview in scope (debug-signed APK); App Store/Play Store
distribution still out of scope.

## Phase 0 - General-purpose foundation (Oct 28, 2026, DONE)

- Skill registry (`src/skills.js`): `general` always on; `student` optional
  and active only when course data exists.
- General-purpose default voice in Electron main and web bridge; fresh
  install is a usable general assistant with zero imports.
- Skill contract documented in `docs/SKILLS.md`.
- Tests: 24 passing at the time on Node v22.14.0 (19 pre-existing + 5 new
  skills tests).

Acceptance criteria met: default persona has no student assumptions; academic
functions unchanged when the student module activates; no cloud keys, no
billing, local DB only.

## Phase 1 - Companion surface (COMPLETE except workflows)

1. **Floating companion window** - DONE. Always-on-top overlay with global
   shortcut to summon/dismiss (src/overlay.js); never steals focus during
   typing; audio-only mic permission policy (src/permissions.js).
2. **Memory** - DONE. Local, editable, exportable About-me markdown file
   plus per-item delete and propose-then-confirm memory cards (src/memory.js,
   src/proposals.js); every stored fact is user-inspectable and stays on
   disk.
3. **Voice in** - DONE as push-to-talk. Local whisper.cpp with a fixed-path
   allowlist and a visible recording indicator (src/voice.js, src/whisper.js,
   src/vad.js); cross-platform on desktop, not Windows-only. Wake word: the
   milestone-2 engine landed (dynamic companion name, platform gate, honest
   listener state) and stays DEFAULT-OFF pending physical mic validation on
   real devices. TTS: resolved to OS-native speechSynthesis only (piper
   deferred and unbundled). Multilingual recognition models remain planned;
   the wake lane stays out of the milestone unless Ninad reopens it.
4. **Reusable step workflows** - NOT DONE. Planned with the workspace UI
   (M8).

## Phase 2 - Screen awareness and guidance (PARTIALLY COMPLETE)

2.2 **Screen awareness** - DONE in deliberately stricter form than
nus-desktop: on-demand capture of the focused window ONLY, visible
indicator, no cloud fallback for screenshots (src/screen-service.js,
src/screen-capture.js). The title-based sensitive-window filter is NOT
complete protection (acknowledged in CLAUDE.md).
2.1 **Point-at-element guidance** - NOT DONE. Planned after M7.
2.3 **Safe computer assistance** - NOT DONE. Re-planned as the Gate 2 agent
foundation: typed tool registry, external policy engine, approval classes,
audit log, and emergency stop BEFORE any computer-control tool. The
propose-then-confirm principle is unchanged.
    Gate 2 progress (24 Nov 2026): the agent safety foundation, security
    hardening, persistence, the orchestrator plus its audit fail-closed
    hardening, the first harmless tools (notifications, reminders, ics,
    with the ICS date/time and UTF-8 byte-count hardening from review),
    the prompt-injection red-team corpus, and the read-only renderer-to-
    main IPC contract are implemented as pure, isolated modules (blueprint
    sections 3a-3g). The IPC contract was hardened after review (strict
    plain-object validation, duplicate allowlist rejection, safe refusal
    rendering) and is now wired read-only end to end (section 3h: agent
    surface in main, one literal handler registration per channel, the
    preload and a text-only renderer panel; writes unreachable from the
    renderer; baseline 9addfdb, 614 tests). Persistence slice P1 is now
    implemented (blueprint section 3i: notifications and reminders persist
    with strict all-or-nothing hydrate, a versioned schema stamp, bounded
    loads, secret exclusion, acknowledged append durability, 8 new tests,
    622 total). Main-process wiring of the persistence layer is IMPLEMENTED (slice P2:
    six agent tables in the db.js schema, a narrow parameterized storage
    adapter, hydrate/export surfaces, audit-plus-anchor written in one
    transaction, startup chain verification, interrupted-run
    reconciliation, and save-on-tick plus quit hooks in main.js).
    Progress since 24 Nov: the scheduling tool gate landed (enabled and
    tested), the file-access tool is registered as the second agent tool,
    and the run driver reached Stage B with a review-briefed run entry
    point; the file-output tool is implemented but stays UNREGISTERED
    pending Ninad's root/security decision, and run-driver Stage C stays
    deferred. The connector lane (Ninad's 26-27 Nov decisions): the 20-entry
    free-first connector catalog with exact per-connector scopes, approval
    gates and a full lifecycle; the AI connect-request center (the agent can
    only ASK, an explicit user click resolves it); connector
    persistence so connections last until the user disconnects; and the
    service-agnostic credential store (OS credential vault, fail-closed,
    deterministic opaque references). NOTHING is connected: naming services,
    entering credentials and approving activations remain Ninad's calls.

Risks unchanged: per-OS permissions (Accessibility, Screen Recording,
Android foreground-service types) must fail closed; privacy expectations are
the product.

## Phase 4 - Packaging and release (ADVANCED; signing pending)

- electron-builder mac dmg (arm64 + x64, unsigned); the macOS arm64 DMG was
  verified building in CI (run 45012671571); signing and notarization still
  need a certificate and Ninad's explicit cost approval.
- Android: debug-signed public preview APK; the fresh key per CI run means
  uninstall-before-update; release signing is a separate decision.
- One-click Ollama onboarding shipped (PR #9, merged as 6423985).

## Superseded forward plan

The old Phase 1/2/4 ordering is replaced by docs/IMPLEMENTATION_ROADMAP.md
(M0-M8 with Gate 1 and Gate 2), which is the LIVE record: M0-M6 slices plus
the Gate 2 agent foundation, workspace surface and connector lane are
largely landed there, with the remaining owner-gated items called out in
docs/NEXT_DECISIONS.md. docs/PRODUCT_BLUEPRINT.md section 4 remains the
authoritative planned list; this file no longer carries a parallel
implementation status.

## Explicitly out of scope (updated Nov 23, 2026)

Billing of any kind; cloud-required features; always-on capture or listening
without explicit opt-in and visible indicators; App Store/Play Store
distribution for now (iOS remains out of scope; Android is in scope: webview
preview shipped, on-device AI pending Gate 1); unrestricted agent control.
