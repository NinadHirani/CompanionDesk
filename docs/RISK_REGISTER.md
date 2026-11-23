# CompanionDesk Risk Register

Status: **proposed** (M0 baseline). Each risk carries likelihood, impact,
mitigation, how we would detect or validate it, and residual risk after
mitigation. External constraints flagged "reported" come from ChatGPT's
documentation research and are unverified until checked against current
official sources.

## Risks

- **R1 - Android on-device inference unknown.** Performance, RAM, battery,
  and thermal behavior of quantized models on the OnePlus 12R are unmeasured.
  Likelihood high, impact high. Mitigation: Gate 1 measures before any
  architecture commitment; desktop gateway remains the fallback. Residual:
  medium until measured.
- **R2 - Prompt injection into an acting agent.** Malicious instructions in
  web pages, emails, documents, files, screenshots, or tool output could try
  to drive tools. Impact severe. Mitigation: policy engine outside the model,
  external content delimited as untrusted data, tool results never executed
  as instructions, approval classes, emergency stop, and an injection test
  corpus required before any grant widening. Residual: low with the full
  framework; unacceptable without it, so no computer-control tool ships
  before Gate 2.
- **R3 - Screen privacy exposure.** Captured windows can contain secrets.
  Impact severe. Mitigation: on-demand per-click capture only today; live
  observation (M7) is opt-in, visible, pausable, with app exclusions and
  local-only processing. Limitation: the sensitive-window filter is
  title-based and incomplete, acknowledged in `CLAUDE.md`. Residual: medium.
- **R4 - Ollama LAN exposure.** The Android gateway puts a local AI service
  on the network. Ollama has no built-in authentication by default
  (unverified). Mitigation: token-authenticated proxy, Ollama bound to
  localhost, LAN-only, disabled until Gate 1. Residual: low.
- **R5 - Model licensing noncompliance.** Gemma (custom terms) and Llama
  (community license, use restrictions) cannot be assumed redistributable.
  Likelihood medium, impact high. Mitigation: license metadata in the
  registry; nothing license-encumbered bundled by default; per-model review
  before shipping. Residual: low.
- **R6 - Wake-word model licensing.** Reported: openWakeWord code is
  Apache-2.0 but its pretrained models are CC BY-NC-SA 4.0. Mitigation: POC
  only, nothing bundled pending license review; self-trained or alternative
  models as fallback. Residual: low if honored.
- **R7 - TTS dependency health.** Reported: the original Piper repository is
  archived; its successor's maintenance and licensing are unverified.
  Mitigation: OS-native TTS first; Piper only after the successor is
  verified. Residual: low.
- **R8 - Android background constraints.** Reported: Android 14+ generally
  prevents starting a microphone foreground service from the background, and
  Android 15 restricts microphone/MediaProjection services from boot
  receivers; MediaProjection needs per-session consent. Mitigation: ambient
  listening only from user-initiated foreground sessions; no boot-started
  mic services; verify against current Android docs before M6. Residual:
  design accommodates the rules, so low.
- **R9 - Debug-signed public APK.** Fresh signing key per CI run forces
  uninstall-before-update; not a distribution path. Mitigation: preview-only
  labeling (done in release notes); release signing decided separately
  (ADR-0012). Residual: medium until signed releases exist.
- **R10 - Unsigned desktop builds.** macOS Squirrel cannot replace unsigned
  apps, so updates stay manual-download (`src/update-policy.js`). Known and
  handled; residual: low, revisited at the signing decision.
- **R11 - Storage scaling.** sql.js serializes the whole database on save.
  Fine at student scale; revisit if the DB grows past tens of MB.
  Residual: low.
- **R12 - Single-maintainer bus factor.** Mitigation: `CLAUDE.md` hard rules,
  pure-module architecture, 258-test suite, and the M0 documentation baseline.
  Residual: ongoing.
- **R13 - Stale documentation misleads contributors.** `FEATURE_GAP.md` and
  `COMPANIONDESK_ROADMAP.md` contradict shipped reality. Mitigation: M0
  refresh plus the implemented/planned discipline in the new docs. Residual:
  low after refresh.
- **R14 - Unverified platform claims.** Windows/Linux behavior and Electron
  boot on real macOS are unexercised. Mitigation: platform test matrix per
  phase; devices listed as targets, never cited as evidence. Residual: medium
  until real-machine testing.

## Required experiments before commitment

Android on-device benchmark (Gate 1); wake-word false-trigger and latency
test; MediaProjection consent behavior; live-capture battery and CPU cost;
desktop automation permissions walkthrough per OS; sql.js FTS5 availability
check; fresh license and maintenance reads of every third-party candidate.
