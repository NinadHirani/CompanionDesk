'use strict';

// The Privacy Policy and Terms ship inside the app and can be read from
// About me, so they are never only on a website. Reads from the app folder.

const fs = require('fs');
const path = require('path');

function readOne(root, name) {
  try {
    return fs.readFileSync(path.join(root, name), 'utf8');
  } catch {
    return null;
  }
}

// -> { ok, version, privacy, terms } ; privacy/terms are null if a file is missing
function readDocs(root) {
  let version = null;
  try { version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version; } catch { /* keep null */ }
  const privacy = readOne(root, 'PRIVACY_POLICY.md');
  const terms = readOne(root, 'TERMS.md');
  return { ok: privacy !== null && terms !== null, version, privacy, terms };
}

module.exports = { readDocs };
