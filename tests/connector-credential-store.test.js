'use strict';

// Gate 2 credential step (27 Nov 2026): the service-agnostic connector
// credential vault. Pins the fail-closed contract: nothing is saved when
// the OS cannot encrypt, nothing is readable back to a renderer surface,
// nothing leaks into a file, status or log, and the opaque reference the
// connect gate needs is deterministic from the id alone so settings never
// persist anything about credentials.
//
// safeStorage and fs are injected: the fake safeStorage tests OUR logic
// (gating, validation, file handling), never a pretend crypto stack.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createConnectorCredentialStore, refFor, ID_RE, MAX_SECRET_CHARS } = require('../src/connector-credential-store.js');

function fakeSafeStorage({ ok = true, backend = null, noBackendQuery = false } = {}) {
  const s = {
    isEncryptionAvailable: () => ok,
    encryptString: (str) => Buffer.from('enc:' + Buffer.from(str, 'utf8').toString('base64'), 'utf8'),
    decryptString: (buf) => {
      const str = buf.toString('utf8');
      if (!str.startsWith('enc:')) throw new Error('not our ciphertext');
      return Buffer.from(str.slice(4), 'base64').toString('utf8');
    },
  };
  if (!noBackendQuery) s.getSelectedStorageBackend = () => backend;
  return s;
}

function store({ platform = 'darwin', safeStorage = fakeSafeStorage() } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-cred-'));
  const logs = [];
  const s = createConnectorCredentialStore({
    safeStorage,
    fs,
    dir,
    platform,
    log: (m) => logs.push(m),
  });
  s.__dir = dir;
  s.__logs = logs;
  s.__cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} };
  return s;
}

const SECRET = 'sk-test-abcdef0123456789';

test('set then read round-trips the secret; the ref is opaque and deterministic', () => {
  const s = store();
  try {
    const r = s.setCredential('companiondesk-rss', SECRET);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.ref, 'keychain:companiondesk-companiondesk-rss');
    assert.strictEqual(s.hasCredential('companiondesk-rss'), true);
    assert.strictEqual(s.readCredential('companiondesk-rss'), SECRET);
    assert.strictEqual(s.setCredential('companiondesk-rss', SECRET + '-2').ref, r.ref, 'ref is deterministic');
    assert.strictEqual(s.readCredential('companiondesk-rss'), SECRET + '-2');
  } finally { s.__cleanup(); }
});

test('the reference format matches the connect gate credential pattern exactly', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'connectors.js'), 'utf8');
  const m = src.match(/const CREDENTIAL_RE = (\/.+\/);/);
  assert.ok(m, 'connectors.js still declares CREDENTIAL_RE');
  const literal = m[1];
  const lastSlash = literal.lastIndexOf('/');
  const re = new RegExp(literal.slice(1, lastSlash), literal.slice(lastSlash + 1));
  for (const id of ['companiondesk-rss', 'companiondesk-filesystem', 'companiondesk-github']) {
    assert.ok(re.test(refFor(id)), 'ref fits the connect gate: ' + refFor(id));
  }
  assert.ok(ID_RE.test('companiondesk-rss'));
  assert.ok(!ID_RE.test('not-a-connector'), 'foreign ids are refused at the door');
});

test('fail closed: no OS encryption means nothing is saved, nothing is readable', () => {
  const s = store({ safeStorage: fakeSafeStorage({ ok: false }) });
  try {
    const r = s.setCredential('companiondesk-rss', SECRET);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'encryption_unavailable');
    assert.strictEqual(s.hasCredential('companiondesk-rss'), false);
    assert.strictEqual(s.readCredential('companiondesk-rss'), null);
    assert.deepStrictEqual(fs.readdirSync(s.__dir).length, 0, 'no file was written');
    assert.strictEqual(s.status().encryptionAvailable, false);
    assert.strictEqual(s.status().count, 0);
  } finally { s.__cleanup(); }
});

test('linux: only a real secret service counts; basic_text and unknown backends fail closed', () => {
  const refused = store({ platform: 'linux', safeStorage: fakeSafeStorage({ backend: 'basic_text' }) });
  try {
    assert.strictEqual(refused.setCredential('companiondesk-rss', SECRET).reason, 'encryption_unavailable');
    assert.strictEqual(refused.available(), false);
  } finally { refused.__cleanup(); }
  const refusedUnknown = store({ platform: 'linux', safeStorage: fakeSafeStorage({ backend: 'unknown' }) });
  try { assert.strictEqual(refusedUnknown.available(), false); } finally { refusedUnknown.__cleanup(); }
  const noQuery = store({ platform: 'linux', safeStorage: fakeSafeStorage({ noBackendQuery: true }) });
  try { assert.strictEqual(noQuery.available(), false); } finally { noQuery.__cleanup(); }
  const ok = store({ platform: 'linux', safeStorage: fakeSafeStorage({ backend: 'gnome_libsecret' }) });
  try {
    assert.strictEqual(ok.setCredential('companiondesk-rss', SECRET).ok, true);
    assert.strictEqual(ok.readCredential('companiondesk-rss'), SECRET);
  } finally { ok.__cleanup(); }
});

test('validation: bad ids, missing, non-string and oversized secrets are refused', () => {
  const s = store();
  try {
    for (const id of ['', 'rss', 'companiondesk-', 'companiondesk-UPPER', 'companiondesk-' + 'x'.repeat(61)]) {
      assert.strictEqual(s.setCredential(id, SECRET).reason, 'bad_request', 'id: ' + JSON.stringify(id));
      assert.strictEqual(s.hasCredential(id), false);
    }
    for (const bad of [undefined, null, 42, '', '   ']) {
      const r = s.setCredential('companiondesk-rss', bad);
      assert.strictEqual(r.ok, false, 'secret: ' + JSON.stringify(bad));
    }
    assert.strictEqual(s.setCredential('companiondesk-rss', 'x'.repeat(MAX_SECRET_CHARS + 1)).reason, 'secret_too_long');
    assert.strictEqual(fs.readdirSync(s.__dir).length, 0, 'nothing was written for refused input');
  } finally { s.__cleanup(); }
});

test('the plaintext never lands on disk, in status, in hasCredential or in a log line', () => {
  const s = store();
  try {
    s.setCredential('companiondesk-github', SECRET);
    const raw = fs.readFileSync(path.join(s.__dir, 'companiondesk-github.bin'), 'utf8');
    assert.ok(!raw.includes(SECRET), 'ciphertext only on disk');
    for (const v of [s.status(), s.hasCredential('companiondesk-github'), s.listIds()]) {
      assert.ok(!JSON.stringify(v).includes(SECRET), 'no secret in status/flags/list');
    }
    assert.strictEqual(s.__logs.length, 0, 'no log line on the happy path');
  } finally { s.__cleanup(); }
});

test('removeCredential clears the entry; removing an absent one stays ok', () => {
  const s = store();
  try {
    s.setCredential('companiondesk-rss', SECRET);
    const r = s.removeCredential('companiondesk-rss');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.hasCredential, false);
    assert.strictEqual(s.hasCredential('companiondesk-rss'), false);
    assert.strictEqual(s.readCredential('companiondesk-rss'), null);
    assert.strictEqual(s.removeCredential('companiondesk-rss').ok, true, 'ENOENT is tolerated');
    assert.strictEqual(s.status().count, 0);
  } finally { s.__cleanup(); }
});

test('listIds and status report exactly what is stored, ids only', () => {
  const s = store();
  try {
    assert.deepStrictEqual(s.listIds(), []);
    s.setCredential('companiondesk-rss', SECRET);
    s.setCredential('companiondesk-github', SECRET);
    assert.deepStrictEqual(s.listIds().sort(), ['companiondesk-github', 'companiondesk-rss']);
    assert.strictEqual(s.status().count, 2);
    s.removeCredential('companiondesk-rss');
    assert.deepStrictEqual(s.listIds(), ['companiondesk-github']);
  } finally { s.__cleanup(); }
});

test('an undecryptable file fails closed to absent, not to a broken half-auth', () => {
  const s = store();
  try {
    s.setCredential('companiondesk-rss', SECRET);
    fs.writeFileSync(path.join(s.__dir, 'companiondesk-rss.bin'), Buffer.from('tampered'), { mode: 0o600 });
    assert.strictEqual(s.readCredential('companiondesk-rss'), null);
    assert.ok(s.__logs.some((m) => m.includes('could not be decrypted')), 'the failure is logged without the secret');
  } finally { s.__cleanup(); }
});

test('files carry restrictive modes and live in a dedicated directory', () => {
  const s = store();
  try {
    s.setCredential('companiondesk-rss', SECRET);
    const st = fs.statSync(path.join(s.__dir, 'companiondesk-rss.bin'));
    assert.strictEqual(st.mode & 0o777, 0o600, '0600 on the credential file');
    const dirSt = fs.statSync(s.__dir);
    assert.ok((dirSt.mode & 0o077) === 0, 'the credential directory is group/world closed');
    assert.ok(path.basename(s.__dir).startsWith('cd-cred-'), 'a dedicated vault directory, not a shared one');
  } finally { s.__cleanup(); }
});

test('setCredential trims accidental whitespace instead of storing a broken token', () => {
  const s = store();
  try {
    s.setCredential('companiondesk-rss', '  ' + SECRET + '  ');
    assert.strictEqual(s.readCredential('companiondesk-rss'), SECRET);
  } finally { s.__cleanup(); }
});
