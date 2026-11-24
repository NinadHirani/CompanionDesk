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
  cloud_enabled: false, // explicit opt-in: the cloud fallback runs only when this is true AND a key is saved
  onboarding_done: false,
  ai_model_local: '', // Ollama chat model; '' = the built-in default
  ai_model_vision: '', // Ollama vision model for screen questions; '' = default
  hardware_profile: 'auto', // 'auto' detects this computer; a chosen profile steers only DEFAULT models
  // M5 proactive behavior (slice 1). Everything is opt-in and quiet by
  // default: delivery is OFF until the user turns it on, per scope, and
  // quiet hours (default 22:00-08:00 local) DEFER a due schedule to the
  // window's end instead of dropping it. No network is involved anywhere.
  proactive_enabled: false, // master opt-in for OS notifications
  proactive_scope_reminder: false, // per-scope control: reminders
  proactive_scope_deadline: false, // per-scope control: confirmed deadlines
  proactive_quiet_enabled: true, // quiet hours on by default (fail-safe)
  proactive_quiet_start: '22:00',
  proactive_quiet_end: '08:00',
  voice_enabled: false, // M6 slice 1: voice stays off until the user enables it
  voice_model: 'small.en', // M6 decision: small.en is the initial STT model
  screen_observation_enabled: false, // M7: master switch; stays off until the user enables it
  // M7 slice 2 (Ninad's decision): screen observation is a mode choice.
  // 'manual' (default) is option A, 'session' option B, 'background'
  // option C. Background additionally needs its own explicit consent and
  // is desktop-only; the policy layer (src/screen-mode.js) refuses it on
  // mobile platforms regardless of what is stored here.
  screen_mode: 'manual',
  screen_background_consent: false,
});

const ENUMS = Object.freeze({
  student_module: ['auto', 'off'],
  tone: ['direct', 'warm', 'formal'],
  brevity: ['short', 'normal', 'detailed'],
  hardware_profile: ['auto', 'lightweight', 'balanced', 'powerful'],
  screen_mode: ['manual', 'session', 'background'],
  // M6 (decided 24 Nov 2026): whisper.cpp small.en is the initial STT model;
  // the multilingual twins are selectable so Hindi can be added later.
  voice_model: ['small.en', 'base.en', 'tiny.en', 'small', 'base', 'tiny'],
});
const BOOLEANS = ['learn_from_activity', 'suggest_memories', 'cloud_personal', 'cloud_enabled', 'onboarding_done', 'proactive_enabled', 'proactive_scope_reminder', 'proactive_scope_deadline', 'proactive_quiet_enabled', 'voice_enabled', 'screen_observation_enabled', 'screen_background_consent'];
// 'HH:MM' 24h local clock times bounding the quiet window.
const QUIET_TIME_KEYS = ['proactive_quiet_start', 'proactive_quiet_end'];
const QUIET_TIME_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const TEXT_MAX = Object.freeze({ user_name: 40, assistant_name: 40, language: 30 });

// Ollama model ids, e.g. "llama3.2:latest" or "hf.co/org/model:Q4_K_M":
// letters, digits, dots, dashes and slashes, then one optional :tag.
// Whitespace and anything else are refused. '' means "use the default".
const MODEL_KEYS = Object.freeze(['ai_model_local', 'ai_model_vision']);
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}(:[A-Za-z0-9._-]{1,64})?$/;
function isValidModelId(value) {
  return typeof value === 'string' && MODEL_RE.test(value);
}

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
  for (const key of MODEL_KEYS) {
    if (typeof raw[key] === 'string' && isValidModelId(raw[key])) out[key] = raw[key];
  }
  for (const key of QUIET_TIME_KEYS) {
    if (typeof raw[key] === 'string' && QUIET_TIME_RE.test(raw[key])) out[key] = raw[key];
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
    } else if (MODEL_KEYS.includes(key)) {
      if (typeof value !== 'string') errors.push(`invalid_value:${key}`);
      else {
        const v = String(value).trim();
        if (v === '' || isValidModelId(v)) clean[key] = v;
        else errors.push(`invalid_value:${key}`);
      }
    } else if (QUIET_TIME_KEYS.includes(key)) {
      if (typeof value === 'string' && QUIET_TIME_RE.test(value)) clean[key] = value;
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

module.exports = { DEFAULTS, ENUMS, normalizeSettings, validatePatch, cleanLine, isValidModelId };
