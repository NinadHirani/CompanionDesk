'use strict';

// Memory v2 STORE CONTRACT: the pure, unwired shape a memory-v2
// implementation would expose (harness slice 5, ported from
// experiments/memory-v2-harness/lib/store.js). Nothing in the product
// calls it; docs/M2_MEMORY_V2_DESIGN.md's four open decisions gate
// implementation, and this module leaves all four untouched:
//
//   D1 (decided 24 Nov 2026): explicit per-bullet marks, never a
//       `Sensitive:` prefix. A mark is a SENSITIVITY CLASSIFICATION, not
//       consent. The storage gate is fail-closed: a marked bullet is
//       NEVER written to the About-me file (toMarkdown() excludes it)
//       because no on-disk format preserves the mark yet; flagged entries
//       stay session-only, and persistSensitive() refuses even an
//       explicit yes until a safe format exists. Nothing silently
//       downgrades or drops a mark inside the store: add/forget/mark/
//       search round-trips keep it, and addMemory() reports
//       persisted:false for flagged entries.
//   D2/D3/D4 (decided 24 Nov 2026): retrieval comes from
//       src/memory-retrieval.js with the decided budgets (chat 12,
//       screen 6, goal 8, vision 0; screen-derived forced to vision 0);
//       the synonym map is frozen; embeddings stay deferred.
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
    // persisted:false for a sensitive entry is the storage gate talking:
    // the entry exists in this session's view ONLY and toMarkdown() will
    // not write it out (fail-closed; see the D1 note above).
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
      return { ok: true, id, text: clean, persisted: !sensitive };
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
      return { ok: true, persisted: !b.sensitive };
    },

    // Explicit storage consent for a sensitive entry is NOT enough today:
    // persisting would lose the mark (no on-disk format preserves it), and
    // a lost mark is a silent downgrade. Fail closed until a safe format
    // exists; the caller reports this limitation to the user.
    persistSensitive(id) {
      const b = items.find((x) => x.id === id);
      if (!b) return { ok: false, error: 'not_found' };
      if (!b.sensitive) return { ok: true, persisted: true };
      return {
        ok: false,
        error: 'sensitive_storage_blocked',
        detail: 'no on-disk format preserves the sensitive mark yet; the entry stays session-only',
      };
    },

    search(query, { k, includeSensitive = false, synonyms = true } = {}) {
      return retrieval.search(index, query, { k, includeSensitive, synonyms });
    },

    // STORAGE GATE (fail-closed): sensitive bullets are NEVER written to
    // the About-me file. There is no on-disk format that preserves the
    // mark (the prefix convention was declined), so exporting one would
    // either leak it unflagged or silently downgrade it; both are banned.
    // Sections in canonical order first, then any extra headings in
    // first-seen order, mirroring how the product parser reads files.
    toMarkdown() {
      const order = [];
      const bySection = new Map();
      for (const b of items) {
        if (b.sensitive) continue; // never persisted, never silently downgraded
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
