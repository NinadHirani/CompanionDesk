'use strict';

// M8 batch 55 (28 Nov 2026, standing authorization): release-prep hardening.
// The publish pipeline's decision logic (publishConfig, release notes, CI
// gates) is already contract-tested (update-policy.test.js, ci-release.test.js);
// what no test pins yet is the COHERENCE of the static release config:
// package.json's version and build targets, the icon assets the config
// references, scripts/build-dist.js's target table matching that config,
// and docs/DISTRIBUTION.md only naming commands and flags that exist.
// Nothing here builds, publishes or releases anything; every check is a
// repo-file read. A tagged release candidate, signing and public
// distribution stay owner-gated.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const repo = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
const distScript = fs.readFileSync(path.join(repo, 'scripts', 'build-dist.js'), 'utf8');
const distDoc = fs.readFileSync(path.join(repo, 'docs', 'DISTRIBUTION.md'), 'utf8');

test('package.json version is plain semver the publish tag format can carry', () => {
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/, 'version must be vX.Y.Z-able');
});

test('every icon path the build config references exists on disk', () => {
  const paths = [];
  const walk = (v) => {
    if (typeof v === 'string' && /^build\//.test(v)) paths.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(pkg.build);
  assert.ok(paths.length >= 3, 'build config references its icon assets: ' + paths.join(', '));
  for (const p of paths) {
    assert.equal(fs.existsSync(path.join(repo, p)), true, p + ' exists');
  }
});

test('the build targets and build-dist.js target table agree per platform', () => {
  const mac = pkg.build.mac.target.map(t => t.target).sort();
  const win = pkg.build.win.target.map(t => t.target).sort();
  const linux = pkg.build.linux.target.map(t => t.target).sort();
  assert.deepEqual(mac, ['dmg']);
  assert.deepEqual(pkg.build.mac.target.map(t => t.arch).flat().sort(), ['arm64', 'x64']);
  assert.deepEqual(win, ['nsis']);
  assert.deepEqual(linux, ['AppImage']);
  assert.match(distScript, /\[Arch\.arm64, \['dmg'\]\], \[Arch\.x64, \['dmg'\]\]/, 'mac target table matches');
  assert.match(distScript, /\[Arch\.x64, \['nsis'\]\]/, 'win target table matches');
  assert.match(distScript, /\[Arch\.x64, \['AppImage'\]\]/, 'linux target table matches');
});

test('linux artifact keeps the CompanionDesk-version artifact name', () => {
  assert.equal(pkg.build.linux.artifactName, 'CompanionDesk-${version}.${ext}');
});

test('docs/DISTRIBUTION.md only names commands that exist in the repo', () => {
  const npmRuns = [...distDoc.matchAll(/npm run ([a-z:_-]+)/g)].map(m => m[1]);
  assert.ok(npmRuns.length >= 1, 'the doc names npm scripts');
  for (const s of npmRuns) {
    assert.ok(pkg.scripts[s] !== undefined, 'npm run ' + s + ' exists in package.json');
  }
  const nodeScripts = [...distDoc.matchAll(/node (scripts\/[a-z0-9._-]+\.js)/g)].map(m => m[1]);
  for (const s of nodeScripts) {
    assert.equal(fs.existsSync(path.join(repo, s)), true, s + ' exists');
  }
  assert.ok(nodeScripts.length >= 1, 'the doc names the build-dist entry point');
});

test('the doc never names a publish mode build-dist.js would not accept', () => {
  // build-dist.js accepts DISTRIBUTION_PUBLISH always|never (anything else is never)
  const docModes = [...distDoc.matchAll(/DISTRIBUTION_PUBLISH=([a-z_]+)/g)].map(m => m[1]);
  for (const m of docModes) {
    assert.ok(m === 'always' || m === 'never', 'doc publish mode ' + m + ' is one build-dist accepts');
  }
  // and the doc's safety promise holds in code: publish defaults to never
  assert.match(distScript, /DISTRIBUTION_PUBLISH === 'always' \? 'always' : 'never'/, 'publish defaults to never');
});

test('a bogus platform flag exits 1 with usage and builds nothing', { timeout: 20000 }, async () => {
  const { execFile } = require('node:child_process');
  const node = process.execPath;
  const res = await new Promise((resolve) => {
    execFile(node, ['scripts/build-dist.js', '--bogus'], { cwd: repo }, (err, stdout, stderr) => {
      resolve({ err, stdout, stderr });
    });
  });
  assert.ok(res.err, 'the bogus flag fails');
  assert.match(res.stderr, /usage: node scripts\/build-dist\.js --mac\|--win\|--linux/, 'usage line names the real flags');
  assert.equal(res.stdout, '', 'nothing is built or published');
});
