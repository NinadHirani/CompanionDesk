'use strict';
// Red-first (28 Nov 2026, Ninad's concurrency batch-60): the credential file
// write must be atomic. A crash or disk error mid-write must never leave a
// torn partial .bin behind: such a file makes hasCredential report true while
// readCredential returns null, which is a half-authenticated connector.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { createConnectorCredentialStore } = require('../src/connector-credential-store.js');

function makeStore(fsOverride) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-cred-'));
  const enc = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from('enc:' + s), decryptString: (b) => Buffer.from(b).toString('utf8').replace(/^enc:/, ''), getSelectedStorageBackend: () => 'gnome_libsecret' };
  return { store: createConnectorCredentialStore({ safeStorage: enc, fs: fsOverride, dir, platform: 'linux' }), dir };
}

test('a write failure mid-write leaves no torn credential file', () => {
  const real = { ...fs };
  let threw = false;
  const fake = Object.assign({}, real, {
    writeFileSync(file, data, opts) {
      // Simulate a crash after the file exists with partial content.
      real.writeFileSync(file, Buffer.from('partial'), opts);
      threw = true;
      throw Object.assign(new Error('ENOSPC mid-write'), { code: 'ENOSPC' });
    },
  });
  const { store, dir } = makeStore(fake);
  const res = store.setCredential('companiondesk-rss', 'sk-test-secret');
  assert.equal(res.ok, false, 'the write must refuse');
  assert.equal(threw, true, 'precondition: the write actually failed mid-write');
  const listing = fs.readdirSync(dir).filter((f) => f.endsWith('.bin'));
  assert.equal(listing.length, 0, 'no torn partial file may remain on disk');
  assert.equal(store.hasCredential('companiondesk-rss'), false, 'a failed write must not be reported as held');
});
