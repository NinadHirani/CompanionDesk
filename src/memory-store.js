'use strict';

// Memory v2 STORE CONTRACT: the pure, unwired shape a memory-v2
// implementation would expose (harness slice 5, ported from
// experiments/memory-v2-harness/lib/store.js). Nothing in the product
// calls it; docs/M2_MEMORY_V2_DESIGN.md's four open decisions gate
// implementation, and this module leaves all four untouched:
//
//   D1: sensitive flags are EXPLICIT caller input (sensitiveIds at parse
//       time, markSensitive at runtime); no `Sensitive:` prefix or any
//       on-disk format is parsed or invented, and toMarkdown() writes
//       plain bullets and drops the flags.
//   D2/D3/D4: retrieval comes from src/memory-retrieval.js (no task
//       budgets, no shipping decision, no embeddings); search() takes an
//       explicit k.
//
// The markdown About-me file stays canonical and the only memory store:
// this contract is an in-memory view over parsed bullets plus a retrieval
// method, never a second persistence layer. Sanitization, normalization,
// sections and the file preamble are REQUIRED from src/memory.js rather
// than copied, so the two implementations cannot silently diverge.

const memory = require('./memory');
const retrieval = require('./memory-retrieval');

const SECTIONS = memory.SECTIONS;
// Matches src/memory.js's internal cap (not exported there); the sanitize
// agreement test pins the cap at 200 so the two stay in lockstep.
const MAX_BULLET = 200;

// File preamble, derived from the product TEMPLATE and pinned by a test.
const PREAMBLE = TEMPLATE_PREAMBLE();
function TEMPLATE_PREAMBLE() {
  const lines = String(memory.TEMPLATE).split('\n');
  const at = lines.findIndex((line) => line.startsWith('## '));
  return lines.slice(0, at);
}

// markdown -> [{ id, section, text, sensitive? }] in file order, ids m1,
// m2, ... Bullet text before any heading counts as Facts, like the product
// parser. sensitiveIds marks whole bullets: caller input, never inferred.
function parseMarkdown(markdown, { sensitiveIds = [] } = {}) {
  const hidden = new Set(sensitiveIds);
  const items = [];
  let section = 'Facts';
  let n = 0;
  for (const line of String(markdown).split(/\r?\n/)) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) { section = h[1]; continue; }
    const b = line.match(/^\s*[-*]\s+(.*\S)\s*$/);
    if (b) {
      n += 1;
      const id = `m${n}`;
      items.push({ id, section, text: b[1], ...(hidden.has(id) ? { sensitive: true } : {}) });
    }
  }
  return items;
}

// In-memory store over parsed bullets. Mutations rebuild the retrieval
// index; search() is the measured ranker with its explicit-consent gate.
function createStore(bullets = []) {
  const items = (bullets || []).map((b) => ({
    id: String(b.id), section: String(b.section), text: String(b.text),
    ...(b.sensitive ? { sensitive: true } : {}),
  }));
  let index = retrieval.buildIndex(items);
  const rebuild = () => { index = retrieval.buildIndex(items); };

  return {
    list: () => items.map((b) => ({ ...b })),
    count: () => items.length,

    // Mirrors src/memory.js addBullet semantics: duplicate is judged within
    // the target section by normalized text; unknown sections and empty
    // bullets are rejected with the product module's error strings.
    addMemory(section, value, { sensitive = false } = {}) {
      if (!SECTIONS.includes(section)) return { ok: false, error: 'unknown_section' };
      const clean = memory.sanitizeBullet(value);
      if (!clean) return { ok: false, error: 'empty' };
      if (items.some((b) => b.section === section
        && memory.normalize(b.text) === memory.normalize(clean))) {
        return { ok: false, error: 'duplicate' };
      }
      const id = `m${items.length + 1}`;
      items.push({ id, section, text: clean, ...(sensitive ? { sensitive: true } : {}) });
      rebuild();
      return { ok: true, id, text: clean };
    },

    forgetMemory(id) {
      const at = items.findIndex((b) => b.id === id);
      if (at === -1) return { ok: false, error: 'not_found' };
      items.splice(at, 1);
      rebuild();
      return { ok: true };
    },

    markSensitive(id, value = true) {
      const b = items.find((x) => x.id === id);
      if (!b) return { ok: false, error: 'not_found' };
      if (value) b.sensitive = true; else delete b.sensitive;
      rebuild();
      return { ok: true };
    },

    search(query, { k, includeSensitive = false, synonyms = true } = {}) {
      return retrieval.search(index, query, { k, includeSensitive, synonyms });
    },

    // Sections in canonical order first, then any extra headings in
    // first-seen order, mirroring how the product parser reads files.
    // Flags are dropped: the on-disk convention is decision 1, untouched.
    toMarkdown() {
      const order = [];
      const bySection = new Map();
      for (const b of items) {
        if (!bySection.has(b.section)) { bySection.set(b.section, []); order.push(b.section); }
        bySection.get(b.section).push(b.text);
      }
      const lines = [...PREAMBLE];
      const canon = SECTIONS.filter((s) => bySection.has(s));
      const extra = order.filter((s) => !SECTIONS.includes(s));
      for (const s of [...canon, ...extra]) {
        lines.push(`## ${s}`, '');
        for (const text of bySection.get(s)) lines.push(`- ${text}`);
        lines.push('');
      }
      return lines.join('\n').replace(/\n+$/, '\n');
    },
  };
}

module.exports = {
  SECTIONS, MAX_BULLET, PREAMBLE, parseMarkdown, createStore,
  sanitizeBullet: memory.sanitizeBullet, normalize: memory.normalize,
};
