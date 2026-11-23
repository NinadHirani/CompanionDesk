# CompanionDesk Implementation Roadmap

Status: **proposed** (M0 baseline). Supersedes `docs/COMPANIONDESK_ROADMAP.md`
and `docs/FEATURE_GAP.md` once approved; those files stay until then. Phases
are dependency-ordered with explicit gates. Every feature here is planned
unless stated as implemented; nothing in phases M1-M8 exists in the code yet.

## Phase gates

- **Gate 1 (Android intelligence).** The llama.cpp on-device POC and the
  secure desktop gateway POC must produce measured benchmarks (tokens/s, RAM,
  battery, thermals) on the OnePlus 12R before any Android AI architecture is
  committed.
- **Gate 2 (agent safety).** The typed tool registry, policy engine, approval
  cards, audit log, and emergency stop must be implemented and proven to
  refuse ungranted calls BEFORE any computer-control tool is built.

## Validation devices

OnePlus 12R (Android) and MacBook Air M1 (macOS) are validation targets, not
validated results. Nothing has been tested on them yet. Windows and Linux are
CI-verified only until real-machine testing happens.

## M0 - Product foundation

Done: the docs baseline (PR #10, main 2d349c5) and the stale-docs refresh
(`FEATURE_GAP.md`, `COMPANIONDESK_ROADMAP.md`, main c351aa3). Done 23 Nov
2026: user-configurable local model selection — separate `ai_model_local` /
`ai_model_vision` settings, selection only from models Ollama reports as
installed (no pull from settings), validated ids, safe fallback to the
defaults, and the cloud fallback never receives a local model name
(`src/model-selection.js`). Remaining M0: the Gemini key entry UI behind
secure storage (Electron safeStorage / OS keychain; web and Android
constraints designed first, never plaintext) and conversation history in the
ask flow. Acceptance: the suite stays green; no existing feature changes
behavior.

## M1 - Intelligence core (2-3 wks, estimate)

Provider/model registry (`src/providers/`), task router (`src/router.js`),
hardware probe and lightweight/balanced/powerful profiles (`src/hardware.js`),
health checks, timeout/retry/cancel formalization. Acceptance: routing
decisions unit-tested; no hardcoded model constants in `src/ai.js`; contract
tests per provider.

## GATE 1 - Android intelligence (3-4 wks, device time)

Work: Capacitor plugin wrapping llama.cpp via JNI with one quantized sub-1B
model; measure tokens/s, RAM, battery, thermals on the OnePlus 12R. Separately
a token-authenticated, LAN-only proxy in front of Ollama (which stays bound to
localhost; it has no built-in auth by default, to be re-verified). Exit: the
measurements decide Android's local-vs-remote default. Nothing is claimed
feasible until these numbers exist.

## GATE 2 - Agent foundation (3-4 wks)

Work: `src/tools/registry.js` (typed schemas, capability classes read-only /
reversible-write / sensitive / forbidden), `src/agent/orchestrator.js`
(plan, act, observe, verify, recover), `src/agent/policy.js` (enforcement
outside the model), `src/agent/audit.js` (append-only log), `src/agent/stop.js`
(global emergency stop), `agent_runs` table. First tools: notifications,
reminders, app open/switch/close (per-OS adapters), ICS events. NO shell or
filesystem tools in this phase. Acceptance: policy engine refuses ungranted
calls (tested); payments, purchases, destructive deletion, and legal or
binding submissions are denied unless fresh, explicit user approval
immediately precedes execution (tested); prompt-injection corpus passes
before any grant widening.

## M4 - Memory v2 (1-2 wks)

FTS or keyword index over the existing markdown About-me file (which stays
canonical); selective per-task retrieval; Remember/Forget commands; consent
gate for sensitive entries. Embeddings are deferred until FTS/keyword
retrieval quality is measured and found lacking. Prerequisite check: whether
sql.js's WASM build includes FTS5.

## M5 - Proactive behavior (1-2 wks)

Main-process scheduler persisted in the DB; OS notifications for confirmed
deadlines and user-approved reminders; quiet hours; per-scope user controls.
No network. Proactive actions run only on schedules the user set.

## M6 - Voice v2 (2-3 wks)

Multilingual whisper model option wired to the existing `language` setting;
OS-native text-to-speech first (Piper deferred pending verification of its
successor project); wake word only after the licensing decision, behind a
separate auto-listening toggle, off by default, visible mic state, immediate
stop; Android foreground service compliant with platform rules.

## M7 - Screen understanding v2 (2-3 wks)

Session-scoped live observation on desktop: opt-in, visibly indicated,
pausable, app exclusions, configurable interval, local processing only.
Android MediaProjection POC honoring its per-session consent requirements.

## M8 - Integrations and workspace UI (open-ended)

Plugin API with connect/disconnect, least-privilege scopes, revocation;
connectors chosen by Ninad and verified against official APIs before any
capability claim; workspace views (conversations, tasks, memory, tools,
files, workflows, settings, permissions, activity, models, integrations);
floating companion move/resize/remember/customization.

## Test strategy

Existing node:test pattern throughout; contract tests per adapter; a
prompt-injection corpus gating tool-grant widening; platform matrix (macOS
real device when available, Windows/Linux CI-only, Android on the OnePlus
12R). No phase merges without its acceptance criteria met and the full suite
green.

## Provisional technology note

All runtime, model, wake-word, and TTS choices in this roadmap are
provisional. Each is confirmed only by its own POC or license review; the
architecture keeps every one of them behind a replaceable interface.
