# CompanionDesk Implementation Roadmap

## Governing programme order (evidence-based, 24 Nov 2026)

This file is the PRIMARY product programme and it governs the sequence.
Main head at this writing (24 Nov 2026 evening): `2ca99d4`; the summary
table below was refreshed in the next commit, which is docs-only.

| Phase | Status | Evidence |
|---|---|---|
| M0 product foundation | COMPLETE | 23 Nov 2026 slices on main (model selection `model-selection.js`, conversation history `chat-history.js`, Gemini key in secure storage `secure-store.js`); docs baseline main `6e7a975`; suite green throughout |
| M1 intelligence core | COMPLETE | completion head `bccfa75` is an ancestor of main (verified `git merge-base --is-ancestor` 24 Nov 2026); six slices landed 23 Nov 2026 incl. provider health (`provider-status.js`, slice 4) and per-ask routing with live Ollama probes (slice 2); review fix `d36dc01` also an ancestor |
| GATE 1 Android intelligence | PREPARED, NOT RUN | repo-only scaffold `experiments/android-inference-benchmark/` (metrics, fairness rules, acceptance criteria, owner runbook, desktop matrix below); no device measurement exists; blocked on physical OnePlus 12R time |
| GATE 2 agent foundation | IN PROGRESS (security workstream, SUPPORTS the product phases) | slices 1-4, persistence wiring, 3j.3-3j.6 notification gates, run-driver Stage A (3j.9), the scheduling gate (schedule_create, 3j.11, D-S1 approved 24 Nov), the run entry point (3j.12, D1 option a approved 25 Nov) and run-driver Stage B (3j.10, approved and implemented 26 Nov 2026: the calendar_upcoming read-only projection plus grant/revocation/hydrate audit entries) implemented; the enable step landed 26 Nov 2026 (approved by Ninad the same day, D-B2 resolved: grant path (a)): main.js registers EXACTLY ONE tool, the scheduling gate's schedule_create (capability sensitive, guardrails tested in tests/gate2-scheduling-enable.test.js), while the Stage B calendar_upcoming tool stays unregistered, the run entry point fires nothing (requestRun has no caller in this build; D-S2 decided DEFER 25 Nov 2026, see docs/D_S2_DECISION_BRIEF.md), and the production registry carries exactly that one registered tool; the file-output gate (3j.13, D-F1/F2/F3 approved and implemented 26 Nov 2026: the pure validation/policy layer with the injected io adapter contract, root unset by default) is implemented but NOT registered or wired; the Gate 4 file-access gate (Ninad's decision C, 26 Nov 2026 evening: src/agent-tool-file-access.js, a pure decide core with target visibility, overwrite/delete confirmation gates, unknown-action/relative-path refusals, scoped roots unset by default and an explicit OS-sandbox note) landed with its EXECUTION SLICE the same night (f239a93, suite 1323/1323): every operation runs through the policy first, a refusal never reaches the io layer, the executor probes the real existence once before refusing a write as an overwrite (a genuinely new path proceeds, an existing one still demands confirmed), deletes still require confirmed, OS errors surface verbatim (code + message, performed: true, no silent destructive operations), and the write is byte-capped at 64 KiB (the real adapter caps reads at 256 KiB and listings at 500 entries). main.js registers it as the SECOND tool, mirroring the scheduling gate's enable step (registration alone lets no run start: requestRun still has no caller, and the sensitive class forces a fresh one-time approval per call), and wires the real fs adapter through it; the guardrail tests carry exactly two registration literals, and the Stage B calendar_upcoming tool stays unregistered. On 26 Nov 2026 Ninad approved the remaining decision-sheet defaults (schedule_create enable with guardrails, file-output D-F1/F2/F3 with the root unset by default, M8 schemas-first with no connectors until he names services, M4 sensitive sidecar markings with sensitive content session-only, M6 OS-native TTS only with piper1-gpl deferred) and explicitly deferred M7 (capture engine) and M9 (release readiness); their implementation slices follow in that order. Per Ninad's 24 Nov direction the run-driver work proceeds only through these approved slices |
| M4 memory v2 | DECIDED + WIRED (slices 1-2) | the owner resolved all four decisions 24 Nov 2026 (`docs/M4_MEMORY_DECISIONS.md`, Resolution); `189e3a7` wired the defaults (measured ranker in the persona/chat path, budgets chat 12/screen 6/goal 8/vision 0, screen-derived asks pull zero memory, fail-closed sensitive storage gate). WIRED SLICE 2: `src/memory-session.js` runs the v2 store contract (`src/memory-store.js`) as the product's in-session memory view; every memory operation (list, add, forget, suggest, decide, onboarding, chat ask path, screen ask) flows through it. The About-me file stays canonical with SINGLE-bullet writes (manual edits survive; the contract's toMarkdown is deliberately not used for persistence) and sync-on-demand stat freshness replaces the per-ask re-read with the same guarantee. Session-only sensitivity marks survive refreshes within a session; `persistSensitive()` stays fail-closed (`sensitive_storage_blocked`) and no product surface passes sensitive entries yet. The owner sub-decision on sensitive state is RESOLVED (26 Nov 2026, decision-sheet item 6): a session-only sidecar (`src/memory-sidecar.js`), deliberately NO on-disk format. UI SLICE LANDED (26 Nov 2026, Ninad explicitly reopened the M2/M4 UI paths for this scoped slice only): `renderer/memory-panel.js` plus the pure shaper `src/memory-view.js` make the mark/persist interfaces explicit: mark/unmark with visible status lines ([saved] / [session-only, not saved] / [sensitive]; a mark on a saved bullet is labelled mark-session-only, a restart drops it), session-only adds behind an explicit off-by-default control, the fail-closed `persistSensitive` refusal surfaced verbatim through a try-to-save control, consent-gated retrieval with a per-search consent control (default off) and the budget/matched-terms header served from the frozen BUDGETS, textContent-only rendering with aria labels and a live status region; channels memory:items/mark/persist/search wired main->personal->session, `persisted()` provenance on the session, and `addMemory` passes user-commanded sensitive entries only. ERROR-SAFETY/CONSENT COMPLETION (26 Nov 2026 evening, four red-first panel-only slices, no closed file touched): `d48f07f` row actions degrade via a guarded `outcomeText` and every button carries an in-flight double-click guard; `d7247f5` mount and search degrade honestly when the shaper is partial and the add path announces a missing bridge; `c22625a` per-search consent resets in try/finally after every search attempt with the empty-query boundary preserved; `84d8e75` the search path announces a missing bridge like add. The suite grew 1261 to 1268 with nine behavioral tests in tests/memory-panel-errors.test.js; both CI workflows green on every commit (45818563456/45818563487, 45827758579/45827758304, 45828714608/45828714590, 45829339614/45829339623). Still NO on-disk sensitive format and no embeddings downloads. STILL GATED: nothing in the M4 UI lane |
| M5 proactive / M6 voice / M7 screen understanding v2 / M8 integrations + workspace UI | SLICES LANDED, MILESTONES OPEN | M5 complete as specified (slices 1-4, scheduler + panel + settings + quiet-hours visibility). M6 slices 1-4 landed incl. wake milestone 2 (dynamic-name engine, platform gate, honest listener state; training pipeline, provenance `docs/WAKE_PROVENANCE.md`, reproducible eval `scripts/wake/repro_eval.py`); wake stays default-off pending physical mic validation on macOS/Windows/Linux/Android and is out of the milestone lane unless Ninad reopens it. The TTS engine decision resolved 26 Nov 2026 (decision-sheet item 7): OS-native speechSynthesis ONLY, piper1-gpl deferred and unbundled, guarded by tests/m6-tts-decision.test.js. M7 policy slice + observation-session machine landed; the capture engine stays unbuilt pending real permission flows and device testing. M8 slices 1-3 landed (integrations registry, Device Access Centre policy core, workspace-views groundwork); M8 slice 4 landed 26 Nov 2026 (the schemas-first wiring Ninad approved the same day, no connectors): six further view schemas wired in src/workspace-views.js, each mirroring one owning module's rows exactly and none touching a closed file (tasks <- agent-reminders, memory <- memory-session.items with sensitive-flagged rows skipped until M4 defines the workspace treatment, tools <- tool-registry.list, permissions <- device-access.list, activity <- audit-log entries incl. the append-allowlisted extras and chain fields, integrations <- integrations.js list); files, workflows and models got their owning row stores on 26 Nov 2026 evening (Ninad's Gate 8 decision A: src/workspace-stores.js pure bounded stores with per-field types, enums, frozen rows and bounded search; three stores created in main.js, three schemas wired in workspace-views.js, providers wired, stores start EMPTY with no auto-scan/no auto-exposure/no model downloads, in-memory this slice) and settings stays unwired because its owning module (settings.js) is in the m84 checkpoint-closed set; real connectors and floating-companion customization still await the owner's picks; the connector catalog/settings CORE landed 26 Nov 2026 evening (Ninad's Gate 2 decision, 22:10 IST: free-first discovery catalog of 20 shipped entries, extensible reviewed registration, explicit per-connector scopes with per-scope classes, full lifecycle connect/disconnect/reconnect/revoke/readmit, single-use approval gates for write/send/delete/external/sensitive scopes, opaque credential references only (keychain:/vault:/credential-store:), cost and limits surfaced before activation, AUTO_CONNECT false, audit on accepted changes only) as src/connectors.js with 12 red-first tests in tests/connectors-catalog.test.js; it is unregistered in main.js and NOTHING is connected; naming a real service and an explicit per-connector activation remain Ninad's calls |

Verified state: full `npm test` on 24 Nov 2026: 950/950 pass,
selftest PASS (937/937 at `2ca99d4`, CI runs 45426721777, 45426721768;
950/950 from the M4 store-contract session slice, CI runs 45430221369
and 45430221679). The same day also landed, each with both workflows green: M4
wiring slice `189e3a7`, wake milestones `4547f7a`, `a624d5e` and
`0125061`, the docs-accuracy refresh, and the M4 store-contract slice.
Earlier verified snapshot: `897b5d0` 735/735 (runs 45353283588,
45353283702); last src-affecting commit there was Stage A `83dbcda`
(Android APK run 45344402037).

History note: the branch `companiondesk/m0-product-foundation` (head
`a080573`) was the M0 docs review vehicle. Nothing on it is lost: its
ARCHITECTURE_DECISIONS.md, RISK_REGISTER.md and CLAUDE_HANDOFF.md are
byte-identical with main, and its COMPANIONDESK_ROADMAP.md and
FEATURE_GAP.md were superseded the same day by the 23 Nov stale-docs
refresh on main. The branch stays as a historical artifact, NOT merged.

Numbering note, stated honestly: this roadmap defines M0, M1, GATE 1,
GATE 2, M4-M8. There are no M2/M3 sections (the memory-v2 design doc
carries the "M2" name; its phase here is M4) and no M9 definition exists
in this file. Neither is invented here: if a coordinated-release phase
is wanted as M9, that needs Ninad's explicit definition first. A
docs-only proposal brief now exists (`docs/M9_RELEASE_BRIEF.md`); it is
not a definition and implements nothing. Release groundwork the phase would
need is landing independently of it: a CHANGELOG and a first-run
privacy-defaults acceptance test landed 25 Nov 2026; M9 itself stays
undefined.

Traceability addendum (24 Nov 2026): Ninad's confirmed Areas 1-10
requirements are integrated as ADDITIONS via
`docs/ARCHITECTURE_DECISIONS_INTEGRATION.md`, which maps each area onto
the milestones below with exists/proposed/open status and open gates.
This roadmap remains governing and unchanged in order; that file is a
traceability addendum, not a replacement, and carries no code.

Detail (still accurate): Gate 2 slice 1 (agent safety
foundation) and its hardening are pure, isolated modules with NO product
wiring, NO tools registered beyond test fixtures and NO UI or IPC. Slice 2
(persistence) is additive-only storage, same boundary. Slice 3
(orchestrator) is a pure declarative run loop over the slice 1/2 modules
with approval pauses, stop pauses, bounded retries, skip/abort recovery
and a full audit trail, still with no wiring and in-memory run state only;
hardened after Ninad's review (e699c64) so ANY audit append failure
poisons the instance and every transition is log-before-commit. Slice 4
(24 Nov 2026) adds the first harmless tools: notifications, reminders and
ics as pure, unwired modules (reversible_write/reversible_write/read_only,
never sensitive; a standing grant suffices, no per-call approval; nothing
sends, delivers, schedules, wakes or writes files). The M1 slice 6
diagnostics were independently re-audited and hardened on 24 Nov 2026
(strict errno allowlist and strict status normalization in
classifyFailure; every diagnostic path verified to pass through the shared
fault() sanitizer). Earlier prep/harness work (slice-6 sanitizer
hardening, Gate 1 repo-only benchmark scripts + selftest and comparison
assembler, M4 memory-v2 harness) remains harness only, NOT product
memory-v2 wiring. No actual OnePlus device measurements exist). Supersedes `docs/COMPANIONDESK_ROADMAP.md` and
`docs/FEATURE_GAP.md` once approved; those files stay until then. Phases
are dependency-ordered with explicit gates. Phases M2-M8 below are planned
unless stated as implemented. IMPLEMENTED so far (see the status table): M0,
M1 and M5; M4 wired slices 1-2; M6 slices 1-5; M7 slices 1-2; M8 slices 1-3.
Every unlisted remainder is planned behind the gate its section states.

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
(`FEATURE_GAP.md`, `COMPANIONDESK_ROADMAP.md`, main c351aa3); the docs
baseline is now main `6e7a975` (23 Nov 2026). Done 23 Nov
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
THIRD SLICE DONE 23 Nov 2026: local hardware detection and profiles
(`src/hardware.js`). Strictly local and read-only: no shell commands, no
network, no telemetry; the desktop main process reads only the OS's own APIs
(total/free memory, logical cores, platform, arch) once at startup, and the
web build reads the browser's coarse hints, always labelled approximate
(`navigator.deviceMemory` is a rounded-down bucket and is never presented as
exact). GPU/NPU stay unknown unless a safe built-in API reports them.
Renderers receive only sanitized facts: coarse memory buckets, no exact
bytes, no architecture, no free-memory reading, so the settings view cannot
become a device fingerprint (tested). Profiles lightweight/balanced/powerful
have documented thresholds (powerful: >=16 GiB AND >=8 logical cores;
balanced: >=8 GiB AND >=4; unknown or malformed readings land on
lightweight, the conservative end). A new `hardware_profile` setting
(auto/lightweight/balanced/powerful, default auto) steers ONLY the DEFAULT
model choices when the user picked none (`chatFallbackForProfile`), and
Settings shows a recommendation that names only models already installed
(`recommendedForProfile`); an explicit model choice always wins and nothing
is ever downloaded.

FOURTH SLICE DONE 23 Nov 2026: provider health surfaced in the status UI
(`src/provider-status.js`, the `provider:status` channel). One read-only,
on-demand snapshot in Settings: Ollama reachable/not running/unknown; the
selected chat model installed or missing; the vision model's capability
verified, unknown, or unreachable; the cloud fallback distinguished as off,
key saved but disabled, enabled without a key, armed (enabled + key + vault),
or enabled with no secure storage; and credential storage available,
unavailable, or unknown (web/Android report unavailable and never store key
material). Built ONLY from the existing bounded local probes and the vault's
masked booleans - the builder does no I/O and NEVER contacts the cloud;
Gemini's reachability is probed only when the user explicitly tests the key
or an already-consented cloud request runs. No polling loops, no telemetry;
a manual Refresh button with loading, error, and empty states; the list is
aria-live so screen readers hear updates. Tests pin the state machine, the
fail-closed vault rule, malformed-input conservatism, and that no key
material can appear in the output.

FIFTH SLICE DONE 23 Nov 2026: provider contract tests against scripted
fake servers (`tests/provider-contracts.test.js`,
`tests/fixtures/fake-servers.js`). No sockets, no real Ollama or Gemini:
the fixture IS the server side of each HTTP contract, replayed through
createAi's injectable fetch, recording every request so tests assert
exactly what the providers send. Covered: the exact Ollama chat contract
(method, URL, headers, body shape, system/history/images placement);
streaming NDJSON with split lines and malformed lines skipped; non-2xx as
named one-attempt errors (no retry anywhere); malformed /api/tags as "not
answering"; timeout and mid-stream abort semantics (tokens already seen are
kept; an abort never escalates to the cloud); the /api/show capability
contract and every unreadable shape staying null; the Gemini contract (one
part, system+prompt only, key in a header and never a URL, history and
images never sent); malformed/empty cloud payloads as named errors; the
consent gate (no cloud call and no cloud health probe without explicit
per-request consent); local_only as the named refusal after a local
failure; vision (the screen path) never reaching the cloud even fully
armed; unknown tasks refusing with only the local probe run; and no retry
after a refusal. Two narrow contract bugs the tests exposed were fixed in
src/ai.js: a router privacy refusal after a local failure now surfaces as
the named reason instead of the local error masking it, and a malformed
cloud payload reads as `gemini_bad_response` instead of a raw parser error.

M1 slice 6 (23 Nov 2026): typed, sanitized provider fault diagnostics.
Every probe and provider-call failure maps to a fixed fault vocabulary
(unreachable, timeout, cancelled, http_error, malformed, model_missing,
capability_unknown, capability_unsuitable) in src/provider-faults.js; the
chat, vision, routing and Settings status paths carry it, and the fault
text never contains a raw server body, URL, prompt, image, key material or
file path. A caller cancellation during routing surfaces as the
cancellation it is: no retry, no cloud consideration. Probe behavior stays
read-only and on-demand, the strict router is unchanged (health must be
KNOWN true; unknown refuses), and the per-ask consent gates are untouched.

Review fix (23 Nov 2026): fault details are strictly whitelisted (a
3-digit HTTP status or an errno-style network code, at most 32 characters;
anything else drops the detail) and every fault crossing the status view is
normalized through that sanitizer, fail closed.
M1 is COMPLETE (23 Nov 2026; completion head `bccfa75`, where the suite
stood at 411 tests). The current baseline in the Status header carries the
verified head, the current test count (including the offline memory-v2
harness tests) and the CI run ids.
Acceptance verified: routing decisions unit-tested; no hardcoded model
constants in `src/ai.js` (defaults come from the provider registry);
contract tests per provider (scripted fake servers for Ollama
chat/vision/tags/show and the Gemini REST path); the fault-detail
sanitization review fix is merged (d36dc01) with adversarial tests, and
docs were reconciled to this state.

## Language-model backlog reconciliation (24 Nov 2026)

Every backlog item below was re-verified against LIVE source and tests on
main `9bb1991` (not from memory), then the next safe model slice was landed
as M1 follow-on work (see below). Nothing in the governing programme order
changed; no phase was rewritten.

| Backlog item | Verified status on main `9bb1991` | Evidence |
|---|---|---|
| M0 model registry + routing foundation | COMPLETE | `src/model-selection.js`, `src/provider-registry.js`, `src/task-router.js` + their tests |
| M0 configurable local model selection | COMPLETE | separate `ai_model_local` / `ai_model_vision` settings, installed-model-only picker, safe fallback (`src/model-selection.js`, `tests/model-selection.test.js`) |
| M0 Gemini key configuration + fallback | COMPLETE | `src/secure-store.js` (OS credential vault, fail-closed), explicit `cloudEnabled` gate default false, per-request consent in `completeRouted` (`src/ai.js`, `tests/ai-routed.test.js`, `tests/secure-store.test.js`) |
| M0 conversation history | COMPLETE | `src/chat-history.js` device-only storage, last ten turns local-only, cloud never receives history |
| M1 provider health monitoring | COMPLETE | `src/provider-status.js` read-only on-demand snapshot (`tests/provider-status.test.js`); health stays KNOWN-true-required in the router |
| M1 provider routing | COMPLETE | deterministic policy router, vision local-only, cloud needs eligibility+consent+key+known-healthy+verified capability (`tests/task-router.test.js`, `tests/provider-contracts.test.js`) |
| M1 typed provider faults | COMPLETE | `src/provider-faults.js` fixed vocabulary, sanitized details (`tests/provider-faults.test.js`) |
| Default Ollama model | UNCHANGED | still `llama3.2:latest` (`Registry.DEFAULTS.localChat`, `model-selection.js` default) |
| Reasoning / coding / tool-use capability | NEWLY RECORDED (24 Nov 2026) | fixed capability vocabulary + verified metadata in `src/provider-registry.js`; reasoning/coding remain UNRECORDED for all current ids (no verified source claims them); `tool_use` verified for the cloud id only |
| Context/memory integration | DESIGN + HARNESS ONLY | M4 memory v2 is gated on FOUR open decisions; product wiring stays blocked until Ninad decides |

Exact last completed model task before this slice: M1 slice 6 typed provider
fault diagnostics + review fix `d36dc01` (M1 complete at `bccfa75`, 23 Nov
2026). Exact next model task after this slice: still gated, per the table
above (Gate 1 device benchmarking, M4 decisions); the registry metadata work
below is the follow-on groundwork that those decisions will consume.

### M1 follow-on slice: verified registry metadata (landed 24 Nov 2026)

`src/provider-registry.js` now carries primary-source-verified metadata
instead of permanent nulls, with the same fail-closed rule: every fact is
either verified (a `verified` object with date + exact source URLs + open
questions) or stays null, and no benchmark or quality claim is recorded
anywhere (quality comes only from measured Gate 1 runs).

- `llama3.2:latest`: Llama 3.2 Community License (custom, commercial, not
  OSI); 128k context (1B/3B text); capabilities now `['chat','multilingual']`
  (Meta's model card: multilingual text in/out, Hindi in the officially
  supported list, directly relevant to the Hindi-STT/voice direction).
- `gemma3:4b`: Gemma Terms of Use; 128K context for 4B; capabilities
  `['chat','vision','multilingual']` (Gemma 3 model card: image+text in,
  text out, 140+ languages, 896x896 images to 256 tokens).
- `gemini-2.0-flash`: 1,048,576-token input context; capabilities
  `['chat','tool_use','multilingual']` (function calling); license stays
  null (API model, no weights license fact). VERIFIED RETIRED (24 Nov
  2026 follow-up slice): Google's Gemini Enterprise Agent Platform
  release notes carry a June 01, 2026 breaking entry ("Gemini 2.0 Flash
  and 2.0 Flash-Lite are discontinued ... no longer available", model
  serving and Provisioned Throughput both), and the official Gemini
  developer forum states `gemini-2.0-flash` was retired June 1, 2026 on
  the Developer API path. Path distinction recorded: CompanionDesk's
  fallback uses the Gemini DEVELOPER API (generativelanguage.googleapis.com,
  key in the x-goog-api-key header, never Vertex/Agent Platform), so the
  retirement applies to this entry's service path. The registry marks the
  id `retired` (`retiredOn: 2026-06-01`, both sources in `verified`);
  the routed gateway refuses it as `cloud_model_retired` BEFORE any cloud
  health probe or call (fail closed), the user's configuration and key
  are preserved, and no replacement model is registered or substituted
  silently. Registering a current cloud fallback (a newer Flash id may
  require billing) is Ninad's explicit product decision, not a silent one.

Router routing policy is untouched: same tasks, same privacy rules, same
consent gates. The retirement refusal lives in the routed gateway
(src/ai.js routeTask), the only cloud-call site, including the
reconsider-after-local-failure path. Tests: registry `isSelectable`
(retired ids never selectable), a real-registry regression (armed +
consented fallback refuses `cloud_model_retired` with ZERO cloud probes
or calls), the local route untouched, and pre-retirement transport
contracts kept via a test-only registry fixture. Full suite 870/870 +
selftest.

## GATE 1 - Android intelligence (3-4 wks, device time)

Prepared (23 Nov 2026, repo-only): the offline benchmark scaffold lives in
experiments/android-inference-benchmark/ — collection scripts, a results
schema, a license-verification matrix (llama.cpp MIT, MLC Apache-2.0, Qwen
2.5-0.5B / SmolLM2 / TinyLlama Apache-2.0) and a self-test wired into
`npm test`. Nothing has run on a device; all numbers remain pending.

Work: Capacitor plugin wrapping llama.cpp via JNI with one quantized sub-1B
model; measure tokens/s, RAM, battery, thermals on the OnePlus 12R. Separately
a token-authenticated, LAN-only proxy in front of Ollama (which stays bound to
localhost; it has no built-in auth by default, to be re-verified). Exit: the
measurements decide Android's local-vs-remote default. Nothing is claimed
feasible until these numbers exist.

### Gate 1 validation matrix (Android + desktop, concrete tests to run)

Android half: the scaffold above IS the Android matrix (metrics table,
fairness rules, acceptance criteria, owner runbook). Nothing to add.

Desktop half (MacBook Air M1, the product's primary platform), defined
here so the same evidence discipline applies. Everything runs against
the PRODUCT path (Ollama behind the app), on the real machine; nothing
is a Gate 1 result until it is recorded next to the scaffold's results:

  1. Baseline row: OS/build, Ollama version, installed-model list, and
     the hardware profile the app itself computes (`hardware.js`).
  2. Model load time, cold (first run) and warm (subsequent), for the
     selected chat model and the selected vision model.
  3. Time-to-first-token and generation tokens/s over a fixed prompt
     set (the same prompts committed beside the Android results schema
     so both platforms compare), measured with
     `ollama run <model> --verbose` timings plus app-side timestamps.
  4. Prompt-eval tokens/s on a long-context prompt (worst realistic
     ask: a syllabus-size context).
  5. Peak RSS during generation (`ps -o rss` sampling) against the
     profile threshold (`hardware.js`) that selected the model: the
     profile must never have chosen a model that cannot fit.
  6. Cancellation on the real path: cancel mid-stream, confirm tokens
     already shown stay, the local call stops, and no cloud escalation
     happens (contract-tested; the device run confirms reality).
  7. Timeout behavior at the documented bounds (120 s local).
  8. Thermals and battery drain noted for the run block (macOS power
     reporting optional; qualitative is acceptable, marked as such).

Evidence rules, same as Android: at least 3 repeats per configuration,
medians reported, raw outputs kept, and the desktop half of the Gate 1
decision written only after these rows exist. A desktop row that was
not measured stays null; never fill it with an estimate.

## GATE 2 - Agent foundation (3-4 wks)

STATUS: slice 1 (agent safety foundation) is IMPLEMENTED on main
(24 Nov 2026, `3d4d5f7` + hardening `988ce68`) as pure, isolated modules
with NO product wiring: no UI, no IPC, no DB migration, no orchestrator,
no tool adapters, and no real tool registered anywhere in the app (the
registry ships empty; only test fixtures define tools). The audit log is
in-memory only. Landed as flat modules in the existing src/ layout:
`src/tool-registry.js` (immutable typed definitions, capability classes
read_only / reversible_write / sensitive / forbidden, strict argument
validation over plain JSON-like data only), `src/policy-engine.js` (deny
by default; check order: emergency stop, unknown tool, forbidden
capability, misclassified critical name, malformed args, exact-tool grant,
expiry/revocation, fresh one-time approval for sensitive or critical
tools; wildcard and capability-name grants are refused at grant time),
`src/approval.js` (one-time approvals bound by digest to the exact tool
and exact argument set, unpredictable 32-byte ids from crypto.randomBytes
/ crypto.getRandomValues, fail closed if secure randomness is
unavailable), `src/audit.js` (append-only, allowlisted sanitized event
schema, no update or delete API, SHA-256 hash chain with contiguous
sequence verification; detects edits, deletions and rehashed gaps),
`src/emergency-stop.js` (blocks every tool authorization while active;
reset only by explicit user action), `src/digest.js` (canonical JSON and
self-contained SHA-256; refuses sparse arrays, symbol keys, non-enumerable
properties, accessors and non-finite numbers, so digesting never executes
a getter or collapses distinct args). Critical namespaces (payments,
purchases, checkout, billing, legal, compliance, signatures, filings,
contracts, submissions, deletion) and destructive-deletion segments
(delete/destroy/erase/wipe/purge/permanent*) are enforced conservatively:
the registry refuses to register such a tool unless it is 'sensitive' or
flagged critical:true, and the policy engine separately refuses to
authorize any misclassified one that somehow exists. SLICE 2 (persistence) is IMPLEMENTED on main (24 Nov 2026, `e2eac24`)
and now WIRED (slice P2, 24 Nov 2026): six additive CREATE TABLE IF NOT EXISTS
tables in the db.js schema (agent_grants, agent_approvals, agent_audit,
agent_audit_anchor, agent_emergency_stop, agent_runs), a deliberately
narrow storage adapter (parameterized run/all plus BEGIN/COMMIT/ROLLBACK),
hydrate/export surfaces on the pure modules, audit entries and the anchor
written in one transaction with full rollback on failure, startup
verification of the persisted chain from the stored base with the anchor
required to match the verified tail (tampered rows, rehashed or unanchored
tails and invalid rows all fail closed with evidence preserved and no
automatic repair), pending approvals invalidated on restart with the flip
persisted and audited (used approvals stay replay-denied), grants restored
with exact expiry and revocation, the emergency stop restored active if it
was active at shutdown, no agent-run resume API at all, and bounded
retention by archive-then-prune only (the archive must verify and cover
the entries dropped; the prune is audited and advances the chain base so
the anchored tail stays locally verifiable). Documented limits: file-level
durability is the same debounced flush every table uses, and recovery from
a detected integrity failure is an explicit decision left to the wiring
slice. The 3b audit limitation is now closed for locally stored history by
the persisted anchor. SLICE 3 (orchestrator) is IMPLEMENTED on main (24 Nov 2026, `e0fa026`),
still with NO product wiring: a pure, declarative run loop over the
slice 1/2 modules with no free-form agent loop and no model call. Every
step names one registered tool, exact args, and its own executor closure.
Fail-closed semantics as documented in the blueprint 3d section: stop
pause with explicit resume only, approval pauses where the orchestrator
never creates an approval itself and consumes a user-created one exactly
once before execution, denied authorization aborting unskippably,
malformed results and throwing steps failing closed, bounded retries
(0-3) with used approvals never reused, skip/abort recovery, and a full
transition audit. Documented limits: in-memory run state only (no
persistence surface, nothing resumes after restart) and synchronous steps
(per-step wall-clock budgets belong to the wiring slice). SLICE 4 (first harmless tools) is IMPLEMENTED on main (24 Nov 2026,
`05cea22`), still with NO product wiring: agent-notifications (a bounded
in-memory queue of notification records; never sends or delivers),
agent-reminders (a bounded in-memory book of reminder records with future
dueAt; never wakes, fires or holds timers) and agent-ics (a pure RFC 5545
VEVENT generator returning text; never writes a file or touches a calendar
application). Registry classes are reversible_write, reversible_write and
read_only respectively; nothing is sensitive, so a standing grant
suffices and no per-call approval is required, proven end to end through
the real registry, policy engine and orchestrator (denied without a
grant, authorized with no approvalId with one, full three-step run
creates real records and audits every transition, a tool-level refusal
stores nothing and follows skip recovery). The read-only renderer-to-
main surface is now wired end to end (agent-surface.js on the hardened
ipc-contract.js, section 3h of the blueprint; writes unreachable from
the renderer). Persistence wiring is IMPLEMENTED on main (24 Nov 2026, slice P2):
the agent runtime module owns open/load/save/close of a dedicated
agent-state.db, every write path passes a persistence-blocked gate, the
renderer's surface reports blocked state neutrally, the orchestrator
receives the persistence layer's durable audit wrapper through one
shared stack factory (createAgentStack; the injection gap where main.js
passed the raw audit was caught in review and fixed, with an
integration test proving the injection and flush-failure lockout), a
reset while active converges and closes the old store before reopening,
before-quit reports a failed save instead of claiming convergence, and
the store saver uses a process-unique temp file plus atomic rename and
FAILS CLOSED when the rename cannot replace the target (previous file
byte-for-byte intact, sanitized code-only error, no in-place write of
the target; atomicity is never traded for availability), and start()
never throws (every failure path returns blocked with the store closed
and sanitized reasons).
Remaining Gate 2 work: the acknowledgement gate is DONE (option C,
blueprint 3j.5: id-only notifications:ack from an explicit per-record
gesture, durable-before-state, replay idempotent; the display store
stays ack-free) and display delivery wiring is DONE (blueprint 3j.6: a
main-only operation copies unread desk records into the display store at
startup reconciliation and after each successful acknowledgement, bounded
batches, explicit overflow with eviction safety so no unread record is
ever silently displaced, reported orphan GC, replay idempotence; the
bridge of 3j.1 stays untouched and no delivery path acknowledges).
Still remaining, each an explicitly-reviewed gate: scheduling, and file
output. A creation-source review (blueprint 3j.7) verified there is no
existing main-owned event source: no component drives agent runs, so no
terminal outcome ever fires; the notification creation source belongs to
the future run-driver gate, and until then the desk stays
creation-empty by design. A design-only run-driver proposal now exists
(docs/RUN_DRIVER_DESIGN.md, blueprint 3j.8): staged gates A/B/C with
explicit approval checkpoints. Ninad approved all seven decisions
(D1-D7) on 24 Nov 2026 and Stage A is IMPLEMENTED (blueprint 3j.9):
driver foundation with an empty production registry, ledger mirroring,
restart reconciliation (D4), completed/aborted terminal notifications
(D5), arg-free renderer projections (D6), and a 'user'-only kind
allowlist (D7). Nothing can execute: no tools are registered and no
source calls the driver yet. Stage B has a concrete DESIGN-ONLY proposal
(docs/STAGE_B_PROPOSAL.md, 24 Nov 2026: candidate calendar_upcoming, data
scope, threat model, executor, audit, tests, rollback, decisions D-B1/D-B2;
registry still empty, nothing implemented). Stage B (real tools, approval
mechanics) and Stage C (renderer run controls) await separate explicit
review and remain unimplemented;
no execution capability is enabled.
Acceptance: policy
engine refuses ungranted calls (tested); payments, purchases, destructive
deletion, and legal or binding submissions are denied unless fresh,
explicit user approval immediately precedes execution (tested);
prompt-injection corpus passes before any grant widening.

## M4 - Memory v2 (1-2 wks)

STATUS: WIRED IN PRODUCT as slices 1-2 (24 Nov 2026; the owner resolved
the four decisions and authorized wiring the same day). Background:
offline design + harness complete as of 23 Nov 2026. Prerequisite answered
by measurement: sql.js's WASM build
has NO FTS5, so the route is a pure-JS index over the existing markdown
About-me file (which stays canonical, the only memory store). Selective
per-task retrieval; Remember/Forget commands; consent gate for sensitive
entries; embeddings stay deferred. Measured keyword baseline and slice
results (recall 38.0% -> 97.2%, MRR 0.395 -> 0.793 on the 18-query harness;
no zero-hit queries remain; what is left is ranking quality, not
vocabulary) and the full design: see `docs/M2_MEMORY_V2_DESIGN.md` and
`experiments/memory-v2-harness/`. The store contract (drafted offline as slice 5, contract-tested against
the current memory module) is now WIRED in product as slice 2; see the
24 Nov 2026 note below, `docs/M2_MEMORY_V2_DESIGN.md` and
`experiments/memory-v2-harness/`.
No automatic extraction, no inferred-fact auto-saving, no background
monitoring in this phase.

26 Nov 2026: the owner resolved the last open sub-decision
(decision-sheet item 6: "M4 sensitive sidecar markings with sensitive
content session-only"). WIRED SLICE 3: `src/memory-sidecar.js` is the
session-only sidecar and the ONLY place sensitive state lives — marks
(classifications, never consent) keyed by section + normalized text, and
session-only sensitive entries the About-me file never sees. The module
is pure: no require, no fs, no timers, no serialization; bounded books
(100 marks, 50 entries) fail closed. `src/memory-session.js` now holds
all sensitive state in the sidecar: marks re-apply on every rebuild
(unchanged), session-only sensitive adds are remembered and RE-INJECTED
after each rebuild so they survive refreshes within the session and die
with it (previously a refresh dropped them; the sidecar makes
"session-only" mean the session, not the refresh cycle), a full sidecar
refuses the add or mark and rolls the view back, and forget() works on
session-only entries without touching the file. A manual duplicate write
of the same bullet collapses the sidecar's copy into the user's own
unmarked file line. persistSensitive() stays fail-closed
(sensitive_storage_blocked); no product surface passes sensitive entries
yet; a UI for the mark/persist interfaces stays gated. Verified by
tests/memory-sidecar.test.js (5 tests) and the updated
tests/memory-session.test.js; full suite 1235/1235, selftest PASS, web
build green.

24 Nov 2026: the measured harness core (slices 0-5) is ported to
`src/memory-retrieval.js` and `src/memory-store.js` (contract tests pin
them to `src/memory.js`). Later the same day the owner DECIDED all four
open questions with explicit guardrails (`docs/M4_MEMORY_DECISIONS.md`,
"Status: RESOLVED") and authorized wiring. WIRED SLICE 1: persona
selection now runs on the measured ranker with the decided budgets
(chat 12, screen 6, goal 8, vision 0; screen-derived asks forced to
zero); the vision ask path retrieves ZERO memory; the frozen synonym
map is test-pinned; the storage gate keeps sensitive entries
session-only (never written to the About-me file, no on-disk format,
`persistSensitive` fail-closed). WIRED SLICE 2 (`e9b9b7f`): the v2
store contract now runs as the product's in-session memory view
(`src/memory-session.js`); personal.js and screen-service.js route every
memory operation through it, the About-me file stays canonical via
single-bullet writes, and sync-on-demand stat freshness keeps view and
file in step. The on-disk format for sensitive marks is RESOLVED 26 Nov
2026 (decision-sheet item 6): a session-only sidecar
(`src/memory-sidecar.js`), deliberately NO on-disk format. STILL GATED: a
UI for the mark/persist interfaces. No automatic extraction,
no inferred-fact auto-saving, no background monitoring in this phase.

## M5 - Proactive behavior (1-2 wks)

Main-process scheduler persisted in the DB; OS notifications for confirmed
deadlines and user-approved reminders; quiet hours; per-scope user controls.
No network. Proactive actions run only on schedules the user set.

**Slice 1 (landed 24 Nov 2026): the scheduler core, wired, inert until the
user opts in.** `src/agent-scheduler.js` is a pure, bounded schedule book
(one-shot schedules; scopes `reminder` and `deadline`), persisted through
the agent persistence layer's durable audit guarantees (tables
`agent_schedules`, `agent_schedule_scopes`). Roadmap rules are structural:
the book is created only by the user-facing product surface
(`schedules:create|list|pause|resume|cancel` product channels, deliberately
NOT in the Gate 2 agent contract's renderer set, which stays read-only);
the agent registry never sees it (wiring-lock test pins the require graph).
Quiet hours defer, never drop (default 22:00-08:00, user-changeable);
delivery is opt-in and off by default, globally AND per scope
(`proactive_enabled`, `proactive_scope_reminder`, `proactive_scope_deadline`
in settings). A due schedule fires exactly once; the main-process loop
(60 s, unref'd) attempts one OS notification per fired schedule when the
settings allow and audits every outcome (shown / failed / skipped_settings);
a failed delivery is never retried by re-ticking, so a broken notifier can
never spam. Renderer schedule creation UI is the next M5 slice; until a
user creates a schedule and enables delivery, nothing fires.

**Slice 2 (landed 24 Nov 2026): the user surface.** `renderer/schedules-panel.js`
lists, creates, pauses, resumes and cancels via the five user-facing product
channels only; every write is an explicit button click, rendering is
textContent-only, and a refused channel keeps the panel quiet. `src/schedules-view.js`
is the pure fail-closed shaper (allowlisted fields only, display cap 10 that a
caller may only lower, malformed records skipped and counted, no mutation).
The About settings card gained the proactive controls (master delivery toggle
off by default, per-scope reminder/deadline toggles, quiet hours with time
inputs, all carried through `settings:save` and normalizeSettings). **Slice 3 (landed 24 Nov 2026): per-scope delivery visibility and editing.**
The schedules panel now shows, read-only, what each scope's delivery actually
does: if the master proactive toggle or a scope toggle is off in settings, a
state line says so in plain language, so a listed schedule that will not
notify is never a mystery. Active (not fired, not cancelled) schedules can be
edited in place: a sixth user-facing channel `schedules:update` changes title
and/or due time only (the scope of an existing schedule does not change;
changing it is a different commitment, cancel and recreate), validated and
audited like every other write with rollback on a failed save. The audit
log's detail charset (lowercase keys, no undefined values) is now honoured by
the surface's audit entries, a latent slice-1 mismatch the new tests caught:
the create path against the real audit log had been refused, hidden by the
fake-persistence tests. The panel edit affordance prefills the creation form,
disables the scope field while editing, and restores "Add schedule" after.
Conservative defaults remain working defaults (delivery off, quiet hours
22:00-08:00, nothing fires until the user enables it) until reviewed.

**Slice 4 (landed 24 Nov 2026): quiet-hours visibility.** While delivery is
on, the schedules panel states the configured quiet-hours window and its
contract in plain language (a due schedule inside the window notifies when
it ends, it is never dropped), so a deferred notification is never a
mystery. Read-only; the change itself stays in About > Proactive reminders.
M5 is complete as specified.

## M6 - Voice v2 (2-3 wks)

**Slice 1 (landed 24 Nov 2026): decision-independent groundwork; voice
stays off until configured.** New `src/voice-session.js` is the pure
push-to-talk session state machine: one explicit session at a time, begun
only by an explicit user action, the `micInUse` privacy indicator true only
while recording, a 30 s cap the caller enforces via `autoStopDue()`
(no timers of its own), failure reasons allowlisted, and no audio argument
anywhere in its API (the page holds the recording; the machine never
receives it). Voice is now gated by a setting: `voice_enabled` defaults to
false, `voice:transcribe` refuses with `voice_disabled` until the user
turns it on in About > Voice input, and the overlay explains that instead
of recording into a closed door. Microphone permission is still requested
only on the first explicit Speak press (the permission policy stays
overlay-only and audio-only), never at startup. An in-flight transcription
can now be cancelled: `voice:cancel` kills the running whisper process and
the result maps to `cancelled`; the overlay's Escape and close do this.
No audio retention: the temp WAV is deleted before transcription returns,
and cancel releases the page's buffer. No model selection, no download, no
wake word, no always-listening, and no claim of validated recognition:
those wait for Ninad's decisions (docs/M6_VOICE_DECISIONS.md) and physical
device time.

**Slice 2 (landed 24 Nov 2026): transcription language wired to the
`language` setting.** `src/whisper.js` now carries the language table
verified live from whisper.cpp's own source (src/whisper.cpp, the
`g_lang` map, 97 languages, read 24 Nov 2026). `resolveLanguage` maps
the existing free-text `language` setting to a known whisper code by
exact, case-insensitive match on the code or the language name, and
never passes anything else to the CLI; the `WHISPER_LANG` env override
stays first but is now validated against the same table; unknown values
fail closed to `en`, today's behavior. `src/voice.js` forces `en`
whenever the resolved model file is English-only (any `.en.` name), so
setting Hindi while an .en model is installed can never send a
mismatched `-l` and break transcription. 'auto' (whisper.cpp language
detection) is deliberately not enabled. No model download, no new
asset, local-only. Tests: table integrity against the primary source,
mapping/precedence/fail-closed cases, and transcribe-level tests that
chain through the real whisper.transcribe to pin the exact `-l` value.

**Slice 3 (landed 24 Nov 2026): OS-native speech-output groundwork.**
`renderer/speech-output.js` is the pure speech-output state machine and
capability detector, the same dual-mode fail-closed pattern as the
push-to-talk machine. The only engine is the operating system's own
voice stack reached through the standard `speechSynthesis` interface
(on macOS Chromium that is the OS voice): no bundled model or asset, no
download, no external service, no paid dependency, no third-party TTS
engine. Speech output has its own setting, `voice_output_enabled`,
defaulting to false (About > Voice input), and the machine refuses to
start while it is off. Nothing ever speaks on its own: creation and
startup speak nothing, and `start` refuses any call that is not an
explicit button press (`user_action_required`). One utterance at a
time; `stop` cancels through the engine and late engine callbacks
cannot resurrect the session; failure reasons are an allowlist with
user-facing wording in the shared error map, unknown engine errors
failing closed to `synthesis_failed`; the machine retains no text or
utterance (no audio or text retention); the adapter sets no voice,
rate, pitch, or volume, so the OS keeps audio focus, level, routing,
and interruption. The overlay shows Read aloud only after a successful
answer, only when the setting is on and the runtime actually exposes
speech synthesis, and the button doubles as the visible playback state
(Read aloud / Stop); Escape, close, reset, and a new question all stop
speech. Honest limits: whether any specific machine actually speaks is
a physical-device question and no such claim is made; where
`speechSynthesis` is missing the UI says so instead of guessing.

M6 slice 4 wake word (24 Nov 2026): the user DECIDED the route - phrase
"Hey <assistant_name>", local self-training on fully synthetic speech,
primary-source license verification for every asset, nothing shipped
without provenance, always-listening off by default with explicit
activation, indicator, immediate stop, no platform bypasses. Implementation
split: slice 4 = subsystem + gates + settings + About controls + training
pipeline (src/wake-word.js, src/wake-engine.js, scripts/wake/,
docs/WAKE_WORD.md, docs/WAKE_PROVENANCE.md). The shipped-file licensing
situation changed on re-verification: the upstream shared feature-extractor
ONNX artifacts have UNSETTLED licensing (open issues #338/#346/#348/#357,
no maintainer answer), so we convert our own feature extractor from
Google's Apache-2.0 speech_embedding module per the notebook, exactly the
"run the training ourselves" path the user approved. The listener runtime
integration LANDED as M6 slice 5 (hidden listener window, score/query
flow, mic indicator contract, query-done cooldown, About controls).
Remaining: the actual model training run and physical-device validation
(synthetic-metric claims never substitute for measured on-device rates).

Wake-word TRAINING verification memo, docs-only (24 Nov 2026,
docs/WAKE_TRAINING_VERIFICATION_MEMO.md): primary-source verification of
the third-party training centre (openwakeword.com/train) and the
self-training path's chain. Material finding: the centre's Terms Section
5 licenses generated models for personal and NON-COMMERCIAL use only by
default, with commercial use available only via its paid commercial
license, so the centre path is closed for CompanionDesk unless Ninad
explicitly approves that paid license; no free compliant centre path was
found. The self-training path's chain re-verifies as permissive (repo
code Apache-2.0, Google speech_embedding Apache-2.0, our own converted
extractor; per-voice Piper gate) with named residuals (centre terms tail
and privacy policy unread, checkpoint weights licensing unstated, VCTK
license unverified, technical performance unvalidated on device). Wake
word stays disabled and gated: no training run, no download, no
activation, no phrase choice. Second pass, 24 Nov 2026 (late): the centre's Terms were read in
full (sections 8-13; data handling lives in section 10, no separate
privacy page), the commercial-license page was read at /license
(USD 185 one-time per wake word; its scope statement covers only
models trained through the centre's pipeline while the runtime
stays Apache-2.0, so our locally-trained model is outside its
claim), and VCTK was verified CC BY 4.0 from Edinburgh DataShare
(DOI 10.7488/ds/2645). Conclusions unchanged: centre closed by
default, self-training path unaffected, wake stays gated.

Piper successor VERIFIED (24 Nov 2026, primary sources read live via
the GitHub API): `rhasspy/piper` is archived (MIT, last pushed
2025-08-26) and `rhasspy/piper-phonemize` is archived too; the
successor is `OHF-Voice/piper1-gpl` under the Open Home Foundation,
active (last pushed 2026-11-23, latest release v1.8.0 published
2026-09-04), self-described as a fast, local neural text-to-speech
engine embedding espeak-ng, installable as `piper-tts`, with a
command-line interface, a Python API, a C/C++ API, voice licensing
docs, and an explicit "looking for maintainers" notice from the
foundation. Two facts recorded for a future decision, and nothing
decided today: the engine is GPL-3.0 (copyleft, so bundling it in the
MIT codebase raises distribution questions Ninad would have to weigh),
and any engine or voice-model adoption remains behind his explicit
approval rule for downloads and assets. DECIDED 26 Nov 2026 (decision
sheet item 7, approved by Ninad the same day): the TTS engine is
OS-NATIVE ONLY; piper1-gpl stays DEFERRED and unbundled (the GPL-3.0
bundling question is moot until he reopens the decision), and adopting
any engine or voice asset still requires his explicit approval. No
engine adopted, no asset downloaded, no dependency added; the OS-native
speech path above stays the only speech output in the product, now
guarded by tests/m6-tts-decision.test.js (no piper dependency or import
anywhere outside the decision records; the pure speech-output module
requires nothing). The implementation itself landed with M6 slice 3
(renderer/speech-output.js, 16 tests) and needed no new code; this
slice records the owner's decision and makes it enforceable.

## M7 - Screen understanding v2 (2-3 wks)

Ninad's decision (24 Nov 2026): three selectable modes - manual look
(default), active session, and background assist restricted to
laptops/desktops behind a separate explicit consent, persistent
indicator, easy pause/stop, app exclusions, conservative cadence,
local-only processing, no cloud upload, no screen-content retention by
default. Never enabled silently; screen permission only after a user
action; no capture at startup.

Policy slice shipped: `src/screen-mode.js` (mode policy, fail closed and
test-pinned), `screen_mode`/`screen_background_consent` settings keys,
and the settings UI picker with the background consent checkbox. The
capture engine stays disabled and unbuilt pending real permission flows
and device testing on each desktop platform; nothing captures, requests
a permission, or shows an indicator from the policy slice alone.


**Slice 1 (landed 24 Nov 2026): decision-independent groundwork; the
interface only, no capture engine.** New `src/screen-observation.js` is the
pure observation-session state machine the M7 line asks for: opt-in
(`screen_observation_enabled` defaults to false in settings), started only
by an explicit user action, one session at a time, pausable and resumable
(a resumed session owes a full interval, not an instant tick), a bounded
per-session interval (5 s to 10 min, default 30 s) the CALLER enforces via
`dueTick()`/`markTicked()` (no timers of its own, clock injected), user app
exclusions (case-insensitive, capped) combined with the existing
`sensitiveWindow` and `isOwnWindow` rules and refused on any match, an
always-visible indicator contract (`indicator()`), and `LOCAL_ONLY` as a
named constant: an observation answer must resolve through the local vision
route and nothing here can flip it. No pixels are accepted or stored
anywhere in the API. Deliberately NOT in this slice: the engine loop that
would drive captures, any desktopCapturer call on a schedule, any Android
MediaProjection work (device-gated, flagged in RISK_REGISTER), and any UI.
The existing per-ask capture path (`screen:ask`, one user-picked window,
title-checked, local vision only) is unchanged and remains the only capture
path until the engine slice is built and reviewed. Nothing captures at
startup today: `getSources` runs only inside the explicit `screen:windows`
and `screen:ask` handlers.

Session-scoped live observation on desktop: opt-in, visibly indicated,
pausable, app exclusions, configurable interval, local processing only.
Android MediaProjection POC honoring its per-session consent requirements.

## M8 - Integrations and workspace UI (open-ended)

## M8 progress

### M8 slice 2: Device Access Centre policy core (landed 24 Nov 2026)

Per Ninad's requirement that CompanionDesk offer broad device/app access rather than only narrow integrations: `src/device-access.js` is the app-side policy layer, pure (no OS calls, no network, no real permission requests). A fixed capability catalog maps each capability to the OS permission it needs per platform (microphone, screen capture, accessibility/UI automation desktop-only, scoped file pickers, contacts, notifications, location, calendar, purchase). Nothing is granted by default; grants are per app id and capability with exact scopes, no wildcards; write/send/delete/purchase classes additionally require a Gate-2-style approval digest for the exact action; revocation is immediate and per app; a request for an OS permission exists only behind an explicit user action on a capability about to be used, never at startup and never in bulk; sensitive capabilities carry a visible-while-active indicator requirement; `UNRESTRICTED_DEVICE_ACCESS` is a constant false. The OS remains the real boundary; this layer never bypasses sandbox, TCC, or Android runtime permissions, and truly unrestricted access to every app and private app database is stated as impossible in the architecture doc. 10 tests in `tests/device-access.test.js`.

- Slice 1 (decision-independent groundwork): `src/integrations.js`, the
  pure integrations registry. Manifest validation (strict shape, no
  unknown fields, wildcard/unknown/forbidden/empty scopes refused), a
  fixed least-privilege scope catalog mapping each scope to a Gate 2
  capability class (read_only / reversible_write / sensitive / forbidden;
  forbidden scopes exist only to be nameable and are never grantable),
  connect/disconnect/revoke/readmit lifecycle with explicit-consent
  records, re-connection after revoke only after explicit readmission,
  and a single `authorizeCall(id, scope)` door. Connect is refused while
  connected, so grants are never widened in place. No connector talks to
  anything, nothing auto-connects, and the module ships empty (same
  precedent as the tool registry). Verified by tests/integrations.test.js
  (8 tests); full suite 841/841 + selftest. Deliberately deferred until
  Ninad chooses: real connectors (each verified against official APIs
  before any capability claim), the workspace views, and companion
  move/resize/remember.


### M8 slice 4: view schemas wired schemas-first (landed 26 Nov 2026)

Per Ninad's approval of decision-sheet item 5 (26 Nov 2026: "M8
schemas-first, no connectors until he names services"), six further view
schemas are wired in `src/workspace-views.js`, each one mirroring exactly
the rows of an owning module read this run and none of them touching any
file in the closed/checkpoint set: tasks from agent-reminders reminder
rows (id/title/dueAt/notes/createdAt/cancelled, the due stamp rendered as
ISO), memory from memory-session.items() rows ({id, section, text}; a row
carrying the session-only `sensitive` flag carries a field outside the
schema and is skipped and counted until M4 defines the workspace
treatment of sensitive marks), tools from tool-registry.list()
definitions ({name, description, capability, schema, critical?}, so
`optional` fields entered the shaper contract: absent is fine, present
must still pass the schema's checks), permissions from device-access
grant rows ({appId, capability, scopes, grantedAt}), activity from
audit-log entries ({at, actor, action} plus the append-allowlisted
extras tool/decision/reason/grantId/approvalId/detail and the chain
fields seq/hash; an entry carrying any other payload key is skipped and
counted), and integrations from integrations.js list() rows ({id, name,
version, declaredScopes, connected, revoked, grantedScopes,
consentedAt}). files, workflows and models stay unwired because no
owning row store exists yet, and settings stays unwired because its
owning module (settings.js) is in the m84 checkpoint-closed set.
Conversations' line format is unchanged byte for byte. No connector, no
customization, no renderer UI, no IPC. Verified by
tests/workspace-views.test.js (17 tests, 11 new or updated); full suite
1226/1226, selftest PASS, web build green.

### M8 slice 3: workspace-views groundwork (landed 24 Nov 2026)

`src/workspace-views.js` is the decision-independent groundwork for the
workspace surface: the fixed catalog of the eleven roadmap views
(conversations, tasks, memory, tools, files, workflows, settings,
permissions, activity, models, integrations), a `resolve()` door so only a
catalog view can be active, and a fail-closed shaper in the
schedules-view pattern: at most 10 records per call (cap only lowerable),
allowlisted fields only (symbol keys, accessor properties, exotic
prototypes, unknown fields all refuse the record), malformed records
skipped and counted, inputs never mutated. Exactly one schema is wired
today, conversations, matching `chat-history.listConversations` rows
exactly; every other view exists in the catalog but refuses to shape
anything (`view_not_wired`) until its record schema is reviewed and
wired, so no view can ever guess another module's shape. The module
requires no other app module (wiring-lock test). Verified by
tests/workspace-views.test.js (11 tests); full suite 937/937, selftest
PASS. Deliberately NOT in this slice: any renderer UI, any IPC channel,
any DB read, and the wiring of the other ten view schemas.

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

Device validation groundwork (26 Nov 2026, docs-only): `docs/DEVICE_VALIDATION_CHECKLIST.md`, a precise physical-device pass for the owner's MacBook Air M1 and OnePlus 12R over the shipped M4/M5/M6/M8 features; the wake-word lane and the m84 float toggle are excluded per owner closure. Running it is the single physical input that unlocks honest device-verified claims, and it doubles as Gate 1 benchmarking groundwork and future M9 input.

Next decisions groundwork (26 Nov 2026, docs-only): `docs/NEXT_DECISIONS.md` consolidates every open gate (device pass, connectors, workspace UI, file_write registration, M7, M9, sensitive-memory UI, files/workflows/models row stores) into one fillable sheet. The morning decision sheet is fully executed and no implementation-ready ungated slice remains.

Error-safety lane closure (26 Nov 2026, docs-only): the M2/M4 memory-panel error-safety/consent lane is complete across four red-first slices (`d48f07f`, `d7247f5`, `c22625a`, `84d8e75`); a panel-path inspection found every user-facing early-return/catch path announces or degrades honestly (the missing-bridge refresh path builds no panel by design), and no ungated implementation-ready M2/M4 slice remains. Remaining gates unchanged: the physical device pass (`docs/DEVICE_VALIDATION_CHECKLIST.md`) and the four owner decisions in `docs/NEXT_DECISIONS.md` (items 2, 3, 4, 8); nothing else in M0-M9 is implementation-ready before the pass.

Connector catalog slice (26 Nov 2026 evening, code + docs): src/connectors.js, the Gate 2 connector-settings decision Ninad approved the same evening (free-first worldwide discovery, extensible reviewed registration, exact scopes, lifecycle, approval gates, opaque credential references, cost/limits before activation, no auto-connect, nothing activated). Suite 1280/1280, selftest PASS; remaining connector work is per-service and needs Ninad to name services and approve each activation.

Approved-gates execution, Gate 4 slice two (26 Nov 2026 night, f239a93): the file-access EXECUTION slice wired real filesystem operations through the policy core (src/agent-tool-file-access.js gains an injected io adapter; main.js builds the fs-backed adapter and registers file_access as the second tool). Tests: 9 red-first executor tests (tests/file-access-executor.test.js) including a real-fs round trip in a temp dir and an OS-error-verbatim check; guardrail suites widened from exactly-one to exactly-two registration literals; suite 1323/1323, selftest PASS, CI green both platforms (45871677456, 45871677373). No device validation is claimed; M7/M9 stay deferred; the tool executes nothing outside driver-driven runs, which still cannot start.

Gate 8 renderer wiring (27 Nov 2026 00:00 IST, c94dbb4, Ninad-approved: Gate 3 full Workspace UI + Gate 8 A cover it; the earlier later-lane note is outdated): the five row-store views (files, databases, appdata, workflows, models) flipped to wired true in the catalog, so the Workspace panel fetches each through the existing pure rows provider and shapes rows with the fail-closed schemas (wrong-shape rows skipped and counted, never guessed); added the UI empty state for zero rows ('no rows yet: rows appear only through explicit app actions, never a scan') and an honest unwired view remains only for settings. Permission boundaries unchanged: the rows provider is list-only over the in-memory stores (which start EMPTY), no new IPC channels, no data access beyond what existed, no persistence, no auto-scan/auto-exposure, no M2/M4 changes, M7/M9 untouched. Red-first: 5 tests red then green; suite 1325/1325, selftest PASS, CI success 45877044100 + 45877044153.

Gate 8 slice two (26 Nov 2026 night, c923013, Ninad's clarification that Gate 8 A covered local databases and structured app data): the two remaining approved store categories landed as pure bounded stores (src/workspace-stores.js createWorkspaceStore calls in main.js, prefixes db and ad, same per-field types, enums, frozen rows, bounded search, in-memory, start EMPTY with no auto-scan and no auto-exposure) plus their view adapters in src/workspace-views.js (databases and appdata entries in the catalog, fail-closed shaping schemas mirroring the rows, wired flag false because renderer wiring is a later lane). No second memory store, no M2/M4 sensitive persistence or canonical markdown change, no persistence of sensitive data, M7/M9 untouched. Suite 1323/1323, selftest PASS.

Approved-gates execution (26 Nov 2026 late evening, code + docs): Ninad's consolidated authorization (Gate 1 A, Gate 2 settings-UI follow-on, Gate 3 full Workspace UI, Gate 4 option C, Gate 8 full row stores) recorded in NEXT_DECISIONS.md (bbaea0a) and implemented in five commits: the connector catalog core (25990f5), the workspace panel with the connector settings section (8fba3539), the end-to-end workspace wiring with the pure rows provider and six lifecycle channels (c4f476c), the file-access policy core (623d46ae, registration deferred to the execution slice as above), and the files/workflows/models row stores (d35591e6). Suite 1314/1314, selftest PASS, CI green on both platforms for c4f476c; nothing auto-connects, nothing auto-exposes, no device-validated claim is made, M7/M9 stay deferred, and the remaining connector work still needs Ninad to name services and approve each activation.

Gate 2 docs slice (27 Nov 2026 00:13 IST, bba667a, Ninad-approved read-only/documentation polish within Gate 2): the shipped 20-entry connector catalog now has docs/CONNECTOR_CATALOG.md, generated directly from src/connectors.js and held in sync by three red-first tests (tests/connector-catalog-doc.test.js): every shipped entry named with its cost note and limits, the activation gate stated (AUTO_CONNECT false, catalog not registered as an agent tool, every entry starts discovered, activation is an explicit user selection per connector with explicit scopes and approval gates for write/send/delete/external/sensitive), and no invented connector id anywhere. Plus one wait-state line in the Workspace panel's connector section (renderer/workspace-panel.js): 'connector catalog: N shipped, M connected; connecting is always your explicit pick per connector'. Nothing connected, no credentials requested, no permissions granted, no connector names beyond the shipped catalog; the panel still shows cost and limits before activation. Suite 1329/1329, benchmark ok, selftest PASS. Per-service activation (naming services and approving each) remains Ninad's call; M7/M9 stay deferred.

AI-access connector flow slice (27 Nov 2026 ~4:45 PM IST, code + docs): Ninad's same-day decision that the Connectors section is accessible by both the user and the AI, the AI may ask him to connect an app/website when a task requires it, a connection is one-time and persistent until he disconnects, and he can disconnect/manage it. Landed: src/connector-requests.js (pure request center: the agent raises a user-facing connect request naming one catalog connector plus a bounded single-line reason; one open request per connector, repeats refresh instead of duplicating; resolve requires userInitiated and ONLY the user's explicit decision; bounded queue and audit; strict fail-closed snapshot/restore), a strict snapshot/restore pair on src/connectors.js (states and exact grants only, never credential references; unknown ids, undeclared or duplicate scopes, grants without a connected state and connected states without grants are refused, not repaired), src/agent-tool-connectors.js (connector_status, the THIRD registered tool, capability ordinary: list + request_connect only; it never connects, grants, consumes an approval or touches a credential), two new IPC channels (workspace:connectorRequests, workspace:connectorRequestResolve; resolve is main-built userInitiated), panel request rows in renderer/workspace-panel.js (approve runs the SAME explicit connect gate as the user's own pick and surfaces every refusal verbatim; the optional methods degrade gracefully), and settings-table persistence so a connection lasts until the user disconnects it (ids, states, exact scopes and request text only; no credential store exists yet so nothing can connect today). Registration-literal guardrails widened 2 to 3 in the three Gate 2 tests. Suite 1357/1357 under Node 22, selftest PASS. No service is connected, no credential requested, no permission granted; naming services and activating any of them remain Ninad's calls.

Credential-store slice (27 Nov 2026 ~5:45 PM IST, code + docs, Ninad's continuous implementation authorization): the service-agnostic secure credential layer the connect gate needed. Landed: src/connector-credential-store.js (one opaque secret per connector id, encrypted by Electron's safeStorage into a 0600 file under userData/connector-vault/; same fail-closed gating as src/secure-store.js including the Linux secure-backend check; plaintext never on disk, in settings, in logs or in the renderer; deterministic opaque reference `keychain:companiondesk-<id>` so settings never persist anything about credentials; readCredential is main-process-only and nothing in this build calls it - the service-call layer is a later Gate 2 step), two IPC channels (workspace:connectorCredentialSet, workspace:connectorCredentialRemove; set requires a known catalog connector, remove is refused while connected), credential refs re-derived from the vault after the snapshot restore, disconnect and revoke both delete the stored credential (a reconnect is a fresh explicit connect with a fresh credential entry), and the panel's Connectors section shows a password field for a connector without a stored credential (typed value goes straight to main's vault, field cleared immediately, secret never rendered; a connector that already has one connects with the plain button, no repeated prompt). New tests/connector-credential-store.test.js (11 red-first pins: round-trip, ref format pinned against connectors.js's own CREDENTIAL_RE, fail-closed encryption and Linux backend gating, validation, no-plaintext-leak, remove/list/status, undecryptable-file fail-closed, 0600 modes, trim), wiring test widened to the ten workspace channels, four panel behavior tests added. Suite 1372/1372, selftest PASS. STILL nothing connected: no real service touched, no scopes granted, no credential stored; naming services, entering credentials and approving each activation remain Ninad's calls.

Gate 4 docs slice (27 Nov 2026 00:21 IST, c8f2619, Ninad-approved read-only/documentation polish within the already-approved Gate 4 execution scope): the hourly continuation confirmed the file_write execution wiring is ALREADY fully landed (f239a93: all five actions through the policy core with the fs-backed io adapter, overwrite/delete confirmation gates, target visibility, OS-error-verbatim surfacing, real-fs round trip tests), so no duplicate work was redone. New: docs/FILE_ACCESS.md, generated from src/agent-tool-file-access.js and held in sync by three red-first tests (tests/file-access-doc.test.js): the five shipped actions with their io adapter methods and confirmation rules, the destructive-confirmation gate (overwrite_requires_confirmation / delete_requires_confirmation, unknown existence counts as existing), the schema caps (path 500, content 500), the executor cap (MAX_WRITE_BYTES 65,536, content_too_large), the sandbox note verbatim, and the driver-run boundary (file_access is the second registered agent tool; it executes nothing outside driver-driven runs, which cannot start). One observation flagged for Ninad, not changed: the schema's 500-character content cap and the executor's 65,536-byte cap are both shipped; aligning them is his call. No src changes, nothing connected, no closed file touched. Suite 1332/1332, benchmark ok, selftest PASS.

Reduced-motion accessibility slice (28 Nov 2026 morning, code + tests): the stylesheet's only animated property, the onboarding setup progress bar's 0.3s width transition, now respects prefers-reduced-motion. renderer/styles.css gains a @media (prefers-reduced-motion: reduce) block; tests/reduced-motion.test.js pins it red-first and generically: a prefers-reduced-motion block must exist, every selector declaring a transition or animation outside it must be disabled inside it, and the guard fails loudly if the stylesheet animates nothing, so a future animation cannot ship uncovered. Candidate hygiene: renderer/onboarding.js was inspected twice and returned CLEAN (boot.js already catches start() failures; the double-submit and crash paths were pinned by the existing four onboarding test files; the remaining edges are server-state or pinned transport-error wording). No closed file touched. Suite 1608/1608, zero failures; benchmark SELFTEST PASS. No lint/typecheck script exists in package.json and no dist artifact was built or claimed. Remaining gates unchanged: the physical device pass, M7 (deferred), M9 (deferred).

Agent-panel landmark-name slice (28 Nov 2026 morning, code + tests): renderer/agent-panel.js self-mounts a <section id="agent-status"> into every app load (the script is included from index.html and the section is appended to document.body when absent); that section carried only an id, so screen-reader landmark navigation had no way to reach it. The created section now sets aria-label "Agent status" (a labelled section is a region landmark); the panel's security contract is unchanged and pinned by the new test (textContent-only rendering, no innerHTML property usage, no new channels). tests/agent-panel-a11y.test.js pins the name red-first. Candidate hygiene: agent-panel.js was inspected twice and returned this one defect (its silence-on-failure and id-only-ack behaviour are pinned by design and untouched); the unstyled-question stays unverified and unclaimed. Suite 1610/1610, zero failures; benchmark SELFTEST PASS. No closed file touched.
