'use strict';

// Pins two renderer-surface properties in code (no browser needed):
//  1. the web/mobile page carries a viewport meta, so phone browsers render
//     at device width and the stylesheet's 820px single-column breakpoint
//     can actually fire (caught missing 25 Nov 2026);
//  2. every refusal code the newly landed surfaces emit has a friendly
//     wording in renderer/errors.js, so none of them can fall through to
//     the generic "Something went wrong" line.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

test('the web/mobile page carries a viewport meta', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1"/, 'viewport meta present');
});

test('refusal codes from the newly landed surfaces have friendly wording', () => {
  global.window = {};
  require('../renderer/errors.js');
  const fe = global.window.friendlyError;
  const cases = {
    title_unavailable: /title could not be read/,
    not_background_mode: /background mode/,
    not_granted: /not been granted access/,
    not_enabled: /not enabled yet/,
    already_active: /already running/,
    nothing_to_cancel: /nothing in progress/,
  };
  for (const [code, re] of Object.entries(cases)) {
    assert.match(fe(code), re, `${code} maps to its own wording`);
  }
  // the generic fallback stays the fallback for genuinely unknown codes
  assert.match(fe('no_such_code_xyz'), /Something went wrong/);
  delete global.window;
});
