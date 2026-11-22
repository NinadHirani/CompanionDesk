'use strict';

// Personal settings: how the assistant talks and what it may learn from.
// Stored as plain strings in the settings table; this module turns them into
// typed values with safe defaults and validates anything the user changes.
// Pure: no fs, no database, no network.

const DEFAULTS = Object.freeze({
  user_name: '',
  assistant_name: 'CompanionDesk',
  student_module: 'auto', // 'auto' = student tools appear once a syllabus is imported; 'off' = never
  tone: 'direct',
  brevity: 'normal',
  language: 'English',
  learn_from_activity: true, // log finished items locally to spot patterns
  suggest_memories: true, // offer "remember this?" cards after a question
  cloud_personal: false, // send personal context to the cloud fallback (off)
  onboarding_done: false,
});

const ENUMS = Object.freeze({
  student_module: ['auto', 'off'],
  tone: ['direct', 'warm', 'formal'],
  brevity: ['short', 'normal', 'detailed'],
});
const BOOLEANS = ['learn_from_activity', 'suggest_memories', 'cloud_personal', 'onboarding_done'];
const TEXT_MAX = Object.freeze({ user_name: 40, assistant_name: 40, language: 30 });

// One line, no control characters, collapsed spaces, capped. Returns '' when
// nothing usable is left.
function cleanLine(value, max) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

// raw: { key: string } straight from the database. Unknown or invalid stored
// values fall back to the default instead of throwing.
function normalizeSettings(raw = {}) {
  const out = { ...DEFAULTS };
  for (const key of Object.keys(ENUMS)) {
    if (ENUMS[key].includes(raw[key])) out[key] = raw[key];
  }
  for (const key of BOOLEANS) {
    if (raw[key] === 'true') out[key] = true;
    else if (raw[key] === 'false') out[key] = false;
  }
  for (const [key, max] of Object.entries(TEXT_MAX)) {
    if (raw[key] === undefined) continue;
    const v = cleanLine(raw[key], max);
    if (v || key === 'user_name') out[key] = v; // a blank name is allowed, a blank assistant name is not
  }
  return out;
}

// patch: { key: value } from the renderer. Returns { ok, clean, errors } where
// clean is { key: string } ready to store. Nothing is stored unless ok.
function validatePatch(patch) {
  const errors = [];
  const clean = {};
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, clean, errors: ['bad_request'] };
  }
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) { errors.push(`unknown_setting:${key}`); continue; }
    if (ENUMS[key]) {
      if (ENUMS[key].includes(value)) clean[key] = value;
      else errors.push(`invalid_value:${key}`);
    } else if (BOOLEANS.includes(key)) {
      if (typeof value === 'boolean') clean[key] = String(value);
      else errors.push(`invalid_value:${key}`);
    } else {
      const v = cleanLine(value, TEXT_MAX[key]);
      if (typeof value !== 'string') errors.push(`invalid_value:${key}`);
      else if (!v && key !== 'user_name') errors.push(`invalid_value:${key}`);
      else clean[key] = v;
    }
  }
  return { ok: errors.length === 0, clean, errors };
}

module.exports = { DEFAULTS, ENUMS, normalizeSettings, validatePatch, cleanLine };
