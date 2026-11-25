'use strict';
// The web bundle ships its own page shell (web/index.html) with the same view
// scripts the desktop window loads. When that shell drifts behind the
// renderer sources, ids the scripts bind on load go missing and the page
// throws before anything renders. This guard fails whenever a web-shipped
// script references an id present in the renderer shell but absent from the
// web shell. (An id in NEITHER shell is assumed to be created dynamically at
// runtime; that is the escape hatch the guard allows.)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const WEB_SCRIPTS = ['format', 'errors', 'dom', 'app', 'ask', 'about', 'grades', 'onboarding', 'boot'];
const idsIn = (file) => new Set((fs.readFileSync(path.join(root, file), 'utf8').match(/id="([^"]+)"/g) || []).map((s) => s.slice(4, -1)));

test('the web shell carries every id its shipped scripts reference', () => {
  const web = idsIn('web/index.html');
  const renderer = idsIn('renderer/index.html');
  const missing = [];
  for (const f of WEB_SCRIPTS) {
    const src = fs.readFileSync(path.join(root, 'renderer', `${f}.js`), 'utf8');
    for (const id of src.matchAll(/getElementById\('([^']+)'\)/g)) {
      if (!web.has(id[1]) && renderer.has(id[1])) missing.push(`${id[1]} (${f}.js)`);
    }
  }
  assert.deepEqual(missing, []);
});
