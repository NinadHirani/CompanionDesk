'use strict';

// Memory v2 retrieval harness: pure, offline ranking over parsed about-me
// bullets. Nothing here touches product code; it exists to measure keyword
// retrieval quality BEFORE any M2 (roadmap M4, memory v2) implementation is
// chosen. Deterministic by construction: no randomness, no network, no
// external state; identical inputs always produce identical rankings.

// BM25 (k1=1.2, b=0.75) over bullets, plus a small section-name boost and a
// file-order tiebreak. No stemming: the corpus is short bullet lines where
// vocabulary is dense, and stems hurt precision on names.

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

// opts: { k, includeSensitive } — sensitive bullets are excluded unless
// includeSensitive is exactly true (the consent gate is the caller's job;
// the index itself never decides to disclose).
function search(index, query, opts) {
  const o = opts || {};
  const k = o.k == null ? 10 : o.k;
  const qTokens = tokenize(query);
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

// Task-scoped retrieval budgets (proposal under test, not a product rule).
const BUDGETS = { chat: 12, screen: 6, vision: 0, goal: 8, default: 8 };

function selectForTask(index, query, task, opts) {
  const o = opts || {};
  const budget = BUDGETS[task] == null ? BUDGETS.default : BUDGETS[task];
  if (budget === 0) return [];
  return search(index, query, { ...o, k: budget });
}

module.exports = { tokenize, buildIndex, search, selectForTask, BUDGETS, K1, B };
