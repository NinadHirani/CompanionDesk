# CompanionDesk Roadmap (general-purpose desktop companion)

Updated Nov 23, 2026. Direction set Oct 28, 2026: CompanionDesk is a
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

Standing constraints (updated Nov 23, 2026): local-first and free-first; no
billing/Supabase/Stripe; no required cloud key (optional, disclosed Gemini
only); default model llama3.2:latest today, becoming a user setting in M0;
macOS desktop-first for the Electron app, with an Android webview preview
now in scope (debug-signed APK); App Store/Play Store distribution still out
of scope.

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
   src/vad.js); cross-platform on desktop, not Windows-only. Multilingual
   models, wake word, and TTS remain PLANNED (M6); none implemented.
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
(M0-M8 with Gate 1 and Gate 2). Beyond the DONE items above, nothing in that
plan is implemented; docs/PRODUCT_BLUEPRINT.md section 4 is the
authoritative planned list.

## Explicitly out of scope (updated Nov 23, 2026)

Billing of any kind; cloud-required features; always-on capture or listening
without explicit opt-in and visible indicators; App Store/Play Store
distribution for now (iOS remains out of scope; Android is in scope: webview
preview shipped, on-device AI pending Gate 1); unrestricted agent control.
