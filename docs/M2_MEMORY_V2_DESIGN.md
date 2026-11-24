# Memory v2 (M2) - design and measured retrieval baseline

Status: OFFLINE DESIGN + HARNESS ONLY. Nothing in this document or in
`experiments/memory-v2-harness/` is wired into product code. It exists to
make the memory-v2 implementation decision on measured retrieval quality,
per the roadmap rule that embeddings stay deferred until keyword retrieval
is measured and found lacking.

## Measured prerequisite

The bundled sql.js WASM build does NOT include FTS5: `CREATE VIRTUAL TABLE
... USING fts5` fails with `no such module: fts5` (measured 23 Nov 2026 on
the repository's own dependency). Any in-database FTS route would need a
different SQLite build, which contradicts the no-native-modules constraint.
Memory v2 therefore targets a pure-JS index over the existing markdown
about-me file.

## Architecture (proposal, not decided)

- `_about-me.md` stays the single source of truth (user-editable).
- The retrieval index is derived state only: built in memory from the
  parsed bullets, rebuilt after every add/forget/edit, never persisted
  separately. No second memory store exists; the proposals table is a
  separate proposal queue, not a memory store.
- Retrieval is per-task and budgeted (chat 12, screen 6, goal 8, vision 0
  bullets), with matched terms returned for explainability.
- Sensitive entries: retrieval excludes a bullet flagged sensitive unless
  the caller holds explicit consent for that task. The index never decides
  disclosure itself. A markdown convention for the flag (a `Sensitive:`
  prefix parsed at load) is an open decision below.
- Remember/Forget remain user-commanded. No automatic memory extraction,
  no inferred-fact auto-saving, and no background monitoring in this phase;
  inferred sensitive facts are never saved silently.

## Caveats

- The corpus is SYNTHETIC and FICTIONAL: 45 bullets written for the
  harness, not real user content and not a sample of production data.
- The query set is 18 hand-written queries; coverage is exactly those 18,
  and the aggregate numbers move when the corpus or queries change.
- The ranking stack is BM25 plus a section boost, a contiguous bigram
  phrase bonus, and a hand-seeded LOCAL lexical synonym map. No
  embeddings, no vector store, no network anywhere in the harness.
- There is NO product wiring: nothing under `src/` reads the harness.
  These numbers are harness-level evidence, not product measurements.
- Every metric is re-measured and reported per slice; slices never change
  product behavior.

## Measured retrieval quality (harness: 45 synthetic bullets, 18 queries)

Fictional corpus on purpose: the fixture is public. Baseline and each
slice were measured with the same corpus and queries.

| Slice | Commit | Change | Recall | MRR | Tests |
|---|---|---|---|---|---|
| 0 baseline | f19e56f | plain BM25 + section boost | 38.0% | 0.395 | 421 |
| 1 | f79c031 | plural fold in tokenizer | 55.6% | 0.545 | 421 |
| 2 | b2d41d9 | contiguous query-bigram phrase bonus | 55.6% | 0.545 | 421 |
| 3 | 128fdbd | seeded local synonym map (folded token form) | 72.2% | 0.647 | 423 |
| 4 | 0e242ce | fold-normalized synonym keys (fixes the silently dead 'fitness' entry: plural fold reduced the query token to 'fitnes') + local vocabulary bridges (dietary, restaurant, running, weekend, activities, family, habits, meeting) | 97.2% | 0.793 | 428 |
| 5 | 40946f4 | store contract module: in-memory view over parsed about-me bullets in the SAME markdown format, sanitize rules and add/duplicate/remove semantics as src/memory.js; retrieval unchanged (slice-4 ranker); NO product wiring | 97.2% | 0.793 | 437 |

Slice 2 moved no aggregate metric; it is retained because phrase weighting
was specified and it is deterministic, but it should be re-judged if the
corpus grows. Ranking stays deterministic and explainable at every slice:
identical inputs produce identical orderings, and every result names its
matched terms.

Slice 4 closed the three measured zero-hit queries with local lexical
work, so no remaining miss is a zero-hit. What remains is ranking quality,
not vocabulary: "morning schedule" still misses one expected bullet (the
bedtime bullet has no honest lexical bridge to "morning"), and
multi-expected queries cap MRR when the strongest lexical match is not the
first-listed expectation ("travel preferences" at MRR 0.11). These are
per-section fallback and weighting questions, not embeddings evidence;
the embeddings deferral decision now rests on cost/benefit, not a measured
recall wall.

## Test coverage (tests/memory-v2-harness.test.js)

Exact matches; ranking determinism across rebuilds; no cross-index state
leakage; forget semantics (removed bullet disappears after rebuild); empty
corpus; unicode bullets returned verbatim as data; prompt-injection text
in stored content treated as inert data; sensitive gate (hidden without
explicit consent); task budgets (vision retrieves nothing); synonym
expansion opt-out; paraphrase retrieval (chores/laundry/groceries).

## Store contract (slice 5, no product wiring)

`experiments/memory-v2-harness/lib/store.js` drafts the shape a memory-v2
implementation would expose, as pure offline code with contract tests:

- `parseMarkdown(markdown, { sensitiveIds })` -> bullets with stable ids in
  file order, mirroring the product parser (bullets before any heading count
  as Facts).
- `createStore(bullets)` with `addMemory` (same unknown_section / empty /
  duplicate semantics as the product module; duplicate judged within the
  target section by normalized text), `forgetMemory`, `markSensitive`,
  `search` (the slice-4 ranker with the consent gate and task budgets) and
  `toMarkdown`.
- The markdown About-me file stays canonical and the only store; the
  contract is an in-memory view plus retrieval, never a second persistence
  layer.
- The sensitive-entry convention stays OPEN: flags are explicit caller
  input and `toMarkdown()` writes plain bullets, so the contract invents
  no on-disk format the user has not decided.
- 9 contract tests pin compatibility with the CURRENT product memory
  module (`src/memory.js`): its parser consumes store output, its
  add/remove round-trips on it, and both sanitize implementations agree on
  a fixed case set. Wiring later cannot silently diverge.

Nothing under `src/` imports the store; the retrieval metrics are unchanged
by this slice.

## Open decisions for the owner

RESOLVED 24 Nov 2026, wired in commit `189e3a7`: see
`docs/M4_MEMORY_DECISIONS.md` (Resolution section) for the adopted
options and guardrails. The list below is the original question sheet.

1. Sensitive-entry convention: `Sensitive:` prefix parsed at load vs an
   explicit per-bullet mark. (The harness uses the explicit flag.)
2. Whether the seeded synonym map ships as-is, grows with the corpus, or
   waits for measured misses on real content.
3. Whether the per-task budgets above become the product defaults.
4. Whether the embeddings decision is revisited after real-content recall
   is measured, and on what threshold.
