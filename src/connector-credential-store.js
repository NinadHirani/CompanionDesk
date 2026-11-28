'use strict';

// Encrypted-at-rest storage for connector credentials (Gate 2 follow-on,
// 27 Nov 2026). The store is service-agnostic: it holds ONE opaque secret
// per connector id (an API key, a token, whatever a later service layer
// needs to authenticate). It knows nothing about what the credential is
// for beyond the id and it performs no network calls and connects nothing.
//
// Same fail-closed pattern as src/secure-store.js (the Gemini key
// wrapper): Electron's safeStorage encrypts with the OS credential vault
// (Keychain on macOS, DPAPI on Windows, libsecret/KWallet on Linux); the
// ciphertext lands in a 0600 file per connector under userData. The
// plaintext is never written to disk in the clear, never stored in
// settings, SQLite or localStorage, never logged, and never returned to
// the renderer: only ok/reason answers and masked status cross the IPC
// boundary. Fail closed: if the OS cannot encrypt, nothing is saved and
// the connector's connect keeps refusing with credential_ref_required.
//
// safeStorage, fs and the directory path are injected so this is unit
// testable without pretending to test the platform's cryptography: the
// tests cover OUR fail-closed logic, not a fake safeStorage.

const path = require('path');

// Matches the catalog's connector id shape (companiondesk-rss and friends).
const ID_RE = /^companiondesk-[a-z0-9-]{1,60}$/;

// Hard ceiling: a credential longer than this is not a credential this
// store is for, and bounding the buffer keeps the write path small.
const MAX_SECRET_CHARS = 4096;

// Linux backends Electron's safeStorage considers secure. 'basic_text'
// encrypts with a HARDCODED plaintext password (no real vault), and
// getSelectedStorageBackend() reports 'unknown' when it cannot identify a
// backend; both are treated as not secure, so we fail closed on them even
// when isEncryptionAvailable() says yes. Mirrors src/secure-store.js.
const SECURE_LINUX_BACKENDS = new Set(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']);

// The opaque reference recorded beside a connection. Deterministic from
// the id alone, so a restart re-derives it without anything about the
// credential (not even the reference) being persisted in settings.
function refFor(id) {
  return 'keychain:companiondesk-' + id;
}

function createConnectorCredentialStore({ safeStorage, fs = require('fs'), dir, log = () => {}, platform = process.platform } = {}) {
  if (!dir || typeof dir !== 'string') throw new Error('connector-credential-store: dir is required');

  function available() {
    try {
      if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function' || !safeStorage.isEncryptionAvailable()) {
        return false;
      }
      if (platform !== 'linux') return true; // macOS Keychain / Windows DPAPI
      // Linux: only a real OS secret service counts. No backend query API
      // (very old Electron) also fails closed rather than trusting the
      // optimistic default.
      if (typeof safeStorage.getSelectedStorageBackend !== 'function') return false;
      const backend = safeStorage.getSelectedStorageBackend();
      const ok = SECURE_LINUX_BACKENDS.has(backend);
      if (!ok) log('connector-credential-store: linux backend ' + String(backend) + ' is not a secure vault; credential not saved');
      return ok;
    } catch {
      return false;
    }
  }

  function fileFor(id) {
    return path.join(dir, id + '.bin');
  }

  function validateSecret(plain) {
    if (typeof plain !== 'string') return 'bad_request';
    const secret = plain.trim();
    if (!secret) return 'missing_secret';
    if (secret.length > MAX_SECRET_CHARS) return 'secret_too_long';
    return null;
  }

  // Masked status for the renderer. No credential material, no ids: ids
  // are already public in the catalog, but the count alone is enough for
  // any surface that asks.
  function status() {
    const encryptionAvailable = available();
    let count = 0;
    if (encryptionAvailable) {
      try {
        count = fs.readdirSync(dir).filter((f) => f.endsWith('.bin')).length;
      } catch {
        count = 0;
      }
    }
    return { supported: true, encryptionAvailable, count };
  }

  function hasCredential(id) {
    if (!ID_RE.test(String(id || ''))) return false;
    if (!available()) return false;
    try {
      return fs.existsSync(fileFor(id));
    } catch {
      return false;
    }
  }

  function setCredential(id, plain) {
    if (!ID_RE.test(String(id || ''))) return { ok: false, reason: 'bad_request' };
    const bad = validateSecret(plain);
    if (bad) return { ok: false, reason: bad };
    // Fail closed BEFORE any write: no plaintext, no partial file, no
    // fallback to unencrypted storage.
    if (!available()) {
      log('connector-credential-store: OS encryption unavailable; credential not saved');
      return { ok: false, reason: 'encryption_unavailable' };
    }
    let cipher;
    try {
      cipher = safeStorage.encryptString(plain.trim());
    } catch {
      log('connector-credential-store: encryption failed; credential not saved');
      return { ok: false, reason: 'encryption_unavailable' };
    }
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      // Atomic publish: write to a temp file beside the target, then
      // rename over it. A crash or disk error mid-write can never leave a
      // torn partial credential behind (a file that makes hasCredential
      // say yes while readCredential returns null).
      const tmp = fileFor(id) + '.tmp';
      try {
        fs.writeFileSync(tmp, Buffer.from(cipher), { mode: 0o600 });
        fs.renameSync(tmp, fileFor(id));
      } catch (err) {
        try { fs.unlinkSync(tmp); } catch (e2) { /* already gone: fine */ }
        throw err;
      }
    } catch {
      log('connector-credential-store: could not write the credential file');
      return { ok: false, reason: 'credential_file_write_failed' };
    }
    return { ok: true, ref: refFor(id), hasCredential: true };
  }

  // Main-process only. Returns the plaintext to the caller that will put
  // it on the service's Authorization path; the renderer never receives
  // it, and nothing in this build calls it: the service-call layer is a
  // later Gate 2 step. Any failure (no encryption, unreadable or
  // undecryptable file) returns null, which leaves the connector
  // effectively unauthenticated rather than half-authenticated.
  function readCredential(id) {
    if (!ID_RE.test(String(id || ''))) return null;
    if (!available()) return null;
    let blob;
    try {
      blob = fs.readFileSync(fileFor(id));
    } catch {
      return null;
    }
    try {
      const secret = safeStorage.decryptString(blob);
      return typeof secret === 'string' && secret ? secret : null;
    } catch {
      // The vault changed under us (OS reinstalled, profile moved): fail
      // closed rather than holding onto undecryptable bytes.
      log('connector-credential-store: stored credential could not be decrypted; treating as absent');
      return null;
    }
  }

  function removeCredential(id) {
    if (!ID_RE.test(String(id || ''))) return { ok: false, reason: 'bad_request' };
    try {
      fs.unlinkSync(fileFor(id));
    } catch (err) {
      if (err && err.code !== 'ENOENT') return { ok: false, reason: 'credential_file_remove_failed' };
    }
    return { ok: true, hasCredential: false };
  }

  function listIds() {
    if (!available()) return [];
    try {
      return fs.readdirSync(dir)
        .filter((f) => f.endsWith('.bin'))
        .map((f) => f.slice(0, -4))
        .filter((id) => ID_RE.test(id));
    } catch {
      return [];
    }
  }

  return { status, hasCredential, setCredential, readCredential, removeCredential, listIds, available };
}

module.exports = { createConnectorCredentialStore, refFor, ID_RE, MAX_SECRET_CHARS };
