'use strict';

// Validation for the overlay's global shortcut. A global shortcut steals those
// keys from every other app, so the rules are strict: at least one real
// modifier (Shift alone does not count, it would hijack typing), exactly one
// key, and no common editing shortcuts. Pure: no Electron needed.

const DEFAULT_HOTKEY = 'CommandOrControl+Shift+Space';

const MODIFIERS = {
  commandorcontrol: 'CommandOrControl', cmdorctrl: 'CommandOrControl',
  command: 'Command', cmd: 'Command',
  control: 'Control', ctrl: 'Control',
  alt: 'Alt', option: 'Alt', altgr: 'AltGr',
  shift: 'Shift',
  super: 'Super', meta: 'Super',
};
const MOD_ORDER = ['CommandOrControl', 'Command', 'Control', 'Alt', 'AltGr', 'Shift', 'Super'];

const NAMED_KEYS = { space: 'Space', tab: 'Tab', up: 'Up', down: 'Down', left: 'Left', right: 'Right', enter: 'Return', return: 'Return' };
const PUNCTUATION = new Set(['-', '=', '[', ']', ';', "'", ',', '.', '/', '`']);

// Plain Cmd/Ctrl + one of these is an editing or window shortcut in most apps.
const RESERVED_WITH_CMD = new Set(['C', 'V', 'X', 'A', 'Z', 'Y', 'S', 'Q', 'W']);

function normalizeKey(raw) {
  const k = String(raw).trim();
  if (/^[a-z0-9]$/i.test(k)) return k.toUpperCase();
  if (/^f([1-9]|1\d|2[0-4])$/i.test(k)) return k.toUpperCase();
  if (NAMED_KEYS[k.toLowerCase()]) return NAMED_KEYS[k.toLowerCase()];
  if (PUNCTUATION.has(k)) return k;
  return null;
}

// -> { ok: true, value } | { ok: false, error }
function normalize(input) {
  if (typeof input !== 'string' || !input.trim() || input.length > 60) return { ok: false, error: 'invalid_hotkey' };
  const parts = input.split('+').map((p) => p.trim());
  if (parts.length < 2 || parts.length > 5 || parts.some((p) => p === '')) return { ok: false, error: 'invalid_hotkey' };

  const key = normalizeKey(parts[parts.length - 1]);
  if (!key) return { ok: false, error: 'invalid_hotkey' };

  const mods = new Set();
  for (const p of parts.slice(0, -1)) {
    const m = MODIFIERS[p.toLowerCase()];
    if (!m || mods.has(m)) return { ok: false, error: 'invalid_hotkey' };
    mods.add(m);
  }
  if ([...mods].every((m) => m === 'Shift')) return { ok: false, error: 'needs_modifier' };
  // All three cmd-like single modifiers, not only the CommandOrControl
  // alias: Control+C is copy on Windows/Linux and Command+C on macOS, so
  // any of them alone over an editing key hijacks it system-wide.
  const cmdLike = mods.size === 1 && (mods.has('CommandOrControl') || mods.has('Command') || mods.has('Control'));
  if (cmdLike && RESERVED_WITH_CMD.has(key)) return { ok: false, error: 'reserved_hotkey' };
  if (mods.size === 1 && mods.has('Alt') && key === 'F4') return { ok: false, error: 'reserved_hotkey' };

  const ordered = MOD_ORDER.filter((m) => mods.has(m));
  return { ok: true, value: [...ordered, key].join('+') };
}

module.exports = { DEFAULT_HOTKEY, normalize };
