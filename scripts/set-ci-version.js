'use strict';

// Rewrites package.json's version to <base>-<prereleaseId> for continuous
// distribution builds. The prerelease id must be strictly increasing so
// electron-updater always sees the newest build as newer; CI passes its
// run number. The base version itself is never touched.

const fs = require('fs');
const path = require('path');

const PRERELEASE_ID = /^(0|[1-9]\d*)$/; // a bare run number, e.g. 42

function setContinuousVersion({ baseVersion, id, file }) {
  if (!/^\d+\.\d+\.\d+$/.test(baseVersion)) {
    throw new Error(`base version "${baseVersion}" is not x.y.z`);
  }
  if (!PRERELEASE_ID.test(String(id))) {
    throw new Error(`build id "${id}" must be a plain number`);
  }
  const next = `${baseVersion}-ci.${String(id)}`;
  const pkgPath = file || path.join(__dirname, '..', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.version = next;
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  return next;
}

module.exports = { setContinuousVersion };

if (require.main === module) {
  const base = require('../package.json').version.replace(/-.*$/, '');
  const id = process.argv[2];
  if (!id) {
    console.error('usage: node scripts/set-ci-version.js <run-number>');
    process.exit(1);
  }
  console.log(setContinuousVersion({ baseVersion: base, id }));
}
