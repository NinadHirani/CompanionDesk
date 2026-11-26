# CompanionDesk Architecture Decisions

Status: **proposed** (M0 baseline). This is the ADR log for the transformation
plan. No decision is Accepted: every entry is Proposed, Needs validation, or
Needs user decision, and acceptance requires Ninad's explicit approval.

## ADR-0001 - Preserve Electron + Capacitor; no rewrite
Proposed. Evidence: the pure-module architecture (pure logic in `src/*.js`,
thin Electron wrappers), the strict IPC allowlist, the 258-test suite, and
green CI all survived eight feature merges. A rewrite would discard proven
safety properties for no measured benefit.

## ADR-0002 - Shared contracts with platform adapters
Proposed. One interface per capability (`src/contracts/`): intelligence,
tools, notifications, voice, screen, platform actions, memory-index. Desktop
code is the first implementation; per-OS and Android adapters implement the
same contracts. Core modules never import Electron.

## ADR-0003 - Provider/model registry with task-aware routing
Proposed. Registry entries carry capabilities, context size, RAM estimate,
and license metadata; the router (`src/router.js`) is pure, deterministic,
and unit-tested. Privacy mode `local-only` never routes to cloud. Replaces
the current hardcoded `llama3.2:latest` / `gemma3:4b` constants.

## ADR-0004 - Hardware profiles
Proposed. `os.totalmem`/`cpus` probe maps devices to lightweight, balanced,
and powerful profiles that bound model choice.

## ADR-0005 - Android on-device inference candidate: llama.cpp JNI
Needs validation. MIT-licensed, mature, CPU/mmap of quantized models. MLC LLM
(Apache-2.0, GPU-accelerated, chipset-dependent) is the secondary comparison.
Decision follows the Gate 1 benchmark on the OnePlus 12R; nothing is chosen
before those numbers exist.

## ADR-0006 - Desktop gateway for Android: token-authenticated LAN proxy
Needs user decision (exposure) and validation (implementation). Default:
LAN-only, token-gated, Ollama bound to localhost, disabled until Gate 1.

## ADR-0007 - Agent: typed tool registry + external policy engine
Proposed. Tools carry typed schemas and capability classes (read-only,
reversible-write, sensitive, forbidden). The forbidden class means a tool is
denied on model authority or standing grants and runs only after fresh,
explicit user approval immediately before execution. Approval classes:
routine reversible actions inside explicit grants; sensitive actions behind
confirm cards. Payments, purchases, destructive deletion, and legal or
binding submissions must not be executed by the agent based on model
authority or standing grants; they require fresh, explicit user approval
immediately before execution, and are denied otherwise. Orchestrator loop
with plan/act/observe/verify/recover; append-only audit log; global
emergency stop; no unrestricted shell, filesystem, browser, or OS access for
the model; prompt-injection defenses are structural. Gate 2 requires this
framework to prove refusal of ungranted calls before any computer-control
tool exists.

## ADR-0008 - Memory: markdown canonical, FTS index first
Proposed. The About-me file stays the source of truth; an FTS or keyword
index adds selective retrieval. Embeddings and vector storage are deferred
until retrieval quality is measured and found lacking. Prerequisite: verify
sql.js FTS5 availability.

## ADR-0009 - Wake word: openWakeWord POC only, nothing bundled
Needs user decision. openWakeWord code is Apache-2.0; its pretrained models
are reported CC BY-NC-SA 4.0 (unverified). Default: POC for evaluation;
bundling blocked pending license review; self-trained or alternative models
as fallback. Wake word stays behind a separate auto-listening toggle, off by
default, with visible mic state and immediate stop.

## ADR-0010 - TTS: OS-native only
DECIDED by Ninad on 26 Nov 2026 (decision-sheet item 7): the only TTS
engine is the OS's own voice stack through the standard speechSynthesis
interface; no bundled model or asset, no download, no external service,
no paid dependency, no third-party TTS engine. piper1-gpl (the verified
successor, GPL-3.0) stays DEFERRED and unbundled; adopting it or any
other engine or voice asset requires Ninad's explicit reopening of this
decision. Guarded by tests/m6-tts-decision.test.js.

## ADR-0011 - Model licensing stance
Needs user decision. License status is judged per exact model and version,
including its bundled assets, never by family reputation. Permissive
licenses (Apache-2.0, MIT) are preferred, but no model is bundled as a
default until its exact license is checked. Gemma and Llama remain strictly
user-installed pending that review.

## ADR-0012 - Distribution and signing posture
Needs user decision. Current state: unsigned desktop builds with
manual-download updates; debug-signed Android preview. Default: keep this
until Ninad decides; third-party costs (Apple Developer Program, Windows
code-signing certificate, Google Play registration) are disclosed in
PRODUCT_BLUEPRINT.md and require explicit approval before any payment.

## ADR-0013 - Cloud providers: Gemini plus an OpenAI-compatible adapter
Needs user decision. Default: keep Gemini (already coded) and add a generic
OpenAI-compatible adapter that also serves the Android-to-desktop gateway.
No private prompt, file, screenshot, or memory reaches any cloud provider
without explicit consent; the existing `cloudArgs` stripping and
`cloud_personal: false` default remain the backbone.
