'use strict';

// Reduced-motion accessibility: the stylesheet animates at least the
// onboarding setup progress bar. A user whose OS asks for reduced motion
// must get every animated property non-animated, and the guard is
// generic: any selector that declares a transition or animation outside
// the prefers-reduced-motion block must be disabled inside it, so a
// future animation cannot ship uncovered.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'styles.css'), 'utf8');

function extractBlock(src, opener) {
  const at = src.indexOf(opener);
  if (at === -1) return null;
  const open = src.indexOf('{', at);
  let depth = 1;
  let i = open + 1;
  while (i < src.length && depth > 0) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') depth -= 1;
    i += 1;
  }
  return src.slice(open + 1, i - 1);
}

const MOTION_DECL = /(^|;|\{)\s*(transition|animation)\s*[:-]/;

test('the stylesheet ships a prefers-reduced-motion block', () => {
  const block = extractBlock(css, '@media (prefers-reduced-motion: reduce)');
  assert.ok(block !== null, 'no prefers-reduced-motion block found');
});

test('every animated selector is disabled under reduced motion', () => {
  const block = extractBlock(css, '@media (prefers-reduced-motion: reduce)');
  assert.ok(block !== null, 'no prefers-reduced-motion block found');
  // The remainder is everything outside the reduced-motion block.
  const at = css.indexOf('@media (prefers-reduced-motion: reduce)');
  const outside = at === -1 ? css : css.slice(0, at) + css.slice(css.indexOf('}', css.lastIndexOf('}', css.indexOf('@media (prefers-reduced-motion: reduce)') )) + 1);
  const animated = new Set();
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = rule.exec(outside)) !== null) {
    if (MOTION_DECL.test(m[2])) {
      for (const sel of m[1].split(',')) animated.add(sel.trim());
    }
  }
  assert.ok(animated.size > 0, 'the stylesheet animates nothing; this guard is vacuous');
  for (const sel of animated) {
    const hit = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{[^{}]*(transition|animation)[^{}]*(none|duration:\\s*0)').test(block);
    assert.ok(hit, `animated selector "${sel}" is not disabled inside prefers-reduced-motion`);
  }
});
