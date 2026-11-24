# CompanionDesk Implementation Roadmap

## Governing programme order (evidence-based, 24 Nov 2026)

This file is the PRIMARY product programme and it governs the sequence.
Main head at this writing: `897b5d0`.

| Phase | Status | Evidence |
|---|---|---|
| M0 product foundation | COMPLETE | 23 Nov 2026 slices on main (model selection `model-selection.js`, conversation history `chat-history.js`, Gemini key in secure storage `secure-store.js`); docs baseline main `6e7a975`; suite green throughout |
| M1 intelligence core | COMPLETE | completion head `bccfa75` is an ancestor of main (verified `git merge-base --is-ancestor` 24 Nov 2026); six slices landed 23 Nov 2026 incl. provider health (`provider-status.js`, slice 4) and per-ask routing with live Ollama probes (slice 2); review fix `d36dc01` also an ancestor |
| GATE 1 Android intelligence | PREPARED, NOT RUN | repo-only scaffold `experiments/android-inference-benchmark/` (metrics, fairness rules, acceptance criteria, owner runbook, desktop matrix below); no device measurement exists; blocked on physical OnePlus 12R time |
| GATE 2 agent foundation | IN PROGRESS (security workstream, SUPPORTS the product phases) | slices 1-4, persistence wiring, 3j.3-3j.6 notification gates, run-driver Stage A (3j.9) implemented; remaining gates (scheduling, file output) and run-driver Stage B/C await separate explicit review; the Stage B proposal (3j.10) is docs-only. Per Ninad's 24 Nov direction the run-driver work is PAUSED at the proposal; it is not the product roadmap |
| M4 memory v2 | design + harness complete, NOT implemented in product | `docs/M2_MEMORY_V2_DESIGN.md`, `experiments/memory-v2-harness/`; FOUR open decisions gate implementation |
| M5 proactive / M6 voice / M7 screen understanding v2 / M8 integrations + workspace UI | NOT IMPLEMENTED | definitions below are plans only |

Verified current state: full `npm test` at `897b5d0` on 24 Nov 2026:
735/735 pass, selftest PASS; CI and CI macOS+Linux green on that head
(runs 45353283588, 45353283702). The last src-affecting commit is Stage A
`83dbcda` (CI green; Android APK run 45344402037).

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
is wanted as M9, that needs Ninad's explicit definition first.

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
unless stated as implemented; M0 and M1 are the only implemented phases.

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
  null (API model, no weights license fact). OPEN QUESTION recorded in the
  entry, not resolved: multiple third-party indexes report this id was
  RETIRED around June 2026; Google's own deprecation pages did not render
  for our tooling (404/blank), so the retirement is UNVERIFIED against a
  primary source. The default cloud model is unchanged. Replacing it with a
  current Flash id is Ninad's explicit product decision, not a silent one.

Router behavior is untouched: same tasks, same privacy rules, same
consent gates. 7 registry tests (was 5); full suite 867/867 + selftest.

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

STATUS: unimplemented in product; offline design + harness complete
(23 Nov 2026). Prerequisite answered by measurement: sql.js's WASM build
has NO FTS5, so the route is a pure-JS index over the existing markdown
About-me file (which stays canonical, the only memory store). Selective
per-task retrieval; Remember/Forget commands; consent gate for sensitive
entries; embeddings stay deferred. Measured keyword baseline and slice
results (recall 38.0% -> 97.2%, MRR 0.395 -> 0.793 on the 18-query harness;
no zero-hit queries remain; what is left is ranking quality, not
vocabulary) and the full design: see `docs/M2_MEMORY_V2_DESIGN.md` and
`experiments/memory-v2-harness/`. A pure store-contract slice (5) is
drafted and contract-tested against the current memory module, still
with NO product wiring; the four open decisions gate implementation.
see `docs/M2_MEMORY_V2_DESIGN.md` and `experiments/memory-v2-harness/`.
No automatic extraction, no inferred-fact auto-saving, no background
monitoring in this phase.

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
`persistSensitive` fail-closed). The v2 store contract itself remains
unwired (the product still runs the file-backed `src/memory.js` flow);
replacing that flow is a later reviewed slice. No automatic extraction,
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
23:30-08:00, nothing fires until the user enables it) until reviewed.

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

Multilingual whisper model option wired to the existing `language` setting;
OS-native text-to-speech first (Piper deferred pending verification of its
successor project); wake word only after the licensing decision, behind a
separate auto-listening toggle, off by default, visible mic state, immediate
stop; Android foreground service compliant with platform rules.

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
