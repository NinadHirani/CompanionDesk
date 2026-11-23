# Memory v2 retrieval harness (offline)

Status: OFFLINE HARNESS ONLY. Nothing in `src/` or any product path reads
this directory. It exists to measure keyword retrieval quality over the
about-me memory before any memory-v2 implementation is chosen (roadmap M4),
per the phase rule: embeddings stay deferred until FTS/keyword retrieval
quality is measured and found lacking.

What is here:

- `lib/rank.js` - pure, deterministic BM25 ranking over parsed about-me
  bullets (section boost, file-order tiebreak). No network, no randomness,
  no persistence; identical inputs always rank identically.
- `fixtures/corpus.json` - 45 synthetic, generic bullets across the five
  existing sections (Facts, Goals, Routines, Preferences, Constraints),
  including `sensitive` entries. Fictional on purpose: the corpus is a
  public fixture, never real user content.
- `fixtures/queries.json` - 18 representative queries with expected bullet
  ids and the task kind they would be retrieved for (chat / screen / goal).
- `eval.js` - prints per-query recall/MRR and the aggregate.

Run: `node experiments/memory-v2-harness/eval.js`
Tests: `tests/memory-v2-harness.test.js` (runs inside the normal suite).

Baseline (no normalization, no expansion): recall 38.0%, MRR 0.395.
After slice 4 (fold-normalized synonym keys + local bridges): recall 97.2%, MRR 0.793.
Measured improvements are tracked per slice in the commit history and in
`docs/M2_MEMORY_V2_DESIGN.md`.

Prerequisite finding (23 Nov 2026): the bundled sql.js WASM build does NOT
include FTS5 (`no such module: fts5`), so any in-database FTS route would
need a different SQLite build. The harness therefore measures a pure-JS
index over the markdown file, which is the roadmap's own canonical store.
