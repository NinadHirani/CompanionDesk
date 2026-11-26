# M4 memory v2: the four open decisions (recommendation sheet, 24 Nov 2026)

Status: RESOLVED (24 Nov 2026) AND WIRED. The owner accepted the
conservative recommendations and authorized the wiring in the same
session; commit `189e3a7` implemented the decisions as working defaults
with explicit guardrails. The option discussion below is kept as the
record of what was weighed; where it says a decision is still open, that
sentence is historical. What ACTUALLY remains open is listed under
"What stays gated" at the bottom.

## Resolution (24 Nov 2026, wiring commit `189e3a7`)

Verbatim from the wiring commit (the authoritative record):

- D1 sensitive entries: explicit per-bullet mark, never a `Sensitive:`
  prefix; a mark is a sensitivity CLASSIFICATION, not consent. The
  storage gate is fail-closed: sensitive bullets are NEVER written to
  the About-me file (`toMarkdown` excludes them), addMemory/markSensitive
  report `persisted:false`, and `persistSensitive()` refuses even an
  explicit yes because no on-disk format preserves the mark yet.
  Flagged entries stay session-only.
- D2 synonyms: the frozen map ships exactly as measured; a test pins its
  exact contents so any change is a documented benchmark event.
- D3 budgets: chat=12, screen=6, goal=8, vision=0 as frozen tunable
  defaults. Vision AND screen-derived asks (derivedFrom:'screen')
  retrieve ZERO memory, always-on sections included, before any
  selection runs.
- D4 embeddings: deferred; the 70%/0.5 numbers are a measurement gate
  only, never permission to download or install anything.

Wiring: `src/memory-retrieval.js` carries BUDGETS + selectForTask with
the screen-derived force-zero rule; `src/persona.js` selectMemories runs
the measured ranker (BM25 + section boost + bigram bonus + frozen
synonyms), budget-capped per task; `src/personal.js` passes task 'chat'
(budget 12); `src/screen-service.js` passes task 'vision' and its persona
carries zero memory lines.

## What the pure port contained as of `89b9b70` (true then; wiring superseded it)

`src/memory-retrieval.js` and `src/memory-store.js` are a direct port of
the measured harness core (slices 0-5) into product-shaped pure modules:

- NO product wiring at the time of `89b9b70`: no `src/` file outside the
  pair required them. Superseded by `189e3a7`, which wires the ranker into
  the persona/chat path and the storage gate into the store.
- NO sensitive convention: flags stay explicit caller input
  (`sensitiveIds` at parse, `markSensitive` at runtime); nothing parses a
  `Sensitive:` prefix (decision 1 untouched); `toMarkdown()` writes plain
  bullets and drops flags.
- NO task budgets: the harness's `selectForTask` and its
  `{chat:12, screen:6, vision:0, goal:8}` defaults were deliberately NOT
  ported (decision 3 untouched); retrieval takes an explicit `k`.
- The seeded synonym map rides along as inert, auditable data inside the
  unwired ranker so the port is exactly the measured slice-4 ranker
  (recall 97.2%, MRR 0.793 on the harness corpus). Whether it ever "ships"
  into a live ask path is decision 2, untouched.
- Tests: `tests/memory-retrieval.test.js`, `tests/memory-store.test.js`
  (contract pins against `src/memory.js`, wiring lock, sensitive gate,
  determinism, injection inertness, unicode).

## Decision 1: sensitive-entry convention

Exact wording: "`Sensitive:` prefix parsed at load vs an explicit
per-bullet mark. (The harness uses the explicit flag.)"

- Option A: `Sensitive:` prefix parsed at load. The file is
  self-describing; the user can flip a flag in any editor; no extra state
  exists. Costs: the flag lives in the bullet text, so it leaks into every
  consumer of the file (exports, the UI, anything that shows bullets
  verbatim); a hand edit that drops or mangles the prefix silently
  un-flags an entry; and `addBullet`/`removeBullet` round-trips must learn
  to preserve the prefix, which is new product logic.
- Option B: explicit per-bullet mark (harness behavior). The file stays
  clean and the gate is unambiguous. Costs: the mark currently has no
  durable home (the index is derived state and `toMarkdown()` drops it),
  so flags would not survive an app restart unless a persistence home is
  chosen; and marking needs a UI or command path.
- RECOMMENDED CONSERVATIVE DEFAULT: Option B (explicit marks), with the
  persistence home raised as its own sub-decision before any wiring. It
  keeps the strongest failure mode (a silently lost prefix on a hand
  edit) out of the design, and it is what the measured harness behavior
  already pins. Do NOT implement either convention until you decide. (Superseded 24 Nov 2026: decided and wired, see Resolution.)

## Decision 2: the seeded synonym map

Exact wording: "Whether the seeded synonym map ships as-is, grows with
the corpus, or waits for measured misses on real content."

- Option A: ships as-is, frozen and auditable. Immediate measured value
  (synonym work took recall 55.6% -> 97.2% on the harness corpus); risk:
  a hand-authored pair can silently reshuffle real-content rankings.
- Option B: grows with the corpus. Adaptive, but each growth step is a
  new silent ranking change unless every entry is measured and reviewed.
- Option C: waits for measured misses on real content. Safest; delays
  value until a real-content query log exists.
- RECOMMENDED CONSERVATIVE DEFAULT: C at wiring time, with A's frozen
  map as the starting resource the moment the first real-content misses
  are measured (i.e. C first, then A, never B without per-entry review).
  Every result already names its matched terms, so misses are auditable.

## Decision 3: per-task budgets as product defaults

Exact wording: "Whether the per-task budgets above become the product
defaults." (chat 12, screen 6, goal 8, vision 0 bullets.)

- Option A: adopt as product defaults. Bounded prompts, and vision 0 is
  the privacy-safe default (screen-derived asks never pull memory).
- Option B: pick different numbers after real use.
- Option C: no per-task budgets; one global cap.
- RECOMMENDED CONSERVATIVE DEFAULT: A, as shipped-in-code constants the
  owner can later tune, precisely because vision 0 and small chat/screen
  caps are the fail-safe direction (less memory surfaced, never more).
  Untouched until you say so; nothing in product code carries them now. (Superseded 24 Nov 2026: adopted as wired defaults, see Resolution.)

## Decision 4: revisiting embeddings

Exact wording: "Whether the embeddings decision is revisited after
real-content recall is measured, and on what threshold."

- Options: keep embeddings deferred permanently; revisit after a
  real-content recall measurement; revisit on a stated numeric threshold.
- RECOMMENDED CONSERVATIVE DEFAULT: keep deferred, with an explicit
  numeric trigger once real content exists: revisit only if measured
  recall-at-budget on real tasks falls below 70% (or MRR below 0.5) with
  the lexical ranker, since the local-first/free-first constraints rule
  out any model download and the harness shows no recall wall left
  (remaining misses are ranking-quality, not vocabulary). The threshold
  number itself is yours to set; 70%/0.5 is a placeholder, not a decision.

## What actually stays gated (after the 24 Nov 2026 resolution)

- The ON-DISK persistence home for sensitive marks: RESOLVED 26 Nov 2026
  (decision-sheet item 6, commit `78a9f63`): a session-only sidecar
  (`src/memory-sidecar.js`) holds marks and session-only sensitive
  entries; there is deliberately NO on-disk format, and
  `persistSensitive()` still refuses (`sensitive_storage_blocked`).
- Any embeddings work (decision 4): revisits only through the measured
  70%/0.5 gate, and even then a model download needs separate approval.
- The v2 store contract itself is NOW WIRED (24 Nov 2026, later the same
  day): `src/memory-session.js` runs it as the product's in-session view
  in front of the canonical About-me file, which keeps its single-bullet
  write semantics and is never rewritten whole. The sensitive gate is
  unchanged: marks stay session-only, `persistSensitive()` refuses, no
  product surface passes sensitive entries, and the 26 Nov 2026 decision
  resolves this deliberately: no on-disk format exists; sensitive state
  lives only in the session-only sidecar.

Gate 1 device validation is unaffected: the desktop runbook matrix stands
in the roadmap; no device validation is claimed here.
