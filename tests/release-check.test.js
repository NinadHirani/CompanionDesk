'use strict';

// The release metadata preflight: pure checks over injected metadata, a pin
// that the CURRENT repo state passes, and a pin that CI actually runs the
// check on every push. Nothing here builds, signs, publishes or deploys.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { checkReleaseMetadata } = require('../scripts/release-check');

const root = path.join(__dirname, '..');
const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');

test('the current repo state passes the release metadata check', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const r = checkReleaseMetadata({ pkgVersion: pkg.version, changelog });
  assert.deepEqual(r.problems, []);
});

test('a suffixed committed version fails; the suffix belongs to CI only', () => {
  const r = checkReleaseMetadata({ pkgVersion: '0.1.0-ci.42', changelog });
  assert.equal(r.ok, false);
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /not a plain x\.y\.z/);
});

test('with a tag argument the tag must be stable and match package.json', () => {
  assert.ok(checkReleaseMetadata({ pkgVersion: '0.2.0', changelog, stableTag: 'v0.2.0' }).ok);
  assert.equal(checkReleaseMetadata({ pkgVersion: '0.1.0', changelog, stableTag: 'v0.2.0' }).ok, false);
  assert.equal(checkReleaseMetadata({ pkgVersion: '0.1.0', changelog, stableTag: 'v0.1.0-android-preview.3' }).ok, false);
});

test('preview tags named in the changelog are valid; other tag-like text is not', () => {
  assert.ok(checkReleaseMetadata({
    pkgVersion: '0.1.0',
    changelog: '## [Unreleased]\n\n### 1 Dec 2026\n- tagged v0.1.0-android-preview.2\n',
  }).ok);
  const r = checkReleaseMetadata({
    pkgVersion: '0.1.0',
    changelog: '## [Unreleased]\n\n- shipped as v0.1.0-preview.1\n',
  });
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /follows no tag convention this repo uses/);
});

test('changelog tag headings and release-link lines are valid tags, not violations', () => {
  const text = [
    '## [Unreleased]',
    '',
    '## [v0.1.0-android-preview.2] - 2026-11-24',
    '',
    '[v0.1.0-android-preview.2]: https://github.com/NinadHirani/CompanionDesk/releases/tag/v0.1.0-android-preview.2',
    '',
  ].join('\n');
  assert.deepEqual(checkReleaseMetadata({ pkgVersion: '0.1.0', changelog: text }).problems, []);
});

test('the changelog must carry exactly one Unreleased heading', () => {
  for (const text of ['', '## [Unreleased]\nmore\n\n## [Unreleased]\n', '### only dated sections']) {
    const r = checkReleaseMetadata({ pkgVersion: '0.1.0', changelog: text });
    assert.equal(r.ok, false, JSON.stringify(text));
    assert.match(r.problems[0], /Unreleased/);
  }
});

test('the preflight runs on every push: it is part of the npm test suite CI runs', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.match(pkg.scripts.test, /node --test tests\/\*\.test\.js/);
  assert.ok(fs.existsSync(path.join(root, 'tests/release-check.test.js')));
});
