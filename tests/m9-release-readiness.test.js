'use strict';

// M9 release-readiness prep (28 Nov 2026, standing authorization,
// checklist-only lane). Pins the parts of the release posture that the
// existing suites do not yet cover: the packaged-app smoke checklist
// exists as the owner's physical-run document, and the release brief
// keeps the spend/signing/distribution decisions owner-gated. Nothing
// here builds a distribution artifact, signs anything, publishes
// anything or claims a device test ran.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('the packaged-app smoke checklist exists and covers the real surfaces', () => {
  const doc = fs.readFileSync(path.join(root, 'docs', 'M9_SMOKE_CHECKLIST.md'), 'utf8');
  for (const section of ['models dir', 'secure storage', 'notification', 'settings', 'first-run privacy defaults']) {
    assert.ok(doc.toLowerCase().includes(section.toLowerCase()), `smoke checklist missing: ${section}`);
  }
  // every item is phrased as something the owner runs, never a claim
  assert.ok(!/\b(verified|tested) (on|this) (device|macbook|oneplus)/i.test(doc), 'no device-tested claim may appear');
  assert.ok(/owner|Ninad|you run|run each/i.test(doc), 'the checklist names who runs it');
});

test('the release brief keeps spend, signing and distribution owner-gated', () => {
  const doc = fs.readFileSync(path.join(root, 'docs', 'M9_RELEASE_BRIEF.md'), 'utf8');
  assert.match(doc, /Ninad's explicit approval|owner-gated|Ninad decides/);
  assert.match(doc, /no signing, no distribution/i);
});

test('the release-notes rule stays honest: no performance claim without measured numbers', () => {
  const raw = fs.readFileSync(path.join(root, 'docs', 'M9_RELEASE_BRIEF.md'), 'utf8');
  const doc = raw.replace(/\s+/g, ' ');  // the brief is hard-wrapped; match across line breaks
  assert.match(doc, /No performance claim appears in any release note without measured numbers/);
  assert.match(doc, /No performance claim may appear in a release note without measured numbers from the Gate 1 device pass/);
});
