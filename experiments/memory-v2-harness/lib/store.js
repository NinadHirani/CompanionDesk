'use strict';

// Memory v2 STORE CONTRACT (harness slice 5): the pure, offline shape a
// memory-v2 implementation would expose, written against the SAME markdown
// format and sanitization rules the current product memory module uses
// (src/memory.js). This is a proposal to measure and review, NOT product
// code: nothing under src/ imports it, and no behavior changes until the
// design doc's open decisions are decided by the user.
//
// The markdown About-me file stays canonical and the only memory store, as
// the design doc requires: this contract is an in-memory view over parsed
// bullets plus a retrieval method, never a second persistence layer.
//
// Deliberately UNDECIDED here (tracked as open decisions in
// docs/M2_MEMORY_V2_DESIGN.md): the on-disk sensitive-entry convention.
// Sensitive flags are therefore explicit caller input (a sensitiveIds list
// at parse time or markSensitive at runtime); toMarkdown() writes plain
// bullets and drops the flags, which is exactly why the convention is an
// open decision and not silently invented here.

const rankLib = require('./rank');

const SECTIONS = Object.freeze(['Facts', 'Goals', 'Routines', 'Preferences', 'Constraints']);
const MAX_BULLET = 200;

// Identical algorithm to src/memory.js sanitizeBullet: one line, no markdown
// markers, control characters collapsed, capped at MAX_BULLET. A contract
// test pins the two implementations to the same behavior so wiring later
// cannot silently diverge.
function sanitizeBullet(value) {
  const text = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/^[\s>#*\-+]+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_BULLET)
    .trim();
  return text || null;
}

function normalize(text) {
  return String(text).toLowerCase().replace(/\s+/g, ' ').replace(/[.\s]+$/, '').trim();
}

const HEADING = /^##\s+(.+?)\s*$/;
const BULLET = /^\s*[-*]\s+(.*\S)\s*$/;

// markdown -> [{ id, section, text, sensitive? }] in file order, ids m1, m2,
// ... Bullet text before any heading counts as Facts, like the product
// parser. sensitiveIds marks whole bullets (the open convention: caller
// input, never inferred).
function parseMarkdown(markdown, { sensitiveIds = [] } = {}) {
  const hidden = new Set(sensitiveIds);
  const items = [];
  let section = 'Facts';
  let n = 0;
  for (const line of String(markdown).split(/\r?\n/)) {
    const h = line.match(HEADING);
    if (h) { section = h[1]; continue; }
    const b = line.match(BULLET);
    if (b) {
      n += 1;
      const id = `m${n}`;
      items.push({ id, section, text: b[1], ...(hidden.has(id) ? { sensitive: true } : {}) });
    }
  }
  return items;
}

// Header lines mirror the product template so toMarkdown() output is
// byte-shape compatible with what src/memory.js reads and writes.
const HEADER = [
  '# About me',
  '',
  'Written by you and CompanionDesk. Edit it, add lines, or delete any line to',
  'make CompanionDesk forget it. Nothing in this file leaves your computer unless',
  'you turn that on in settings.',
  '',
];

// In-memory store over parsed bullets. Mutations rebuild the retrieval index;
// search() is the harness ranker with its consent gate and task budgets.
function createStore(bullets = []) {
  const items = (bullets || []).map((b) => ({
    id: String(b.id), section: String(b.section), text: String(b.text),
    ...(b.sensitive ? { sensitive: true } : {}),
  }));
  let index = null;
  const rebuild = () => { index = rankLib.buildIndex(items); };
  rebuild();

  return {
    list: () => items.map((b) => ({ ...b })),
    count: () => items.length,

    // Mirrors src/memory.js addBullet semantics: duplicate is judged within
    // the target section by normalized text; the clean bullet is appended
    // after the section's last bullet.
    addMemory(section, value, { sensitive = false } = {}) {
      if (!SECTIONS.includes(section)) return { ok: false, error: 'unknown_section' };
      const clean = sanitizeBullet(value);
      if (!clean) return { ok: false, error: 'empty' };
      if (items.some((b) => b.section === section && normalize(b.text) === normalize(clean))) {
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

    search(query, { task, includeSensitive = false, ...opts } = {}) {
      return rankLib.selectForTask(index, query, task, { includeSensitive, ...opts });
    },

    // Sections in canonical order first, then any extra headings in
    // first-seen order, mirroring how the product parser reads files.
    toMarkdown() {
      const order = [];
      const bySection = new Map();
      for (const b of items) {
        if (!bySection.has(b.section)) { bySection.set(b.section, []); order.push(b.section); }
        bySection.get(b.section).push(b.text);
      }
      const lines = [...HEADER];
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

module.exports = { SECTIONS, MAX_BULLET, HEADER, sanitizeBullet, normalize, parseMarkdown, createStore };
