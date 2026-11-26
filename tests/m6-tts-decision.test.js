'use strict';

// M6 TTS decision slice (26 Nov 2026): Ninad decided the TTS engine:
// OS-native speechSynthesis ONLY; piper1-gpl (and any third-party TTS
// engine or voice asset) stays deferred and unbundled. This guard pins
// the decision so it cannot drift: no piper dependency in package.json,
// no piper import anywhere outside the decision records, and the OS-native
// module stays the product's only speech-output path.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (['node_modules', 'dist', 'web', '.git', 'docs', 'experiments'].includes(e.name)) continue;
      walk(p, out);
    } else if (/\.(js|json|md)$/.test(e.name)) out.push(p);
  }
  return out;
}

test('no piper dependency or import anywhere outside the decision records', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  for (const block of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const deps = pkg[block] || {};
    for (const name of Object.keys(deps)) {
      assert.ok(!/piper/i.test(name), `no piper dependency in ${block}: ${name}`);
    }
  }
  const SELF = path.join(__dirname, 'm6-tts-decision.test.js');
  const hits = walk(ROOT).filter((p) => p !== SELF && /piper/i.test(fs.readFileSync(p, 'utf8')));
  assert.deepEqual(hits, [], `piper referenced outside the decision records: ${hits.join(', ')}`);
});

test('the OS-native speech-output module stays the only speech path', () => {
  const p = path.join(ROOT, 'renderer', 'speech-output.js');
  assert.ok(fs.existsSync(p));
  const src = fs.readFileSync(p, 'utf8');
  assert.ok(src.includes('speechSynthesis'), 'the engine is the OS voice via speechSynthesis');
  assert.equal(/require\(/.test(src), false, 'the pure module requires nothing');
});
