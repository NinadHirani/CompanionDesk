# FEATURE_GAP.md - CompanionDesk vs nus-desktop companion capabilities

Updated Nov 23, 2026 against main `2d349c5`. The nus-desktop comparison below
is the Oct 28, 2026 snapshot, kept unchanged for reference. The
CompanionDesk status and gap lists now reflect shipped reality; the current
baseline is docs/PRODUCT_BLUEPRINT.md and the forward plan is
docs/IMPLEMENTATION_ROADMAP.md.

## What nus-desktop documents (verified from its README, Oct 28, 2026)

- **The Knot**: a floating companion pane/overlay that keeps running after
  the main window closes; has its own settings (own gear icon).
- **Voice**: click the Knot and talk; speech-to-text runs locally with
  whisper.cpp (about 65 MB download); the reply streams under the Knot and
  the Knot lights up as it listens/thinks/speaks; talking over a reply
  interrupts it. Local whisper is Windows-only per the README; other
  platforms fall back to cloud keys.
- **Companion AI**: the companion runs on its own Gemini key (separate from
  the main app's Claude key). CompanionDesk's equivalent is local Ollama.
- **Screen awareness**: the README states the Knot "watches your screen and
  listens in meetings"; files Nūs reads while thinking surface as stars on
  the constellation. Exact mechanics (continuous vs on-demand capture) are
  NOT detailed in the README (ASSUMPTION: some form of ongoing screen
  context; must be confirmed in code before imitating).
- **Confirm-step actions**: the companion can create tasks, move dates, and
  draft emails, each with a confirm step (propose-before-write).
- **Email drafter**: works offline; drafts open pre-filled in Gmail.
- **Caps/billing**: Free/Pro tiers with Stripe (3 imports/day, 10
  questions/day, 20 companion minutes/day, etc.). CompanionDesk will NOT
  copy this: no billing by design.

## CompanionDesk status (verified in the working copy, Nov 23, 2026, main 2d349c5)

- Local-first chat with local Ollama (llama3.2:latest default); the opt-in
  Gemini fallback now has secure key setup: the key is encrypted at rest in
  the OS credential vault via Electron safeStorage, decrypted only in the
  main process, never returned to the renderer or placed in a URL, and
  fail-closed when OS encryption is unavailable. VERIFIED in src/ai.js and
  src/secure-store.js.
- General-purpose persona by default; student module optional
  (src/skills.js, docs/SKILLS.md). VERIFIED.
- Local DB (sql.js) with export to a markdown vault. VERIFIED.
- Confirm-before-write for data changes; no autonomous writes exist (the app
  has no computer-control surface at all). VERIFIED by code inspection.
- Shipped since the Oct 28 snapshot: floating always-on-top overlay
  (src/overlay.js), push-to-talk voice via local whisper.cpp (src/voice.js,
  src/whisper.js), local About-me memory with propose-then-confirm cards
  (src/memory.js, src/proposals.js), on-demand single-window screen Q&A with
  a local vision model (src/screen-service.js), one-click Ollama onboarding
  (src/ollama-setup.js, PR #9), and the public debug-APK preview. 306 tests
  passing; three main-branch CI workflows green.

## Gaps (current, mapped to docs/IMPLEMENTATION_ROADMAP.md)

1. Gemini key-entry UI - DONE 23 Nov 2026 (encrypted-at-rest via safeStorage,
   masked status, fail-closed, explicit opt-in wording; src/secure-store.js).
   Android/web key setup is unsupported by design until a secure platform
   vault adapter exists; no insecure fallback.
2. Conversation history in the ask flow - DONE 23 Nov 2026 (local-only,
   rename, confirmed delete; src/chat-history.js).
3. Model-as-setting instead of hardcoded constants - DONE 23 Nov 2026
   (separate chat and vision settings, installed-only selection,
   src/model-selection.js).
4. Provider/model registry and task router - PLANNED (M1); not implemented.
5. Reusable step workflows - ABSENT (planned with the workspace UI, M8).
6. Safe computer assistance (propose-then-confirm OS actions) - PLANNED as
   the Gate 2 agent foundation: typed tool registry, external policy engine,
   approval classes, audit log, and emergency stop BEFORE any
   computer-control tool exists. Nothing of this is implemented yet.
7. Meeting-listening / continuous awareness - deliberately NOT planned
   without explicit opt-in, visible indicators, and platform-compliant
   foreground services.
8. Proactive scheduler and notifications, wake word, text-to-speech,
   multilingual speech recognition, Android on-device AI, secure desktop
   gateway, live session screen observation, integrations - PLANNED per the
   gated roadmap (M4-M8); none implemented today.

## Deliberate divergences (unchanged)

- No billing/caps of any kind (nus-desktop has Stripe-based Free/Pro).
- No required cloud key for the companion (nus-desktop requires two keys);
  optional Gemini arrives only with explicit disclosure.
- Student features are an optional skill, not the product identity.
- Desktop-first; nus-desktop ships Windows installers first.
