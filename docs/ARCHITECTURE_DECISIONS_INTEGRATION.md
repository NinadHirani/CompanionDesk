# Areas 1-10 architecture-integration addendum

Status: **DOCS-ONLY TRACEABILITY ADDENDUM, written 24 Nov 2026.** The
primary programme remains `docs/IMPLEMENTATION_ROADMAP.md` (the M0-M9
governing order, phase gates, validation-device rules, and release and
security artifacts are unchanged). This file does not replace, renumber,
or rewrite that roadmap; it maps Ninad's confirmed Areas 1-10
requirements (24 Nov 2026) onto the existing milestones so nothing is
duplicated and nothing is silently dropped. No implementation code
belongs to this slice.

Repo head at writing: `19704a9` (suite 867/867 + selftest, CI green).
Requirements source: Ninad's confirmed Area 1-10 requirements in the
CompanionDesk Repo Sync thread, 24 Nov 2026.

## How to read every item

- **EXISTS (verified)** - live code or a landed doc on main, with its
  commit or test evidence. Not re-derived from memory; verified 24 Nov
  2026.
- **PROPOSED** - a staged plan for later work, in roadmap order. No
  decision has been made by implementing it.
- **OPEN (gated)** - held for Ninad's explicit decision, device time, a
  credential, or verified official licensing. Nothing proceeds past a
  gate silently.

Standing constraints applied to every area: existing resources only, zero
new spending (no compulsory subscription, API, hosting or relay); local
and private data stays local unless separately authorized; no unapproved
model download or asset/license addition; no quality or performance claim
without measured benchmarks; the original M0-M9 order and all release and
security artifacts are preserved; no APK build or public release in this
slice.

## Traceability matrix

| Area | Existing foundations (EXISTS, verified) | Needs implementation (PROPOSED) | Dependencies | Acceptance tests | OPEN gates |
|---|---|---|---|---|---|
| 1 Device connectivity/access | `src/device-access.js` policy core (M8 s2, `9bb1991`); `src/integrations.js` registry (M8 s1, `911f4e7`); `src/secure-store.js` vault; `src/chat-history.js` device-only storage; Gate 2 audit + emergency stop | QR pairing, durable device identity/keys, secure reconnect; LAN/direct P2P transport; sync engine (context on demand, permitted attachments auto, encrypted, resumable/dedup/integrity, conflict versioning); honest offline queue; task-aware power manager; DAC UI wiring | OS key/crypto APIs; mDNS/Bonjour discovery; two physical devices | Pairing/reconnect tests; wire-encryption contract tests (no plaintext); power assertions released after task; queue reports completed/queued/blocked only; DAC revocation stops cross-device access at once | Two-device testing time; remote wake/unlock scope per official OS APIs; whether any EXISTING free relay resource qualifies; key backup/rotation policy |
| 2 Autonomy | Gate 2 slices 1-4: tool registry, policy engine, approval desk, audit, orchestrator, persistence, run-driver Stage A (`3j.9`); harmless tools notifications/reminders/ics; emergency stop | Goal-driven objectives; independent routine execution; risk-based approvals; extended error recovery; long-running until done/blocked; parallel workers with isolation/locks; immediate interruption; hybrid orchestrator+specialist; controlled self-improvement in isolated workspace with tests/rollback; independent permission broker; idempotency/checkpoints | Run-driver Stage B/C review gates; capability boundary rule (no shell/fs/browser/OS-unrestricted tools, no model-driven execution) | Prompt-injection corpus before any grant widening (existing gate); approval precedes every sensitive execution; interruption is immediate; worker isolation enforced by test; checkpoints idempotent; reports distinguish completed vs queued vs blocked | Stage B and Stage C await explicit review (run-driver work PAUSED at the proposal per Ninad, 24 Nov); any tool beyond the harmless trio; worker-parallelism design; self-improvement scope |
| 3 AI/cost | M0+M1 COMPLETE (model selection, registry+router, health status, contract tests, faults); verified registry metadata + capability vocabulary (`19704a9`); default `llama3.2:latest`; M6 STT `small.en` + s2 transcription language wired to the `language` setting (whisper.cpp table verified live 24 Nov); wake-word research + DISABLED; Gate 1 benchmark scaffold | Continue model track inside M0-M9 order; no new spend; no silent paid fallback; no unapproved downloads | Gate 1 device time for any performance claim | Existing contract/router tests; quality claims only from measured runs | Area 3 detailed routing/privacy/offline choices UNRESOLVED (not invented here); `gemini-2.0-flash` VERIFIED RETIRED June 1, 2026 (both official sources read live 24 Nov; registry marks it, the gateway refuses it fail-closed as `cloud_model_retired`, no silent substitute); replacement cloud model is Ninad's call; wake phrase + self-training vs training-service; M4 four decisions for memory-context integration |
| 4 Memory | `docs/M2_MEMORY_V2_DESIGN.md` + measured harness (recall 97.2%, MRR 0.793 on the 18-query corpus); pure ports `src/memory-retrieval.js`, `src/memory-store.js` unwired with contract tests; `docs/M4_MEMORY_DECISIONS.md` | Wire store+retrieval into the ask path AFTER decisions; full view/edit/delete/export/restore; automatic controlled memory creation; cross-device relevant-context sync (ties to Area 1) | The FOUR open decisions; Area 1 transport for sync | Harness numbers are the measured baseline; contract tests pin the wiring lock, sensitive gate, determinism, injection inertness; sync integrity tests come from Area 1 | Decision 1 sensitive-entry convention; Decision 2 synonym-map shipping; Decision 3 per-task budgets (chat 12 / screen 6 / goal 8 / vision 0) as product defaults; Decision 4 embeddings revisit threshold. Confirmed guardrails meanwhile: sensitive entries fail closed to session-only until a safe marked persistence exists; an explicit per-entry sensitivity mark is NOT consent; screen-derived requests retrieve ZERO memory |
| 5 Integrations | `src/integrations.js` strict manifests + least-privilege scope catalog + single `authorizeCall` door; DAC capability catalog | Broadest technically possible via supported methods: UI-first operation (accessibility, computer vision, keyboard/pointer, browser controls) where the OS and app permit; official APIs/OAuth as the catalog spine and fallback where UI is unavailable or unsafe; automatic discovery of compatible integrations, asked before connecting; permitted alternatives, otherwise queue | Each connector verified against its official API before any capability claim; OS-permitted UI automation (desktop-only in the DAC today) | Manifest/scope tests exist; per-connector contract tests before wiring; discovery never auto-connects (test); alternatives tried before queueing | Which services enter the catalog first; UI-automation enable per platform; any computer-vision component needs an approved, verified asset; no account connection before the user grants it |
| 6 Notifications | Gate 2 slice 4 pure notifications module (never sensitive); `src/agent-notifications*.js` surfaces; M5 s4 quiet-hours visibility in the schedules panel | Full event notification; urgency categories low/normal/high/critical; channels: native desktop/mobile, in-app, voice, authorized messaging; sent/delivered/read tracked separately; cross-device duplicate suppression; controlled proactive assistance | Area 1 pairing for dedup; Android packaging (Area 8) for mobile push; messaging channels are user-authorized only | Channel tests per surface; quiet-hours respected (M5 s4 precedent); no duplicates across paired devices (test); unapproved sources refused (test) | Which messaging services are authorized; mobile push route; dedup design after pairing exists |
| 7 UI/personalization | Inherited decisions (from yesterday's ChatGPT conversation and prior requirements, NOT re-asked): full desktop app/workspace plus optional floating companion; mobile-first Android; adaptive natural personality; voice/agent/computer/chat/command-centre modes; task controls visually and via natural language; visible indicators; activity history; emergency stop; movable/resizable/customizable floating panel | Workspace views per M8 (conversations, tasks, memory, tools, files, workflows, settings, permissions, activity, models, integrations); floating companion move/resize/remember; mode shell after Gate 1 | M8 workspace work; Gate 1 for the Android shell | UI tests per view; indicator contracts (M6/M7 precedents); emergency stop reachable from every mode | Finer details of the inherited direction are marked INHERITED / NEEDS SOURCE RECONCILIATION: the ChatGPT conversation content is not in this repo thread, so unspecified details stay inherited, not re-decided here |
| 8 Install/deploy | `updater.js`, `update-policy.js`, `scripts/build-dist.js`, electron-builder config; Capacitor Android packaging (`android/`, `capacitor.config.json`); two debug-signed preview APKs exist as testing-only artifacts | Staged plan only, no decisions claimed: desktop packaging matrices; Android packaging after Gate 1; model management (downloads only on explicit approval, with disk-space and integrity checks per the Ollama onboarding precedent); update/migration/recovery paths | Gate 1; release-signing decisions; distribution policy | Package smoke tests per platform; update rollback test; migration test on a copied real database | Release signing keys; Play Store policy position; public release requires Ninad's explicit approval (standing rule: nothing public before review); no APK build in this slice |
| 9 Security/privacy | Gate 2 security core (policy engine refuses ungranted calls, tested); approval desk (payments/purchases/destructive deletion/binding submissions denied without fresh explicit approval, tested); audit; emergency stop; fail-closed secure storage; prompt-injection corpus; provider-fault sanitization; DAC no-bypass stance | Threat model document; at-rest and in-transit encryption specifics (ties to Area 1); secrets policy; deletion semantics across devices; audit completeness review | Area 1 for transport crypto; Area 4 for deletion semantics | Injection corpus stays green before any grant widening; fail-closed tests; audit poisoning tests (any audit append failure poisons the run) | Threat-model review is Ninad's; anything that binds the product legally stays his |
| 10 Test/release | node:test suite (877/877 at the M6 s2 landing) + selftest; two CI workflows (macOS+Linux, CI); benchmark selftest wired into `npm test`; Gate 1 validation matrix (Android + desktop halves); provider contract tests; M9 coordinated-release brief exists as a docs-only PROPOSAL (`docs/M9_RELEASE_BRIEF.md`) - M9 itself still needs Ninad's explicit definition before any implementation | Physical-device test plans; performance/battery budgets from Gate 1 measurements only; release signing and versioning discipline (preview-tag precedent); release checklist | Device time; signing credentials; release approval | Full suite + selftest + both CI workflows green per landing (current standing practice); measured numbers only for performance claims | Public release needs explicit approval; signing; device time |

## Per-area stage notes

### Area 1 - device connectivity/access

Stages: (1) pairing and device identity: one-time QR pairing, durable
per-device identity keys held in the OS credential vault via the existing
secure-store pattern, secure reconnection with revocable trust; (2)
transport: local Wi-Fi/direct P2P preferred over the OS's own discovery;
a relay is used ONLY if an existing no-new-spend resource exists and
Ninad names it, otherwise devices report offline honestly; (3) sync
engine: relevant context on demand, all permitted attachments automatic,
encrypted transfers, resumable, deduplicated, integrity-checked,
conflict detection with versioning; (4) power manager: keep/wake the
laptop only for laptop-specific tasks, release power assertions
afterwards, remote wake/unlock only via official secure OS/hardware APIs,
never generic or bypassed; (5) DAC surface: per-capability/per-app
grants, exact scopes, visible indicators, audit, instant revocation,
emergency stop, no blanket startup prompts, no sandbox bypass - the
policy core EXISTS; the UI shell is PROPOSED.

Gated on: two-device test time; official-API verification for wake/unlock
per platform; Ninad's answer on any existing free relay resource; key
backup/rotation policy. Independent local memory per device and on-demand
context sync are the confirmed requirement; nothing syncs before the
transport exists.

### Area 2 - autonomy

Stages: (1) permission broker as an independent component the model
cannot influence (risk can never be downgraded by the model), layered on
the existing policy engine; (2) goal-driven objectives and routine
execution on the run-driver, which stays PAUSED at the Stage B proposal
until Ninad's separate explicit review; (3) worker isolation and locks,
idempotency and checkpoints; (4) extended error recovery and
long-running tasks that report completed vs queued vs blocked; (5)
parallel workers and immediate interruption; (6) controlled
self-improvement confined to an isolated workspace with tests and
rollback, approval before critical installs, replacements or
deployments.

Gated on: Stage B/C review; capability boundary rule (no shell,
filesystem, browser, or OS-unrestricted tools; no model-driven
execution); parallelism and self-improvement designs.

### Area 3 - AI/cost

Current code is fully verified (see matrix). The detailed local/cloud/
hybrid routing, privacy and offline choices remain UNRESOLVED and are
recorded as unresolved, never assumed. Language-model facts recorded
24 Nov 2026: default stays `llama3.2:latest`; STT starts at
whisper.cpp `small.en` with multilingual models including Hindi
selectable later; wake word is a REQUIRED product feature that stays
disabled until a fully verified, redistributable, offline engine+model
path exists (the safe proposal on record: a CompanionDesk-owned model
trained on synthetic speech over openWakeWord's Apache-2.0 feature
extractor; the wake phrase and self-training vs training-service choice
are unresolved; no non-commercial, proprietary, or unverified assets).
No unapproved model download; no silent paid fallback; quality claims
only from Gate 1 measurements.

### Area 4 - memory

Fully confirmed requirements: scope everything useful; storage local on
each device; automatic controlled memory creation; full
view/edit/delete/export/restore; cross-device context sync relevant and
on demand; all permitted attachments auto-sync. M4 guardrails confirmed:
sensitive entries fail closed to session-only until a safe marked
persistence exists; an explicit per-entry sensitivity mark is not
consent; frozen synonym map; budgets chat 12, screen 6, goal 8, vision
0; screen-derived requests retrieve zero memory; embeddings deferred
pending real-corpus measurement only, no automatic downloads. The four
open decisions in `docs/M4_MEMORY_DECISIONS.md` gate wiring; the pure
store/retrieval ports and their contract tests already exist unwired.

### Area 5 - integrations

UI-first like a human operator, using accessibility, computer vision,
keyboard/pointer, and browser controls where the OS and the target app
permit; official APIs/OAuth as the catalog spine and as fallback where
UI interaction is unavailable or unsafe; never assume every service is
controllable. Risk-based approval; automatic discovery of compatible
integrations but a question before any connection; if unavailable, try
permitted alternatives, otherwise queue. Platform restrictions are
respected; no account connection or access before the user grants it.
Every new connector is verified against its official API before any
capability claim, and nothing is invented.

### Area 6 - notifications

All events, fixed urgency categories (low/normal/high/critical), all
supported channels (native desktop/mobile, in-app, voice, and authorized
messaging), device quiet hours respected, controlled proactive
assistance, sent/delivered/read tracked separately, no duplicate
notifications across devices, no unapproved sources. Foundations exist
as pure modules; channel wiring and mobile push follow Areas 1 and 8.

### Area 7 - UI/personalization

Inherited from Ninad's established decisions (yesterday's ChatGPT
conversation and prior requirements), not re-asked and not invented:
full desktop app/workspace plus optional floating companion;
mobile-first Android experience; adaptive natural personality;
voice/agent/computer/chat/command-centre modes; task controls both
visually and via natural language; visible indicators; activity
history; emergency stop; movable/resizable/customizable floating panel.
Any finer detail not recoverable here is marked INHERITED / NEEDS SOURCE
RECONCILIATION and is not re-decided in this doc.

### Areas 8, 9, 10 - install/deploy, security/privacy, test/release

These are open planning domains, mapped onto the existing milestones
with staged plans proposed above; no decision is claimed as made.
Android/desktop packaging, model management, updates, migration and
recovery (8); threat model, encryption, secrets, prompt injection, audit
and deletion (9); physical device tests, CI, performance and battery,
release signing and versioning (10). No APK build and no public release
belong to this docs-only slice; the standing rule that nothing becomes
public before Ninad's review governs any future one.

## Conflicts and precedence

Where an Area requirement and the governing roadmap differ in sequence,
the roadmap's order and gates stand and the Area requirement is recorded
here as a staged addition. No milestone is renumbered; no M9 is invented
(defining one remains Ninad's explicit call, per the roadmap's numbering
note). All release and security artifacts are preserved. This file is
traceability, not authority: implementation slices still land one at a
time, each independently reviewed, with the full suite and selftest
green and both CI workflows verified on the live head.
