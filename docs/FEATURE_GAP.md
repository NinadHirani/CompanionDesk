# FEATURE_GAP.md - CompanionDesk vs nus-desktop companion capabilities

HISTORICAL COMPARISON SNAPSHOT. The nus-desktop comparison below is the
Oct 28, 2026 snapshot, kept unchanged for reference. The CompanionDesk
status and gap lists below were refreshed 27 Nov 2026 against main `bb9aab9`
(1372 tests, both main-branch CI workflows green). This file is NOT the
canonical current status: the current baseline is docs/PRODUCT_BLUEPRINT.md
and the forward plan is docs/IMPLEMENTATION_ROADMAP.md (that file carries
the verified head, test count and CI run ids).

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

## CompanionDesk status (historical snapshot, verified Nov 23, 2026 against main 29c1417; current state: docs/PRODUCT_BLUEPRINT.md)

- Local-first chat with local Ollama (llama3.2:latest default, user-settable
  since M0); the opt-in Gemini fallback has secure key setup: the key is
  encrypted at rest in the OS credential vault via Electron safeStorage,
  decrypted only in the main process, never returned to the renderer or
  placed in a URL, and fail-closed when OS encryption is unavailable.
  VERIFIED in src/ai.js and src/secure-store.js.
- General-purpose persona by default; student module optional
  (src/skills.js, docs/SKILLS.md). VERIFIED.
- Local DB (sql.js) with export to a markdown vault; agent notifications,
  reminders, audit and run state persist through the versioned P1/P2
  persistence layer (all-or-nothing hydrate, schema stamp, startup chain
  verification). VERIFIED.
- Confirm-before-write for data changes; the agent surface stays inside a
  typed tool registry with per-scope approval gates, an external policy
  engine, an append-only audit log and an emergency stop; no computer-control
  tool exists. VERIFIED by code inspection.
- Shipped since the Oct 28 snapshot: floating always-on-top overlay
  (src/overlay.js), push-to-talk voice via local whisper.cpp (src/voice.js,
  src/whisper.js), local About-me memory with propose-then-confirm cards,
  per-search sensitive-memory consent with auto-reset (M4), the proactive
  scheduler and delivery loop with quiet hours (M5), the wake-word engine
  milestone 2 (default-off pending physical mic validation) and the
  OS-native-only TTS decision (M6), the M7 policy slice and observation
  session machine (capture engine stays unbuilt by decision), one-click
  Ollama onboarding (PR #9), the public debug-APK preview, the Gate 2
  workspace surface (row stores + nine wired views), the 20-entry connector
  catalog, the AI connect-request flow and the service-agnostic OS-vault
  credential store. 1372 tests passing and both main-branch CI workflows
  green at bb9aab9; the roadmap carries the exact run ids.

## Gaps (current, mapped to docs/IMPLEMENTATION_ROADMAP.md)

1. Gemini key-entry UI - DONE 23 Nov 2026 (encrypted-at-rest via safeStorage,
   masked status, fail-closed, explicit opt-in wording; src/secure-store.js).
   On Linux only real secret services are accepted: the basic_text and
   unknown safeStorage backends fail closed, as does a missing backend query
   API. Android/web key setup is unsupported by design until a secure
   platform vault adapter exists; no insecure fallback.
2. Conversation history in the ask flow - DONE 23 Nov 2026 (local-only,
   rename, confirmed delete; src/chat-history.js).
5. Hardware-aware model defaults - DONE 23 Nov 2026 (src/hardware.js:
   local-only OS/browser readings, sanitized coarse facts only, documented
   lightweight/balanced/powerful thresholds, conservative fallback when
   unknown; the profile steers only DEFAULT choices and Settings recommends
   installed models, never downloads).
3. Model-as-setting instead of hardcoded constants - DONE 23 Nov 2026
   (separate chat and vision settings, installed-only selection,
   src/model-selection.js).
4. Provider/model registry and task router - FIRST SLICE DONE 23 Nov 2026
   (pure modules: src/provider-registry.js describes Ollama and optional
   Gemini with per-exact-model capabilities and unverified license/context/
   cost; src/task-router.js decides deterministically: local-first, vision
   local-only, cloud only with cloud_enabled + consent + key + a provider
   known healthy; unknown health and an unverified cloud capability refuse).
   Deeper per-ask routing integration DONE 23 Nov 2026: the ask and screen
   paths gather live provider facts per request under bounded timeouts and
   route through the router; the screen path is forced local-only; a failed
   local chat with the cloud armed surfaces a per-request confirmation
   whose disclosure matches the actual payload for that ask: minimized
   (question, assistant rules, course/due-date context) with cloud_personal
   off; full personal context (plus calendar entries, name, selected
   memories, and activity patterns when learn_from_activity is on) with it
   on; conversation history and screenshots are never sent in either mode.
   The legacy ai.complete() path is local-only (review fix, 23 Nov 2026):
   no key or setting can make it transmit. A decline is reported as the
   local failure and nothing retries; asks are cancellable and every
   network call is bounded; the web bridge routes the same way and fails
   closed.
5. Reusable step workflows - ABSENT (planned with the workspace UI, M8).
6. Safe computer assistance (propose-then-confirm OS actions) - the Gate 2
   agent foundation is IMPLEMENTED: typed tool registry (notifications,
   reminders, file access and connector status registered; file output
   implemented but unregistered pending the owner's security decision), the
   external policy engine with per-scope approval classes, the append-only
   audit log, the emergency stop, and the run driver Stage A/B with a
   review-briefed run entry point. No computer-control tool exists.
7. Meeting-listening / continuous awareness - deliberately NOT planned
   without explicit opt-in, visible indicators, and platform-compliant
   foreground services.
8. Proactive scheduler and notifications - DONE (M5: scheduler, delivery
   loop, quiet hours, per-channel routing). Wake word - engine landed,
   default-off pending physical mic validation. Text-to-speech - OS-native
   speechSynthesis decision landed (M6). Multilingual speech recognition,
   Android on-device AI, secure desktop gateway, live session screen
   observation, reusable step workflows, integrations and real connector
   activations - PLANNED per the gated roadmap (M7/M9 deferred; connector
   activations need the owner to name services, enter credentials and
   approve scopes; the credential layer itself is DONE).

## Deliberate divergences (unchanged)

- No billing/caps of any kind (nus-desktop has Stripe-based Free/Pro).
- No required cloud key for the companion (nus-desktop requires two keys);
  optional Gemini arrives only with explicit disclosure.
- Student features are an optional skill, not the product identity.
- Desktop-first; nus-desktop ships Windows installers first.
