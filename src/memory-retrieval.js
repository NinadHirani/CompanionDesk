'use strict';

// Memory v2 retrieval core: the measured harness ranker (BM25 + section
// boost + contiguous bigram phrase bonus + fold-normalized seeded synonym
// map), ported from experiments/memory-v2-harness/lib/rank.js as a PURE
// library. It is WIRED in product as M4 slices 1-2: persona selection
// (src/persona.js) runs on the decided budgets below, and the memory v2
// store (src/memory-store.js) builds on this contract. The four decisions
// were resolved by the owner on 24 Nov 2026 (docs/M4_MEMORY_DECISIONS.md,
// "Status: RESOLVED"; full design in docs/M2_MEMORY_V2_DESIGN.md):
//
//   D1 sensitive-entry convention: explicit per-bullet marks (NOT a
//      `Sensitive:` prefix). A mark is a SENSITIVITY CLASSIFICATION, not
//      consent: retrieval excludes a marked bullet unless the caller holds
//      explicit consent for that call (includeSensitive). Storing one is
//      a separate gate: see src/memory-store.js (fail-closed).
//   D2 synonym map: the seeded map SHIPS as this frozen, auditable map
//      (owner decision 24 Nov 2026: keep the current frozen map; growth
//      requires measured real-content misses and a documented benchmark;
//      a test pins the exact map contents so any change is a reviewed
//      benchmark event, never a silent edit).
//   D3 task budgets: DECIDED by the owner 24 Nov 2026 - chat 12, screen 6,
//      goal 8, vision 0, as tunable conservative defaults. Vision AND any
//      screen-derived request retrieve ZERO memory by default
//      (derivedFrom: 'screen' forces the vision budget); only explicit
//      user control may change that later.
//   D4 embeddings: deferred; a numeric trigger (recall < 70% or MRR < 0.5
//      on a real representative corpus) is a MEASUREMENT GATE only, never
//      permission to download or install anything.
//
// Deterministic by construction: no randomness, no network, no external
// state; identical inputs always produce identical rankings, and every
// result names its matched terms.

const K1 = 1.2;
const B = 0.75;
const SECTION_BOOST = 1.25; // tokens also present in the section name count extra
const PHRASE_BONUS = 0.5;   // per contiguous query bigram found in the bullet
const STOPWORDS = new Set(('a an and are as at be by for from has have in is it its of on or that the '
  + 'this to was were will with').split(' '));

// Plural fold: 'meetings'/'meeting' collapse for tokens >= 4 chars. Cheap,
// deterministic, and measured to raise recall without hurting precision on
// this corpus (names and domains like c++ are untouched).
function fold(t) {
  return t.length >= 4 && t.endsWith('s') ? t.slice(0, -1) : t;
}

function tokenize(text) {
  return String(text)
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t))
    .map(fold);
}

// Seeded synonym expansion: a small hand-written LOCAL lexical resource
// (no network, no cloud, no embeddings). One hop, symmetrical. Inert until
// a caller opts in; the map is explicit and auditable in this file. Keys
// and values are in FOLDED token form (the plural fold runs before
// expansion), so expansion and document tokens always agree.
const SYNONYMS = {
  chore: ['laundry', 'grocerie', 'watering', 'cleaning'],
  laundry: ['chore', 'washing'],
  diet: ['eat', 'food', 'allergic'],
  eat: ['diet', 'food', 'allergic', 'spice'],
  dietary: ['diet', 'food', 'allergic'],
  restaurant: ['eat', 'food', 'dining'],
  running: ['run', 'marathon'],
  fitness: ['run', 'marathon', 'exercise'],
  weekend: ['saturday', 'sunday'],
  activities: ['hobby', 'volunteer', 'club'],
  family: ['parents', 'sibling'],
  habits: ['planning', 'plans', 'routine'],
  meeting: ['call', 'appointment'],
  credential: ['password', 'locker', 'passport'],
  document: ['scan', 'paperwork', 'transcript'],
};

// Query tokens are plural-folded BEFORE lookup, so a written key like
// 'fitness' (which folds to 'fitnes') still fires. Normalize the map once
// at load: keys AND values go through fold().
const FOLDED_SYNONYMS = {};
for (const [key, values] of Object.entries(SYNONYMS)) {
  const fk = fold(key);
  const list = FOLDED_SYNONYMS[fk] || (FOLDED_SYNONYMS[fk] = []);
  for (const v of values) if (!list.includes(fold(v))) list.push(fold(v));
}

function expand(tokens) {
  const out = new Set(tokens);
  for (const t of tokens) {
    for (const syn of FOLDED_SYNONYMS[t] || []) out.add(syn);
  }
  return [...out];
}

// items: [{ id, section, text, sensitive? }] in file order.
function buildIndex(items) {
  const docs = items.map((it, i) => {
    const secTokens = tokenize(it.section);
    const body = tokenize(it.text);
    const tf = new Map();
    for (const t of body) tf.set(t, (tf.get(t) || 0) + 1);
    for (const t of secTokens) {
      if (tf.has(t)) tf.set(t, tf.get(t) + SECTION_BOOST);
      else tf.set(t, SECTION_BOOST);
    }
    return { ...it, order: i, tf, toks: body, len: body.length || 1 };
  });
  const df = new Map();
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  const avgLen = docs.reduce((s, d) => s + d.len, 0) / Math.max(docs.length, 1);
  return { docs, df, avgLen, n: docs.length };
}

// opts: { k = 10, includeSensitive, synonyms = true }. A sensitive bullet
// is excluded unless includeSensitive is exactly true: the consent gate is
// the caller's job; the index itself never decides to disclose. k is an
// explicit retrieval depth, NOT a per-task budget (that is decision 3).
function search(index, query, opts) {
  const o = opts || {};
  const k = o.k == null ? 10 : o.k;
  const qTokens = o.synonyms === false ? tokenize(query) : expand(tokenize(query));
  const out = [];
  for (const d of index.docs) {
    if (d.sensitive && o.includeSensitive !== true) continue;
    let score = 0;
    const matched = [];
    for (const t of qTokens) {
      const f = d.tf.get(t);
      if (!f) continue;
      const dfv = index.df.get(t) || 1;
      const idf = Math.log(1 + (index.n - dfv + 0.5) / (dfv + 0.5));
      score += idf * (f * (K1 + 1)) / (f + K1 * (1 - B + B * (d.len / index.avgLen)));
      matched.push(t);
    }
    // Phrase bonus: contiguous query bigrams in the bullet's own token
    // order. Deterministic, purely lexical, and explainable (counted).
    let phraseHits = 0;
    for (let j = 0; j + 1 < qTokens.length; j++) {
      const pair = qTokens[j];
      const nxt = qTokens[j + 1];
      for (let w = 0; w + 1 < d.toks.length; w++) {
        if (d.toks[w] === pair && d.toks[w + 1] === nxt) { phraseHits += 1; break; }
      }
    }
    score += phraseHits * PHRASE_BONUS;

    if (matched.length || phraseHits) {
      out.push({ id: d.id, section: d.section, text: d.text, score, matched });
    }
  }
  out.sort((a, b) => (b.score - a.score) || (a.order - b.order));
  return out.slice(0, k);
}

// ---- task budgets (decided 24 Nov 2026, tunable conservative defaults) ------

// Total retrieved bullets per task kind. vision is 0 BY DEFAULT and any
// request derived from screen content is forced to the vision budget: the
// only change later is explicit user control. Keep these numbers
// conservative; raising one is a reviewed change, never a convenience.
const BUDGETS = Object.freeze({ chat: 12, screen: 6, vision: 0, goal: 8, default: 8 });

// opts: { k?, includeSensitive?, synonyms?, derivedFrom? }. derivedFrom:
// 'screen' forces the vision budget (0) whatever the task, so an ask whose
// content came from a captured screen can never pull memory by default.
function selectForTask(index, query, task, opts) {
  const o = opts || {};
  let budget = BUDGETS[task] == null ? BUDGETS.default : BUDGETS[task];
  if (o.derivedFrom === 'screen') budget = BUDGETS.vision;
  if (budget === 0) return [];
  return search(index, query, {
    includeSensitive: o.includeSensitive,
    synonyms: o.synonyms,
    k: budget,
  });
}

module.exports = {
  tokenize, buildIndex, search, expand, fold, SYNONYMS, FOLDED_SYNONYMS,
  K1, B, SECTION_BOOST, PHRASE_BONUS, STOPWORDS, BUDGETS, selectForTask,
};
