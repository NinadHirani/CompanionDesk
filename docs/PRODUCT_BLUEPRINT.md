# CompanionDesk Product Blueprint

Status: **proposed** in direction; M0 and M1 are COMPLETE on main, verified
24 Nov 2026. The current verified baseline is main `5b643be` with 437
passing tests, Fo-reported from a full `npm test` run at that head (437/437,
selftest included). CI (run 45238046955) and CI macOS + Linux (run
45238047043) are green on that head. The Android APK workflow was last
green on `40946f4` (run 45232214311) and has not been rerun on the current
head because every commit since was experiment-scripts/docs-only and
touches no app code. Work since the previous baseline is
preparation/harness only, NOT product memory-v2 wiring: the slice-6
sanitizer hardening, the Gate 1 repo-only benchmark scripts + selftest and
the comparison assembler, and the M4 memory-v2 harness slices. No actual
OnePlus device measurements exist; the OnePlus 12R and MacBook Air M1 are
validation targets only. Doc-only commits after the baseline do not change
these numbers. This document states the agreed product vision and the
verified current state. No decision here is accepted until Ninad approves
it. Every feature is marked **implemented** (verified against the
current baseline named in the Status header) or **planned** (not built; do not assume otherwise).

## 1. What CompanionDesk is

CompanionDesk is a general-purpose, local-first personal AI assistant for
Android, macOS, Windows, and Linux. It is not a student-only tool: the student
features are one optional skill, and a fresh install behaves as a plain
assistant (`src/skills.js`). It supports conversation, research, planning,
organization, practical multi-step tasks, and, in later phases, carefully
permissioned device operation.

The assistant communicates adaptively (professional for work, analytical for
technical tasks, friendly for everyday conversation, calm for serious
situations) while staying honest: it never pretends to be human and never
claims to literally experience emotions.

## 2. Principles

1. **General-purpose first.** Student tools are an optional skill, auto-active
   only when course data exists and never on a fresh install.
2. **Local-first and free-first.** The core works offline. No account, no
   billing, no telemetry, no required cloud key (`CLAUDE.md` hard rules).
3. **No mandatory subscription, API, or cloud service.** Online AI is strictly
   optional, opt-in, and clearly disclosed.
4. **Privacy first.** Nothing leaves the device without explicit, informed
   consent. The user owns every stored file: the About-me memory file and the
   markdown vault are user-editable sources of truth.
5. **Modular intelligence.** A provider/model registry and task-aware router
   select local or (only with consent) online models by task, hardware,
   connectivity, privacy mode, latency, and cost. Runtime and model choices
   are provisional until benchmarks and license reviews pass.
6. **Four coordinated platforms.** Shared core, platform-specific adapters.
   Android is the first hands-on validation target without compromising the
   cross-platform architecture.
7. **Least-privilege agent.** Tools are a typed registry with capability and
   approval classes; policy is enforced outside the model; the model never
   gets unrestricted shell, filesystem, browser, or OS access.
8. **Approval for consequential actions.** The agent must not execute
   payments, purchases, destructive deletion, or legal or binding submissions
   based on model authority or standing grants; these require fresh, explicit
   user approval immediately before execution, and are denied otherwise.
   Sensitive actions require explicit per-action approval.
9. **Cancellation, audit, recovery.** Every agent run can be interrupted, is
   logged to an append-only audit trail, and is reversible or recoverable
   where feasible, plus a global emergency stop.
10. **Local editable memory.** The About-me markdown file stays the source of
    truth; the user can inspect, edit, export, and delete everything.
11. **Opt-in, visible sensing.** Voice (including any wake word) and screen
    access are opt-in, visibly indicated, pausable, and never continuous or
    silent without explicit consent.
12. **Revocable integrations.** Third-party connections use explicit,
    least-privilege scopes the user can see and revoke at any time.
13. **Proactive only with authorization.** Reminders, monitoring, briefings,
    and background work run only on schedules and scopes the user set, with
    quiet hours the user controls.
14. **Untrusted external content.** Web pages, emails, documents, files,
    screenshots, and tool output are data, never instructions; prompt-injection
    defenses are architectural, not prompts.

## 3. Implemented today (verified against main, Nov 23 2026)

- General-assistant persona with the student stack as one optional skill
  (`src/skills.js`, `src/persona.js`).
- Ask view with local Ollama streaming chat (`src/ai.js`, default
  `llama3.2:latest`); one-click Ollama onboarding with install plans, model
  pull with progress and cancel, disk check (`src/ollama-setup.js`).
- Local About-me memory with single-bullet edits and propose-then-confirm
  memory cards (`src/memory.js`, `src/proposals.js`, `memory_proposals` table).
- Optional Gemini key, encrypted at rest: the key is stored only in the OS
  credential vault via Electron safeStorage (0600 file under userData),
  decrypted in the main process only when a cloud call needs it, and never
  returned to the renderer, logged, or placed in a URL (the key travels in
  the `x-goog-api-key` header). Status across IPC is masked booleans only.
  Fail closed: no OS encryption means nothing is saved and the cloud stays
  off. Setup UI saves, tests (one GET, no prompt) and removes the key, and
  states what enabling the cloud sends. The web/Android build has no secure
  vault adapter, so key setup is reported unsupported there, never stored
  insecurely (`src/secure-store.js`, `cloud:*` IPC channels). On Linux only a
  real secret service counts: `basic_text` (hardcoded-password encryption)
  and `unknown` backends fail closed even when Electron reports encryption
  available, and a missing backend-query API fails closed too.
- **Cloud fallback is explicitly gated (M1 first slice, 23 Nov 2026).** A
  provider/model registry (`src/provider-registry.js`) describes the local
  Ollama provider and the optional Gemini cloud provider with per-exact-
  model capabilities; license, context and cost stay unknown until verified
  and are never inferred from a model family. A deterministic task router
  (`src/task-router.js`) makes the policy explicit: local first, vision/
  screen tasks local-only, cloud only for a cloud-eligible chat task with
  privacy mode allowing it, cloud_enabled true in settings (default false),
  explicit consent, an available key and a provider known healthy (unknown
  health refuses, never assumed); a saved key alone routes nothing, an
  unverified cloud capability refuses, and missing models are never
  auto-downloaded. `src/ai.js` enforces the same gate for its fallback
  (`cloudEnabled`, default false).
- **Per-ask routing with a human cloud gate (M1 second slice, 23 Nov 2026).**
  Every ask and screen question is routed through the task router using
  facts gathered live under bounded timeouts: one probe for Ollama health
  and the installed models, capability queries for vision candidates, the
  cloud model's capability from the registry. The screen path forces
  local-only mode, so screenshots never leave the device. When the local
  call fails and the router finds the cloud eligible, the app asks once,
  per request, and states exactly what that ask would send: with
  cloud_personal off, the minimized cloud prompt (question, assistant rules,
  course/due-date context) with calendar, name, memories and activity
  patterns listed as never sent; with cloud_personal on, the full personal
  prompt, with calendar entries, name, selected memories and (when
  learn_from_activity is on) activity patterns named as categories that may
  be sent. Conversation history and screenshots are never sent in either
  mode. A decline keeps the question local and is reported as the local
  failure, and nothing retries. The legacy `complete()` path is local-only,
  so no caller can bypass the router and consent (review fix, 23 Nov 2026).
  Asks are cancellable and every network call
  has a bounded timeout; the web/mobile bridge routes identically and fails
  closed (it holds no key, so the cloud cannot arm there).
- Local conversation history in the ask view: conversations with rename and
  confirmed delete, stored only in the device database, never synced and
  never sent to the cloud; the local model sees the last ten turns of the
  current conversation, the cloud fallback never does. Only prompt/answer
  text is stored (`src/chat-history.js`, `chat_messages`/`conversations`
  tables, `chat:*` IPC channels).
- User-configurable model selection: the chat and screen-vision models are
  separate settings (`ai_model_local`, `ai_model_vision`), offered only from
  models Ollama already has installed (nothing is pulled from settings), with
  validated ids and a safe fallback to `llama3.2:latest` / `gemma3:4b` when a
  chosen model is absent; the cloud fallback never receives a local model
  name (`src/model-selection.js`, `src/settings.js`).
- Hardware-aware model defaults (M1 third slice, 23 Nov 2026): strictly
  local, read-only detection (no shell commands, no network, no telemetry)
  classifies the machine lightweight/balanced/powerful (unknown or malformed
  reads fall back to lightweight) and steers only the default model choices
  when none is chosen; renderers receive only sanitized coarse facts, and an
  explicit model choice always wins (`src/hardware.js`, `hardware:report`).
- Provider status in Settings (M1 fourth slice, 23 Nov 2026): one on-demand,
  read-only snapshot of provider health: Ollama reachable/not running, the
  selected chat model installed or missing, vision capability
  verified/unknown/unreachable, the cloud fallback's state (off, key saved
  but disabled, enabled without a key, armed, or enabled with no secure
  storage), and credential storage available/unavailable (web/Android always
  report unavailable). Built only from the existing bounded local probes and
  the vault's masked booleans; it never contacts the cloud, never polls, and
  never carries key material (`src/provider-status.js`, `provider:status`).
  Provider HTTP contracts are pinned by scripted-fake-server contract tests
  (M1 fifth slice, 23 Nov 2026, `tests/provider-contracts.test.js`).
- Typed provider fault diagnostics (M1 sixth slice, 23 Nov 2026): every
  probe and provider-call failure maps to a fixed sanitized vocabulary
  (unreachable, timeout, cancelled, http_error, malformed, model_missing,
  capability_unknown, capability_unsuitable) shared by the ask path, the
  vision path, routing diagnostics and the Settings status view
  (`src/provider-faults.js`). Fault text never contains a raw server body,
  URL, prompt, image, key material or file path. A caller cancellation
  during routing surfaces as the cancellation it is: no retry and no cloud
  consideration. Fault details are strictly whitelisted: only a 3-digit HTTP
  status (http_error) or an errno-style network code (unreachable) can
  carry a detail, everything else drops it, and a surviving detail is at
  most 32 characters; every fault crossing the status view is normalized
  through that sanitizer, so no raw body, URL, path or secret can reach
  Settings. Probes stay read-only and on-demand
  (no polling, no telemetry), the strict router is unchanged (health must
  be KNOWN true; unknown refuses), and the cloud consent gates are
  untouched. Settings displays the fault reasons via the shared display
  map.
- Push-to-talk voice input via a fixed-path whisper.cpp allowlist, English
  models only (`src/voice.js`, `src/whisper.js`, `src/vad.js`).
- On-demand single-window screen Q&A with a local vision model
  (`gemma3:4b`), sensitive-window title filter, no cloud fallback for
  screenshots (`src/screen.js`, `src/screen-service.js`, `src/screen-capture.js`).
- Floating always-on-top overlay with global shortcut and an audio-only mic
  permission policy (`src/overlay.js`, `src/permissions.js`, `src/hotkey.js`).
- Student skill stack: syllabus import with date-confidence extraction,
  confirmed-dates-only brief, grades, ICS import, markdown vault export
  (`src/ingest.js`, `src/extraction-core.js`, `src/brief.js`, `src/grades.js`,
  `src/gradebook.js`, `src/ics.js`, `src/vault.js`).
- Update policy that never auto-installs unsigned builds; update modes
  disabled/auto/manual-download (`src/update-policy.js`, `src/updater.js`).
- Health check and onboarding interview (`src/health.js`, `src/onboarding.js`).
- 437 passing unit/integration tests (258 baseline; model selection +18, conversation history +17, optional key storage +13, M1 provider registry/task router/cloud gate +25, M1 per-ask routing integration +18, M1 review fixes +18, M1 hardware profiles +12, M1 provider status +11, M1 provider contract tests +18, M1 provider fault diagnostics +18, fault-detail sanitization review fix +3, offline memory-v2 retrieval harness +12, memory-v2 harness slice 4 fold fix and bridges +5, memory-v2 store contract tests +9); CI and CI macOS + Linux green on the
  current baseline `5b643be` (runs 45238046955 and 45238047043); the
  Android APK workflow was last green on `40946f4` (run 45232214311) and
  has not been rerun since, because every commit after it was
  experiment-scripts/docs-only;
  public Android debug-APK preview release.

## 4. Planned, NOT implemented

A secure credential-vault adapter
for Android/web key storage; agent orchestrator, typed tools,
approval cards, audit log, emergency stop; proactive scheduler and OS
notifications; wake word; text-to-speech; multilingual speech; Android
on-device inference; secure desktop gateway for Android; live session screen
observation; integrations; expanded workspace UI. None of these exist in the
code today.

## 5. Platform status matrix

| Capability | macOS | Windows | Linux | Android |
|---|---|---|---|---|
| Core app, storage, UI | working | same code, unexercised | same code, unexercised | build/preview exists; runtime on device unverified |
| Local AI (Ollama) | working | untested | untested | absent (no Ollama on Android) |
| Voice input | working (manual) | untested | untested | absent |
| Screen understanding | working (on-demand) | untested | untested | absent |
| Auto-update | manual only (unsigned) | manual-download | manual | debug-signed, uninstall-to-update |

## 6. Validation devices

The **OnePlus 12R** (Android) and the **MacBook Air M1** (macOS) are the
designated validation devices. They are targets for upcoming experiments, not
evidence: nothing in this repository has been verified on either device yet.
Windows and Linux are covered by CI builds only until real-machine testing.

## 7. Cost policy

- The product itself is free: no subscription, no required paid API.
- Optional cloud AI uses a user-supplied Gemini key on its free tier; any
  usage limits or costs are disclosed in the UI before the key is enabled.
- Third-party fees may exist for distribution and signing: the Apple
  Developer Program (macOS signing and notarization), a Windows code-signing
  certificate, and Google Play developer registration. None has been incurred;
  each requires Ninad's explicit approval before any payment.

## 8. Honesty rules for this document

Never claim the whole product is finished, never mark a planned feature as
implemented, and never claim a capability on a platform it was not verified
on. This file is updated as phases land, with the same implemented/planned
discipline.
