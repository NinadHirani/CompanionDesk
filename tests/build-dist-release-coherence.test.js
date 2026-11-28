'use strict';

// M8 batch 57 (28 Nov 2026, standing authorization): release coherence.
// Two real defects in scripts/build-dist.js, both caught red-first:
//   1. A stable publish validated STABLE_TAG's shape but never checked it
//      matches package.json's version. A draft release tagged v9.9.9
//      built from a 0.1.0 app would self-report 0.1.0 everywhere and
//      silently break the updater's version math against the tag.
//   2. Stable release notes were cut from HEAD (git log -15), so the same
//      tag rebuilt after more commits ships different notes: the note
//      content depended on build time, not the release.
// Test-only until each fails; then the fixes land. No builds run, no
// network, no credentials.

const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const { publishConfig, releaseNotesFromGit } = require('../scripts/build-dist.js');

const pkg = require('../package.json');

function withStableTag(tag, fn) {
  const prev = process.env.STABLE_TAG;
  process.env.STABLE_TAG = tag;
  try { fn(); } finally {
    if (prev === undefined) delete process.env.STABLE_TAG; else process.env.STABLE_TAG = prev;
  }
}

test('a stable publish refuses a STABLE_TAG that does not match package.json version', () => {
  withStableTag('v9.9.9', () => {
    assert.throws(
      () => publishConfig({ channel: 'stable', publish: 'always', version: pkg.version }),
      (err) => /STABLE_TAG .* does not match|version/.test(err.message),
      'mismatched tag/version must be refused, not drafted'
    );
  });
});

test('a stable publish accepts the exact matching tag and drafts it', () => {
  withStableTag('v' + pkg.version, () => {
    const cfg = publishConfig({ channel: 'stable', publish: 'always', version: pkg.version });
    assert.equal(cfg.tag, 'v' + pkg.version);
    assert.equal(cfg.draft, true, 'still a person-published draft');
    assert.equal(cfg.releaseType, 'release');
  });
});

test('stable tag mismatch does not disturb the never-publish path', () => {
  withStableTag('v9.9.9', () => {
    const cfg = publishConfig({ channel: 'stable', publish: 'never', version: pkg.version });
    assert.equal(cfg.tag, undefined, 'a local build stays tagless');
  });
});

test('release notes can be anchored at a ref instead of drifting with HEAD', () => {
  // Anchor 30 commits back: the note's first listed commit must be that
  // commit, whatever new commits land later. HEAD-anchored notes cannot
  // pass this test once history moves.
  const older = execFileSync('git', ['rev-parse', '--short', 'HEAD~30'], { encoding: 'utf8' }).trim();
  const notes = releaseNotesFromGit({ ref: 'HEAD~30' });
  assert.ok(notes.includes(older), 'the anchored list names the anchored commit (' + older + ')');
  const headShort = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.ok(notes.includes('Built from commit ' + older), 'the built-from line names the anchored ref, not a later HEAD');
  void headShort;
});
