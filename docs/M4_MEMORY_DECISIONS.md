# M4 memory v2: the four open decisions (recommendation sheet, 24 Nov 2026)

Status: RECOMMENDATION SHEET ONLY. Nothing here is decided. The four
decisions below are quoted from `docs/M2_MEMORY_V2_DESIGN.md` ("Open
decisions for the owner") and remain the owner's calls. This sheet exists
so decision-dependent work has a concrete, reviewable recommendation to
approve or overrule, and so implementation work that does NOT depend on
them is separable from work that does.

## What was implemented WITHOUT any of the four decisions

`src/memory-retrieval.js` and `src/memory-store.js` are a direct port of
the measured harness core (slices 0-5) into product-shaped pure modules:

- NO product wiring: no `src/` file outside the pair requires them (a test
  scans and pins this), and no behavior of the running app changes.
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
  already pins. Do NOT implement either convention until you decide.

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
  Untouched until you say so; nothing in product code carries them now.

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

## What stays gated on these decisions

- Any wiring of retrieval into chat/screen/goal ask paths (decisions 2+3).
- Any persistence or on-disk format for sensitive flags (decision 1).
- Any embeddings work (decision 4).
- Any change to `src/memory.js`'s public behavior.

Gate 1 device validation is unaffected: the desktop runbook matrix stands
in the roadmap; no device validation is claimed here.
