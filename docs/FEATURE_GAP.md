# FEATURE_GAP.md - CompanionDesk vs nus-desktop companion capabilities

Comparison against the companion functionality documented in
https://github.com/potlakai/nus-desktop (README read Oct 28, 2026).
Facts below marked VERIFIED come from that README read on this date;
ASSUMPTION items are inferred and need code-level confirmation.

## What nus-desktop documents (verified from its README)

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

## CompanionDesk status (verified in this working copy, Oct 28)

- Local-first chat with local Ollama (llama3.2:latest default), optional
  opt-in Gemini fallback; no cloud requirement. VERIFIED in src/ai.js.
- General-purpose persona by default; student module optional
  (src/skills.js, docs/SKILLS.md). VERIFIED + tested (24/24).
- Local DB (sql.js) with export to a markdown vault. VERIFIED (earlier
  sessions' tests).
- Confirm-before-write for data changes: imports are reviewable and dates
  flagged; no autonomous writes exist (the app has no computer-control
  surface at all yet). VERIFIED by code inspection this pass.

## Gaps (CompanionDesk missing, in roadmap order)

1. Floating companion window/overlay - ABSENT (Phase 1.1).
2. Voice in/out, local STT - ABSENT (Phase 1.3; must not be Windows-only).
3. Memory of user facts/preferences - ABSENT beyond the imported data
   (Phase 1.2).
4. Screen awareness / point-at-element guidance - ABSENT (Phase 2; design
   deliberately stricter than nus-desktop: on-demand capture only, visible
   indicator, no always-on anything without explicit opt-in).
5. Reusable step workflows - ABSENT (Phase 1.4).
6. Safe computer assistance (propose-then-confirm OS actions) - ABSENT
   (Phase 2.3).
7. Meeting-listening / continuous awareness - deliberately NOT planned
   without explicit opt-in and indicators.

## Deliberate divergences

- No billing/caps of any kind (nus-desktop has Stripe-based Free/Pro).
- No required cloud key for the companion (nus-desktop requires two keys).
- Student features are an optional skill, not the product identity.
- macOS desktop-first; nus-desktop ships Windows installers first.
