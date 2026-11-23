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
(`src/model-selection.js`). Done 23 Nov 2026: local conversation history in
the ask flow — conversations with rename and confirmed delete, device-only
storage (same sql.js database on desktop and web), the local model sees the
last ten turns, the cloud fallback never does, and the overlay keeps its
single-shot behavior (`src/chat-history.js`). Done 23 Nov 2026: the
optional Gemini key behind secure storage — Electron safeStorage in the OS
credential vault, 0600 ciphertext file under userData, main-process-only
decryption via a lazy key getter, header-based key transport (never a URL),
masked status across IPC, fail-closed when OS encryption is unavailable or
(on Linux) the safeStorage backend is not a real secret service (basic_text,
unknown, or no backend query API all fail closed),
explicit save/test/remove UI with clear opt-in wording, and web/Android key
setup reported unsupported instead of insecure fallback
(`src/secure-store.js`). M0 is COMPLETE. Acceptance: the suite stays green;
no existing feature changes behavior.

## M1 - Intelligence core (2-3 wks, estimate)

FIRST SLICE DONE 23 Nov 2026: provider/model registry
(`src/provider-registry.js`) and deterministic task router
(`src/task-router.js`), both pure and unit-tested (19 router/registry tests).
The router is policy, not heuristics: vision/screen tasks are local-only;
cloud routes need the task to be cloud-eligible, privacy mode to allow it,
explicit cloud_enabled in settings (default false), explicit consent, a key,
a provider known healthy (unknown health refuses), and a verified cloud
capability; a saved key alone routes nothing; uninstalled models are never
auto-downloaded. `src/ai.js` carries the explicit
`cloudEnabled` gate (default false), and since the 23 Nov 2026 review fix
the legacy `complete()` path is local-only: it predates the router and
carries no per-request consent, so it never transmits even with a key and
cloud_enabled present. The routed path (`completeRouted`) is the only route
to the cloud.
SECOND SLICE DONE 23 Nov 2026: deeper per-ask routing integration. The ask
and screen paths now route through the router with LIVE facts gathered per
request, under bounded timeouts (`src/ai.js` `completeRouted`/`routeTask`):
Ollama health and the installed-model list from one `/api/tags` probe, vision
capabilities from `/api/show`, the cloud model's capability from the
registry. The screen path forces privacy mode `local_only`, so a screenshot
can never reach the cloud. When the local call fails and the router says the
cloud may serve the ask, the UI shows a per-request confirmation whose
disclosure describes the EXACT payload that ask would send (review fix,
23 Nov 2026): with `cloud_personal` off the cloud prompt is minimized, so
the confirmation names the question, the assistant rules and the course/
due-date context pack and lists calendar, name, memories, activity patterns
as never sent; with `cloud_personal` on the cloud call receives the full
personal prompt, so the disclosure names calendar entries, the name and
selected memories, and activity patterns (when learn_from_activity is on)
as categories that may be sent. Conversation history and screenshots are
never sent in either mode, and the note about rate limits and possible
charges is always shown. Nothing is
sent until the user confirms, a decline leaves the question local and is
reported as the local failure, and nothing retries after a decline. Chat,
cloud and probe calls are cancellable (per-request abort reaches the network
and the streaming reader, `ai:cancel` IPC channel) and bounded (probe 1.5 s,
local chat 120 s, cloud 30 s by default); there are no retries anywhere.
The web/mobile bridge routes its asks through the same router and fails
closed: no key exists there, so the cloud can never arm.
Still planned in M1: hardware probe and lightweight/balanced/powerful
profiles (`src/hardware.js`), provider health checks surfaced in the status
UI. Acceptance: routing decisions unit-tested; no hardcoded model constants
in `src/ai.js`; contract tests per provider.

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
