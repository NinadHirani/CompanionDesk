'use strict';

// The release workflows cannot run here, so these tests pin the properties
// that matter: what triggers them, what they may write, that publishing is
// gated, that no secret is hardcoded, and that the app's updater wiring is
// complete. Files are read as text; no YAML library is needed.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const continuous = fs.readFileSync(path.join(root, '.github/workflows/release-continuous.yml'), 'utf8');
const stable = fs.readFileSync(path.join(root, '.github/workflows/release-stable.yml'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('the continuous workflow runs on the distribution branch and manual dispatch', () => {
  assert.match(continuous, /branches:\s*\[\s*distribution\s*\]/);
  assert.match(continuous, /workflow_dispatch/);
});

test('the stable workflow runs only on version tags', () => {
  assert.match(stable, /tags:\s*\n\s*-\s*'v\*'/);
  assert.ok(!/branches:/.test(stable), 'stable releases must not build on branch pushes');
});

test('both workflows may write contents (releases) and nothing wider', () => {
  for (const yml of [continuous, stable]) {
    assert.match(yml, /permissions:\s*\n\s*contents:\s*write/);
    assert.ok(!/contents:\s*(?!write\b)/.test(yml.replace(/contents: write/g, '')), 'unexpected contents permission');
  }
});

test('publishing is gated on an explicit repository variable, never on by default', () => {
  assert.match(continuous, /ENABLE_CONTINUOUS_RELEASES/);
  assert.match(continuous, /DISTRIBUTION_PUBLISH: \$\{\{ \(vars\.ENABLE_CONTINUOUS_RELEASES == 'true' && inputs\.dry_run != true\) && 'always' \|\| 'never' \}\}/);
  assert.match(continuous, /DISTRIBUTION_CHANNEL: continuous/);
});

test('a stable publish drafts the release instead of making it public', () => {
  assert.match(stable, /DISTRIBUTION_PUBLISH: always/);
  assert.match(stable, /STABLE_TAG: \$\{\{ github\.ref_name \}\}/);
  // The draft flag itself lives where the publish decision is carried out.
  const buildDist = fs.readFileSync(path.join(root, 'scripts/build-dist.js'), 'utf8');
  assert.match(buildDist, /draft: true/);
});

test('both workflows build all three platforms on their native runners', () => {
  for (const yml of [continuous, stable]) {
    for (const os of ['macos-latest', 'ubuntu-24.04', 'windows-latest']) {
      assert.ok(yml.includes(os), `matrix must include ${os}`);
    }
    assert.match(yml, /--mac/);
    assert.match(yml, /--win/);
    assert.match(yml, /--linux/);
  }
});

test('no secrets are hardcoded; only named GitHub secrets are referenced', () => {
  const secretRefs = new Set();
  for (const yml of [continuous, stable]) {
    for (const m of yml.matchAll(/\$\{\{\s*secrets\.([A-Z_]+)\s*\}\}/g)) secretRefs.add(m[1]);
    // A token value would look like ghs_ or ghp_ followed by base64.
    assert.ok(!/gh[pousr]_[A-Za-z0-9]{20,}/.test(yml), 'a literal token leaked into the workflow');
  }
  for (const name of secretRefs) {
    assert.match(name, /^(GITHUB_TOKEN|CSC_LINK|CSC_KEY_PASSWORD|APPLE_ID|APPLE_APP_SPECIFIC_PASSWORD|APPLE_TEAM_ID)$/);
  }
  assert.ok(secretRefs.has('GITHUB_TOKEN'));
});

test('macOS signing secrets are wired through as optional environment', () => {
  for (const yml of [continuous, stable]) {
    assert.match(yml, /CSC_LINK: \$\{\{ secrets\.CSC_LINK \}\}/);
    assert.match(yml, /APPLE_APP_SPECIFIC_PASSWORD: \$\{\{ secrets\.APPLE_APP_SPECIFIC_PASSWORD \}\}/);
  }
});

test('the three jobs are serialized so they cannot race on one release', () => {
  assert.match(continuous, /concurrency:\s*\n\s*group: continuous-release\s*\n\s*cancel-in-progress: false/);
  assert.match(stable, /concurrency:\s*\n\s*group: stable-release\s*\n\s*cancel-in-progress: false/);
});

test('the package can actually publish: electron-updater dependency and github config', () => {
  assert.ok(pkg.dependencies['electron-updater'], 'electron-updater must be a runtime dependency');
  const pub = Array.isArray(pkg.build.publish) ? pkg.build.publish[0] : pkg.build.publish;
  assert.equal(pub.provider, 'github');
  assert.equal(pub.owner, 'NinadHirani');
  assert.equal(pub.repo, 'CompanionDesk');
  assert.equal(pkg.build.mac.identity, null, 'unsigned until a Developer ID cert is configured');
  for (const t of ['nsis', 'AppImage', 'dmg']) {
    assert.ok(JSON.stringify(pkg.build).includes(t), `${t} target missing`);
  }
});

test('the dist scripts exist and the update channels are wired end to end', () => {
  for (const f of ['scripts/build-dist.js', 'scripts/set-ci-version.js', 'src/updater.js', 'src/update-policy.js', 'renderer/update.js']) {
    assert.ok(fs.existsSync(path.join(root, f)), `${f} missing`);
  }
  const channels = fs.readFileSync(path.join(root, 'src/ipc-channels.js'), 'utf8');
  const preload = fs.readFileSync(path.join(root, 'src/preload.js'), 'utf8');
  for (const ch of ['update:status', 'update:check', 'update:download', 'update:install']) {
    assert.ok(channels.includes(`'${ch}'`), `ipc-channels missing ${ch}`);
    assert.ok(preload.includes(`'${ch}'`), `preload missing ${ch}`);
  }
  assert.ok(channels.includes("'update:state'"), 'main must be able to push update state');
  assert.ok(preload.includes("'update:state'"), 'preload must listen for update state');
});

test('the docs tell the macOS signing truth', () => {
  const docs = fs.readFileSync(path.join(root, 'docs/DISTRIBUTION.md'), 'utf8');
  assert.match(docs, /Developer ID/);
  assert.match(docs, /not code-signed|unsigned/i);
  assert.match(docs, /ENABLE_CONTINUOUS_RELEASES/);
  assert.match(docs, /DRAFT release|DRAFT/i);
});
