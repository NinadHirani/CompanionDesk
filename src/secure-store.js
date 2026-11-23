'use strict';

// Encrypted-at-rest storage for the optional Gemini API key. Desktop only.
// Electron's safeStorage encrypts with the OS credential vault (Keychain on
// macOS, DPAPI on Windows, kwallet/libsecret on Linux); the ciphertext lands
// in a 0600 file under the app's userData directory. The plaintext key is
// never written to disk in the clear, never stored in settings, SQLite or
// localStorage, never logged, and never returned to the renderer: only
// masked status booleans cross the IPC boundary. Fail closed: if the OS
// cannot encrypt, nothing is saved and the cloud fallback stays off.
//
// safeStorage, fs and the file path are injected so the wrapper can be unit
// tested without faking the platform's actual cryptography: the tests cover
// OUR fail-closed logic, not a pretend safeStorage.

function normalizeKey(value) {
  const key = String(value == null ? '' : value).trim();
  if (!key) return { ok: false, error: 'missing_key' };
  // Google AI Studio keys start with AIza. Rejecting other shapes here keeps
  // junk out of the vault without ever echoing the value back.
  if (!/^AIza[A-Za-z0-9_-]{30,60}$/.test(key)) return { ok: false, error: 'invalid_key_format' };
  return { ok: true, key };
}

// Linux backends Electron's safeStorage considers secure. 'basic_text'
// encrypts with a HARDCODED plaintext password (no real vault), and
// getSelectedStorageBackend() reports 'unknown' when it cannot identify a
// backend; Electron's own docs treat both as not secure, so we fail closed
// on them even when isEncryptionAvailable() says yes.
const SECURE_LINUX_BACKENDS = new Set(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']);

function createSecureStore({ safeStorage, fs = require('fs'), filePath, log = () => {}, platform = process.platform } = {}) {
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
      if (!ok) log(`secure-store: linux backend ${String(backend)} is not a secure vault; key not saved`);
      return ok;
    } catch {
      return false;
    }
  }

  // Masked status for the renderer. No key material, ever.
  function status() {
    const encryptionAvailable = available();
    let configured = false;
    if (encryptionAvailable) {
      try { configured = fs.existsSync(filePath); } catch { configured = false; }
    }
    return { supported: true, encryptionAvailable, configured };
  }

  function saveKey(plain) {
    const check = normalizeKey(plain);
    if (!check.ok) return { ok: false, error: check.error };
    // Fail closed BEFORE any write: no plaintext, no partial file, no
    // fallback to unencrypted storage.
    if (!available()) {
      log('secure-store: OS encryption unavailable; key not saved');
      return { ok: false, error: 'encryption_unavailable' };
    }
    let cipher;
    try {
      cipher = safeStorage.encryptString(check.key);
    } catch {
      log('secure-store: encryption failed; key not saved');
      return { ok: false, error: 'encryption_unavailable' };
    }
    try {
      fs.writeFileSync(filePath, Buffer.from(cipher), { mode: 0o600 });
    } catch {
      log('secure-store: could not write the key file');
      return { ok: false, error: 'key_file_write_failed' };
    }
    return { ok: true, ...status() };
  }

  // Main-process only. Returns the plaintext to the caller that will put it
  // in the Authorization path of the Gemini request; the renderer never
  // receives it. Any failure (no encryption, unreadable or undecryptable
  // file) returns null, which leaves the cloud fallback off.
  function readKey() {
    if (!available()) return null;
    let blob;
    try {
      blob = fs.readFileSync(filePath);
    } catch {
      return null;
    }
    try {
      const key = safeStorage.decryptString(blob);
      return typeof key === 'string' && key ? key : null;
    } catch {
      // The vault changed under us (OS reinstalled, profile moved): fail
      // closed rather than holding onto undecryptable bytes.
      log('secure-store: stored key could not be decrypted; treating as absent');
      return null;
    }
  }

  function removeKey() {
    try {
      fs.unlinkSync(filePath);
    } catch (err) {
      if (err && err.code !== 'ENOENT') return { ok: false, error: 'key_file_remove_failed' };
    }
    return { ok: true, ...status() };
  }

  return { status, saveKey, readKey, removeKey, available };
}

module.exports = { createSecureStore, normalizeKey };
