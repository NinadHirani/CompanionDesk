'use strict';

// M9 definition pins (28 Nov 2026): Ninad defined M9 in chat as the
// coordinated-release phase docs/M9_RELEASE_BRIEF.md proposed. These pins
// keep the definition honest: the roadmap carries the owner-defined section
// and status row, the decision sheet records the resolution, the changelog
// stays current, and the section states what stays out of scope (signing
// spend, public distribution, auto-update before a signing decision) and
// that no release exists yet.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('the roadmap defines M9 as an owner-defined phase', () => {
  const roadmap = read('docs/IMPLEMENTATION_ROADMAP.md');
  assert.match(roadmap, /## M9 - Release readiness \(owner-defined 28 Nov 2026\)/);
  assert.match(roadmap, /\| M9 release readiness \| DEFINED/);
  assert.ok(roadmap.includes('docs/M9_RELEASE_BRIEF.md'), 'the definition must cite the brief it adopts');
});

test('the decision sheet records the M9 resolution', () => {
  const sheet = read('docs/NEXT_DECISIONS.md');
  assert.match(sheet, /## 6\. M9 release readiness -- RESOLVED/);
  assert.ok(sheet.includes('28 Nov 2026'));
});

test('the M9 section keeps the owner-gated items out of scope', () => {
  const roadmap = read('docs/IMPLEMENTATION_ROADMAP.md');
  const start = roadmap.indexOf('## M9 - Release readiness');
  assert.ok(start !== -1, 'the M9 section must exist');
  const end = roadmap.indexOf('## Test strategy', start);
  const section = roadmap.slice(start, end === -1 ? roadmap.length : end);
  for (const phrase of ['signing', 'public distribution', 'no release exists']) {
    assert.ok(section.includes(phrase), `M9 section must state: ${phrase}`);
  }
});

test('the changelog is current and the package carries a version', () => {
  const changelog = read('CHANGELOG.md');
  assert.ok(changelog.includes('## [Unreleased]'), 'CHANGELOG needs an Unreleased section');
  const pkg = JSON.parse(read('package.json'));
  assert.ok(/^\d+\.\d+\.\d+/.test(String(pkg.version || '')), 'package.json needs a semver version');
});
