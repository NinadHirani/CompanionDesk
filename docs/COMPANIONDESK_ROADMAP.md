# CompanionDesk Roadmap (general-purpose desktop companion)

Direction set Oct 28, 2026: CompanionDesk is a **general-purpose, local-first
desktop AI companion** inspired by the companion functionality in
potlakai/nus-desktop (floating companion/Knot, voice, screen awareness,
point-at-element guidance, reusable step workflows, memory, safe computer
assistance). CompanionDesk is NOT a NUS-for-students product: student features
are one optional skill/module, never the core identity. Not to be confused
with the original potlakai/nus student prompt project.

Standing constraints (unchanged): local-first, Ollama `llama3.2:latest` as the
default model, no required cloud key, no billing/Supabase/Stripe, macOS
desktop-first (no mobile/App Store/Play Store work).

## Phase 0 - General-purpose foundation (Oct 28, 2026, DONE)

- Skill registry (`src/skills.js`): `general` always on; `student` optional
  and active only when course data exists.
- General-purpose default voice in Electron main and web bridge; fresh
  install is a usable general assistant with zero imports.
- Skill contract documented in `docs/SKILLS.md`.
- Tests: 24 passing on Node v22.14.0 (19 pre-existing + 5 new skills tests).

Acceptance criteria met: default persona has no student assumptions; academic
functions unchanged when the student module activates; no cloud keys, no
billing, local DB only.

## Phase 1 - Companion surface (next)

Priority order, each independently shippable:
1. **Floating companion window** (Electron always-on-top overlay, the "Knot"
   analog): pinned to a screen edge, click-to-focus, global shortcut to
   summon/dismiss. Acceptance: opens over other apps, never steals focus
   during typing, hides to tray, zero telemetry.
2. **Memory**: local, editable, exportable memory of user facts and
   preferences (SQLite table + settings UI + per-item delete). Acceptance:
   user can inspect and delete every stored fact; memory stays on disk.
3. **Voice in**: push-to-talk only at first (no always-on listening without
   explicit opt-in + visible indicator). Cross-platform local STT (not
   Windows-only like nus-desktop's whisper.cpp path). Acceptance: no audio
   leaves the machine; recording indicator visible whenever a mic is open.
4. **Reusable step workflows**: user-defined multi-step prompts (template +
   variables), run against local context. Acceptance: workflows are plain
   files the user can edit, no remote definitions.

Dependencies: 1 is pure Electron; 2 needs a small DB migration; 3 needs a
native STT binary decision (bundle vs download-with-consent).

## Phase 2 - Screen awareness and guidance (risky, careful)

1. **Point-at-element guidance**: user points at a UI element in another app;
   CompanionDesk explains it or suggests a step. Start read-only via the
   macOS Accessibility API with a per-session permission grant.
2. **Screen awareness**: on-demand capture of the focused window ONLY, never
   continuous capture; every capture shows a visible indicator; title-based
   sensitive-window checks are NOT considered complete protection (window
   titles are attacker-controlled and incomplete). Acceptance: capture is
   explicit per action, indicated on screen, stored nowhere by default.
3. **Safe computer assistance**: propose-then-confirm actions only (the app
   drafts the action, the user executes or approves each step). No
   unrestricted control, no hidden automation, no keystroke injection without
   an explicit per-action confirmation.

Risks: macOS permissions (Accessibility, Screen Recording) are per-app and
must fail closed; privacy expectations are the product.

## Phase 4 - Packaging and release

- electron-builder mac dmg (arm64 + x64, identity null today); signing and
  notarization need a certificate Ninad does not have yet.
- Acceptance: fresh install runs as a general assistant offline; student
  module works only after the user opts in.

## Explicitly out of scope

Mobile (Capacitor/Android/iOS), App Store/Play Store, billing of any kind,
cloud-required features, always-on capture or listening without explicit
opt-in and visible indicators.
