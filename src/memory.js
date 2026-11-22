'use strict';

// "About me": the user's own markdown file. It is the source of truth for
// everything the user has told the assistant, so they can open it, edit it by
// hand, or delete a line to make it forget. The app never rewrites the whole
// file: it adds or removes single bullet lines, so manual edits survive.
//
// Format: bullets under "## Section" headings. Pure string functions first,
// thin fs wrappers last.

const fs = require('fs');
const path = require('path');

const SECTIONS = Object.freeze(['Facts', 'Goals', 'Routines', 'Preferences', 'Constraints']);
const MAX_BULLET = 200;

const TEMPLATE = [
  '# About me',
  '',
  'Written by you and CompanionDesk. Edit it, add lines, or delete any line to',
  'make CompanionDesk forget it. Nothing in this file leaves your computer unless',
  'you turn that on in settings.',
  '',
  ...SECTIONS.flatMap((s) => [`## ${s}`, '']),
].join('\n');

// One line, no markdown markers, capped. Returns null when nothing is left, so
// pasted text can never start a new heading or smuggle in extra lines.
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

// -> [{ section, text }] in file order. Bullets before any heading count as Facts.
function parse(markdown) {
  const items = [];
  let section = 'Facts';
  for (const line of String(markdown).split(/\r?\n/)) {
    const h = line.match(HEADING);
    if (h) { section = h[1]; continue; }
    const b = line.match(BULLET);
    if (b) items.push({ section, text: b[1] });
  }
  return items;
}

function findSectionRange(lines, section) {
  const wanted = normalize(section);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(HEADING);
    if (h && normalize(h[1]) === wanted) { start = i; break; }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (HEADING.test(lines[i]) || /^#\s/.test(lines[i])) { end = i; break; }
  }
  return { start, end };
}

// Returns { text, added } where added is false for a duplicate or empty bullet.
function addBullet(markdown, section, bullet) {
  const clean = sanitizeBullet(bullet);
  if (!clean) return { text: markdown, added: false };
  const lines = String(markdown).split(/\r?\n/);
  const range = findSectionRange(lines, section);

  if (!range) {
    const base = lines.join('\n').replace(/\s+$/, '');
    return { text: `${base}\n\n## ${section}\n- ${clean}\n`, added: true };
  }
  for (let i = range.start + 1; i < range.end; i++) {
    const b = lines[i].match(BULLET);
    if (b && normalize(b[1]) === normalize(clean)) return { text: markdown, added: false };
  }
  // Insert after the last bullet in the section, or right after the heading.
  let at = range.start + 1;
  for (let i = range.start + 1; i < range.end; i++) if (BULLET.test(lines[i])) at = i + 1;
  lines.splice(at, 0, `- ${clean}`);
  return { text: lines.join('\n'), added: true };
}

// Removes the first bullet in `section` whose text matches. -> { text, removed }
function removeBullet(markdown, section, bullet) {
  const lines = String(markdown).split(/\r?\n/);
  const range = findSectionRange(lines, section);
  if (!range) return { text: markdown, removed: false };
  const target = normalize(bullet);
  for (let i = range.start + 1; i < range.end; i++) {
    const b = lines[i].match(BULLET);
    if (b && normalize(b[1]) === target) {
      lines.splice(i, 1);
      return { text: lines.join('\n'), removed: true };
    }
  }
  return { text: markdown, removed: false };
}

// ---- files ------------------------------------------------------------------

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return TEMPLATE;
    throw err;
  }
}

// Write to a temp file then rename, so a crash never leaves a half-written file.
function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text.endsWith('\n') ? text : text + '\n');
  fs.renameSync(tmp, file);
}

function listMemories(file) {
  return parse(readText(file));
}

function addMemory(file, section, bullet) {
  if (!SECTIONS.includes(section)) return { ok: false, error: 'unknown_section' };
  const res = addBullet(readText(file), section, bullet);
  if (!res.added) return { ok: false, error: sanitizeBullet(bullet) ? 'duplicate' : 'empty' };
  writeText(file, res.text);
  return { ok: true, text: sanitizeBullet(bullet) };
}

function forgetMemory(file, section, bullet) {
  const res = removeBullet(readText(file), section, bullet);
  if (!res.removed) return { ok: false, error: 'not_found' };
  writeText(file, res.text);
  return { ok: true };
}

module.exports = {
  SECTIONS, TEMPLATE, sanitizeBullet, normalize, parse, addBullet, removeBullet,
  listMemories, addMemory, forgetMemory, readText, writeText,
};
