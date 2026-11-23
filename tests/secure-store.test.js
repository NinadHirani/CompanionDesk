'use strict';

// Optional Gemini credential slice: encrypted-at-rest storage (desktop,
// Electron safeStorage behind an injected fake), fail-closed behavior, and
// the promise that the key never reaches the renderer, a log line, a URL or
// the cloud fallback's args. safeStorage itself is NOT faked for security
// claims: the tests cover our logic around it, not the OS vault.

const test = require('node:test');
const assert = require('node:assert');
const { createSecureStore, normalizeKey } = require('../src/secure-store');
const { createAi } = require('../src/ai');
const fs = require('node:fs');
const path = require('node:path');

const KEY = 'AIzaSyA1234567890abcdefghijklmnopqrstu';
const PATH_ = '/tmp/vault/gemini.key.bin';

function fakeFs() {
  const files = new Map();
  const calls = { writes: [], unlinks: [] };
  return {
    existsSync: (f) => files.has(f),
    readFileSync: (f) => { const v = files.get(f); if (v == null) { const e = new Error('no'); e.code = 'ENOENT'; throw e; } return v; },
    writeFileSync: (f, data, opts) => { calls.writes.push({ f, data, opts }); files.set(f, data); },
    unlinkSync: (f) => { calls.unlinks.push(f); if (!files.delete(f)) { const e = new Error('no'); e.code = 'ENOENT'; throw e; } },
    files, calls,
  };
}
function fakeSafeStorage({ available = true, encryptThrows = false } = {}) {
  return {
    isEncryptionAvailable: () => available,
    // A sentinel models a real vault: undecryptable bytes throw.
    encryptString: (s) => { if (encryptThrows) throw new Error('boom'); return Buffer.from('enc:' + String(s).split('').reverse().join('')); },
    decryptString: (buf) => {
      const s = Buffer.from(buf).toString('utf8');
      if (!s.startsWith('enc:')) throw new Error('decrypt failed');
      return s.slice(4).split('').reverse().join('');
    },
  };
}

// ---- the wrapper ---------------------------------------------------------------

test('fail closed: no OS encryption means no save, no file, no key', () => {
  const f = fakeFs();
  const store = createSecureStore({ safeStorage: fakeSafeStorage({ available: false }), fs: f, filePath: PATH_ });
  const res = store.saveKey(KEY);
  assert.deepEqual(res, { ok: false, error: 'encryption_unavailable' });
  assert.equal(f.files.size, 0);
  assert.equal(store.readKey(), null);
  assert.equal(store.status().configured, false);
  assert.equal(store.status().encryptionAvailable, false);
});

test('fail closed: safeStorage.encryptString throwing leaves nothing behind', () => {
  const f = fakeFs();
  const store = createSecureStore({ safeStorage: fakeSafeStorage({ encryptThrows: true }), fs: f, filePath: PATH_ });
  assert.equal(store.saveKey(KEY).ok, false);
  assert.equal(f.files.size, 0);
});

test('missing and malformed keys are refused without a write', () => {
  const f = fakeFs();
  const store = createSecureStore({ safeStorage: fakeSafeStorage(), fs: f, filePath: PATH_ });
  assert.equal(store.saveKey('').error, 'missing_key');
  assert.equal(store.saveKey('not-a-google-key').error, 'invalid_key_format');
  assert.equal(store.saveKey('AIza-short').error, 'invalid_key_format');
  assert.equal(f.files.size, 0);
  for (const bad of ['', null, undefined]) {
    const r = normalizeKey(bad);
    assert.equal(r.ok, false);
  }
  assert.deepEqual(JSON.stringify(store.saveKey(KEY)).includes('AIza'), false);
  // ... and a good one still passes validation
  assert.equal(normalizeKey(KEY).ok, true);
});

test('save and read round-trip; the file holds ciphertext, not plaintext', () => {
  const f = fakeFs();
  const store = createSecureStore({ safeStorage: fakeSafeStorage(), fs: f, filePath: PATH_ });
  const res = store.saveKey(`  ${KEY}  `); // trimmed
  assert.equal(res.ok, true);
  assert.equal(res.configured, true);
  const blob = f.files.get(PATH_);
  assert.equal(blob.toString('utf8').includes(KEY), false);
  assert.deepEqual(f.calls.writes[0].opts.mode, 0o600);
  assert.equal(store.readKey(), KEY);
});

test('status carries booleans only: no key material ever crosses IPC', () => {
  const f = fakeFs();
  const store = createSecureStore({ safeStorage: fakeSafeStorage(), fs: f, filePath: PATH_ });
  store.saveKey(KEY);
  const s = JSON.stringify(store.status());
  assert.equal(s.includes('AIza'), false);
  assert.deepEqual(Object.keys(store.status()).sort(), ['configured', 'encryptionAvailable', 'supported']);
});

test('undecryptable ciphertext fails closed: cloud stays off', () => {
  const f = fakeFs();
  const store = createSecureStore({ safeStorage: fakeSafeStorage(), fs: f, filePath: PATH_ });
  store.saveKey(KEY);
  f.files.set(PATH_, Buffer.from('garbage that is not vault ciphertext'));
  assert.equal(store.readKey(), null);
});

test('removeKey clears the key and tolerates a missing file', () => {
  const f = fakeFs();
  const store = createSecureStore({ safeStorage: fakeSafeStorage(), fs: f, filePath: PATH_ });
  assert.equal(store.removeKey().ok, true); // nothing saved yet
  store.saveKey(KEY);
  const res = store.removeKey();
  assert.equal(res.ok, true);
  assert.equal(res.configured, false);
  assert.equal(store.readKey(), null);
  assert.equal(store.removeKey().ok, true);
});

// ---- ai.js: the key is read lazily and never leaks ------------------------------

function mockFetch(routes) {
  return async (url, opts = {}) => {
    for (const [match, handler] of routes) {
      const hit = typeof match === 'function' ? match(url, opts) : url.includes(match);
      if (hit) return typeof handler === 'function' ? handler(opts, url) : handler;
    }
    throw new Error(`no route for ${url}`);
  };
}

test('the key getter is consulted lazily; status follows it', async () => {
  let stored = null;
  const ai = createAi({ geminiKey: () => stored, fetchImpl: mockFetch([]) });
  assert.equal((await ai.status()).cloud, false);
  stored = KEY;
  assert.equal((await ai.status()).cloud, true);
  stored = null;
  assert.equal((await ai.status()).cloud, false);
});

test('testGeminiKey checks Google with the key in a header, never a URL or a prompt', async () => {
  const seen = [];
  const ai = createAi({
    geminiKey: () => KEY,
    fetchImpl: mockFetch([[(url, opts) => { seen.push({ url, opts }); return url.includes('generativelanguage'); },
      () => ({ ok: true, json: async () => ({ models: [] }) })]]),
  });
  const res = await ai.testGeminiKey({});
  assert.equal(res.ok, true);
  assert.equal(seen[0].url.includes('key='), false);
  assert.equal(seen[0].opts.headers['x-goog-api-key'], KEY);
  assert.equal(seen[0].opts.body, undefined);
});

test('testGeminiKey reports failures without echoing the key', async () => {
  const ai = createAi({
    geminiKey: () => null,
    fetchImpl: mockFetch([[(url) => url.includes('generativelanguage'), () => ({ ok: false, status: 401 })]]),
  });
  const res = await ai.testGeminiKey({ key: KEY });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'gemini_http_401');
  assert.equal(JSON.stringify(res).includes(KEY), false);
  const none = await ai.testGeminiKey({});
  assert.equal(none.reason, 'no_cloud_key');
});

test('chatGemini puts the key in a header and failure messages stay key-free', async () => {
  const seen = [];
  const ai = createAi({
    geminiKey: () => KEY,
    fetchImpl: mockFetch([[(url, opts) => { seen.push({ url, opts }); return url.includes('generativelanguage'); },
      () => ({ ok: false, status: 403 })]]),
  });
  await assert.rejects(() => ai.chatGemini({ prompt: 'hi' }), (err) => {
    assert.equal(err.message, 'gemini_http_403');
    assert.equal(err.message.includes(KEY), false);
    return true;
  });
  assert.equal(seen[0].url.includes(KEY), false);
  assert.equal(seen[0].url.includes('key='), false);
  assert.equal(seen[0].opts.headers['x-goog-api-key'], KEY);
});

test('no key at all keeps the cloud fallback off (default-off behavior)', async () => {
  const ai = createAi({ fetchImpl: mockFetch([]) });
  await assert.rejects(() => ai.complete({ prompt: 'hi' }), /no_cloud_key|no route/);
  assert.equal((await ai.status()).cloud, false);
});

// ---- web build: no insecure storage, setup reported as unsupported --------------

test('the web bridge stores no key in localStorage and reports setup as unsupported', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'bridge.js'), 'utf8');
  assert.equal(src.includes('GEMINI_KEY_STORAGE'), false);
  assert.equal(src.includes("localStorage.getItem('companiondesk.geminiKey')"), false);
  assert.match(src, /cloud_status: \(\) => \(\{ ok: true, supported: false \}\)/);
  assert.match(src, /cloud_setKey: \(\) => \(\{ ok: false, error: 'unsupported' \}\)/);
  // no key ever reaches createAi on the web
  assert.match(src, /CompanionAi\.createAi\(\{\}\)/);
});
