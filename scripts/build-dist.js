'use strict';

// Builds distribution artifacts for one platform.
//
//   node scripts/build-dist.js --mac|--win|--linux
//
// Environment:
//   DISTRIBUTION_PUBLISH  'always' publishes to GitHub Releases, 'never'
//                         (default) builds artifacts only.
//   DISTRIBUTION_CHANNEL  'stable' (default) or 'continuous'.
//   STABLE_TAG            required for a stable publish, e.g. v0.2.0.
//
// Publishing decisions live in the CI workflow; this script only carries out
// the decision it is given and never invents one.

const { execFileSync } = require('child_process');
const { build, Platform, Arch } = require('electron-builder');

const PLATFORMS = {
  '--mac': Platform.MAC,
  '--win': Platform.WINDOWS,
  '--linux': Platform.LINUX,
};

function releaseNotesFromGit(opts) {
  // Notes are cut at a ref (a stable tag when one is set) so the same
  // tag always produces the same notes; with no ref they default to
  // HEAD (continuous builds).
  const ref = opts && typeof opts.ref === 'string' ? opts.ref : 'HEAD';
  let log;
  try {
    log = execFileSync('git', ['log', ref, '-15', '--pretty=format:- %h %s'],
                       { encoding: 'utf8' });
  } catch (err) {
    log = null;
  }
  const sha = (function shortSha() {
    try {
      return execFileSync('git', ['rev-parse', '--short', ref],
                          { encoding: 'utf8' }).trim();
    } catch (err) {
      return 'unknown';
    }
  })();
  const notes = [
    `Built from commit ${sha}.`,
    '',
    'Changes in this build:',
    log || '- (commit list unavailable)',
  ].join('\n');
  return notes;
}

function tagExists(tag) {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', tag + '^{commit}'],
                 { encoding: 'utf8' });
    return true;
  } catch (err) {
    return false;
  }
}

function publishConfig({ channel, publish, version }) {
  const base = { provider: 'github', owner: 'NinadHirani', repo: 'CompanionDesk' };
  if (publish !== 'always') return base;
  if (channel === 'continuous') {
    return { ...base, tag: 'continuous', releaseType: 'prerelease', releaseName: `Continuous build (${version})` };
  }
  const tag = process.env.STABLE_TAG;
  if (!tag || !/^v\d+\.\d+\.\d+$/.test(tag)) {
    throw new Error('STABLE_TAG must be set to vX.Y.Z for a stable publish');
  }
  if (tag !== 'v' + version) {
    throw new Error('STABLE_TAG ' + tag + ' does not match package.json version ' +
                    version + ': the release tag and the app version must agree');
  }
  // Draft: nothing becomes publicly visible until a person publishes it.
  return { ...base, tag, releaseType: 'release', draft: true, releaseName: `CompanionDesk ${tag}` };
}

async function main() {
  const platformKey = process.argv[2];
  const platform = PLATFORMS[platformKey];
  if (!platform) {
    console.error('usage: node scripts/build-dist.js --mac|--win|--linux');
    process.exit(1);
  }
  const publish = process.env.DISTRIBUTION_PUBLISH === 'always' ? 'always' : 'never';
  const channel = process.env.DISTRIBUTION_CHANNEL === 'continuous' ? 'continuous' : 'stable';
  const pkg = require('../package.json');
  // Anchor stable notes at STABLE_TAG when that tag exists in this
  // checkout, so a rebuilt tag ships the same notes instead of whatever
  // HEAD happens to hold at build time.
  let notesRef = null;
  const stableTag = process.env.STABLE_TAG;
  if (channel === 'stable' && stableTag &&
      /^v\d+\.\d+\.\d+$/.test(stableTag) && tagExists(stableTag)) {
    notesRef = stableTag;
  }
  const config = {
    ...pkg.build,
    publish: publishConfig({ channel, publish, version: pkg.version }),
    releaseInfo: { releaseNotes: releaseNotesFromGit(notesRef ? { ref: notesRef } : undefined) },
  };
  // electron-builder's programmatic API wants a Map of platform -> targets;
  // null means "use the targets configured in package.json for this platform".
  // electron-builder's programmatic API wants Map<Platform, Map<Arch, string[]>>;
  // architectures mirror the platform blocks in package.json.
  const archTargetsFor = {
    [Platform.MAC]: new Map([[Arch.arm64, ['dmg']], [Arch.x64, ['dmg']]]),
    [Platform.WINDOWS]: new Map([[Arch.x64, ['nsis']]]),
    [Platform.LINUX]: new Map([[Arch.x64, ['AppImage']]]),
  };
  await build({ targets: new Map([[platform, archTargetsFor[platform]]]), publish, config });
}

module.exports = { publishConfig, releaseNotesFromGit };

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  });
}
