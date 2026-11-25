'use strict';

// Release metadata preflight. Validates that the release-facing metadata on
// main is self-consistent: the committed package.json version is a plain
// x.y.z (the -ci.N suffix exists only inside continuous-release CI), every
// tag named in CHANGELOG.md follows the repo's tag conventions, and the
// changelog has its Unreleased section. Nothing here builds, signs,
// publishes or distributes anything; it reads three files and reports.
//
// With --tag <tag> it also checks that tag against package.json the way
// release-stable.yml does, so the same rule can be run before tagging.

const fs = require('fs');
const path = require('path');

const STABLE_TAG = /^v\d+\.\d+\.\d+$/;
const PREVIEW_TAG = /^v\d+\.\d+\.\d+-android-preview\.\d+$/;
const PLAIN_VERSION = /^\d+\.\d+\.\d+$/;

// Stable or android-preview tags, as whole words, wherever the changelog
// mentions one. Shorthand like ", .2" for a second preview tag is not a
// tag and must not be claimed as one. A base version followed by any other
// suffix (v0.1.0-preview.1, v0.1.0-ci.42) is caught separately: it must
// never be silently read as the bare stable tag.
const TAG_TOKEN = /\bv\d+\.\d+\.\d+(?:-android-preview\.\d+)?(?![\w.-])/g;
// A base version followed by a suffix that is not the android-preview
// convention, where the suffix ends at any non word/dot/dash character
// (end, space, comma, bracket, paren). A bare boundary after the preview
// digits clears the tag; anything still continuing (`.2.5`, `.2extra`)
// fails it.
const BAD_TAG_TOKEN = /\bv\d+\.\d+\.\d+-(?!android-preview\.\d+(?![\w.-]))[A-Za-z][\w.-]*/g;

function checkReleaseMetadata({ pkgVersion, changelog, stableTag }) {
  const problems = [];
  if (!PLAIN_VERSION.test(String(pkgVersion))) {
    problems.push(
      `package.json version "${pkgVersion}" is not a plain x.y.z; a suffix ` +
        '(like -ci.N) is set only inside the continuous-release workflow, never on main',
    );
  }
  if (stableTag !== undefined) {
    if (!STABLE_TAG.test(String(stableTag))) {
      problems.push(`tag "${stableTag}" is not a stable v<x.y.z> tag`);
    } else if (stableTag.slice(1) !== String(pkgVersion)) {
      problems.push(`tag "${stableTag}" does not match package.json version "${pkgVersion}"`);
    }
  }
  if (typeof changelog === 'string') {
    const unreleased = changelog.match(/^## \[Unreleased\]$/gm) || [];
    if (unreleased.length !== 1) {
      problems.push(
        `CHANGELOG.md must contain exactly one "## [Unreleased]" heading, found ${unreleased.length}`,
      );
    }
    for (const tag of changelog.match(TAG_TOKEN) || []) {
      if (!STABLE_TAG.test(tag) && !PREVIEW_TAG.test(tag)) {
        problems.push(`CHANGELOG.md names "${tag}", which is neither a stable v<x.y.z> tag nor a v<x.y.z>-android-preview.<n> tag`);
      }
    }
    for (const tag of changelog.match(BAD_TAG_TOKEN) || []) {
      problems.push(`CHANGELOG.md names "${tag}", which follows no tag convention this repo uses`);
    }
  }
  return { ok: problems.length === 0, problems };
}

function run({ pkgFile, changelogFile, stableTag, out }) {
  const pkg = JSON.parse(fs.readFileSync(pkgFile || path.join(__dirname, '..', 'package.json'), 'utf8'));
  const changelog = fs.readFileSync(changelogFile || path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8');
  const result = checkReleaseMetadata({ pkgVersion: pkg.version, changelog, stableTag });
  if (result.ok) {
    (out || console).log(stableTag ? `release metadata ok for tag ${stableTag}` : 'release metadata ok');
    return 0;
  }
  (out || console).error(`release metadata check failed (${result.problems.length} problem${result.problems.length === 1 ? '' : 's'}):`);
  for (const p of result.problems) (out || console).error(`  - ${p}`);
  return 1;
}

module.exports = { checkReleaseMetadata, TAG_TOKEN };

if (require.main === module) {
  const tagArg = process.argv.indexOf('--tag');
  const stableTag = tagArg !== -1 ? process.argv[tagArg + 1] : undefined;
  process.exit(run({ stableTag }));
}
