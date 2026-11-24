# CompanionDesk Implementation Roadmap

Status: M0 and M1 are COMPLETE on main (verified 24 Nov 2026; current
baseline `d499347`, 622 passing tests, Fo-reported from a full `npm test`
run at that head (622/622, selftest included). CI, CI macOS + Linux and
Android APK green on that head (runs 45323544121, 45323543975,
45323765018). Gate 2 slice 1 (agent safety
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
source calls the driver yet. Stage B (real tools, approval mechanics)
and Stage C (renderer run controls) await separate explicit review;
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
