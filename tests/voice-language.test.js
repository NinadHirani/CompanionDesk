'use strict';

// M6 slice 2: transcription language wired to the existing `language`
// setting. The language table is verified live from whisper.cpp's own
// source (src/whisper.cpp, the g_lang map); nothing outside it ever
// reaches the CLI as a -l value; an English-only model file always gets
// 'en' no matter what the settings say.

const test = require('node:test');
const assert = require('node:assert');
const whisper = require('../src/whisper');
const voice = require('../src/voice');

// Speech-bearing PCM (the all-zero buffer is VAD-gated out as silence).
const RATE = 16000;
const tonePcm = () => {
  const i16 = Int16Array.from({ length: RATE }, (_, i) => Math.round(Math.sin((2 * Math.PI * 440 * i) / RATE) * 0.3 * 32767));
  return Buffer.from(i16.buffer, i16.byteOffset, i16.byteLength);
};

test('the language table is the verified whisper.cpp table: 97 languages, code->name, all well-formed', () => {
  const codes = Object.keys(whisper.LANGUAGES);
  assert.equal(codes.length, 97);
  for (const code of codes) {
    assert.match(code, /^[a-z]{2}$/, `code ${code} must be two lowercase letters`);
    const name = whisper.LANGUAGES[code];
    assert.match(name, /^[a-z]+$/, `name ${name} must be a single lowercase word`);
  }
  // Spot checks read live from the primary source on 24 Nov 2026.
  assert.equal(whisper.LANGUAGES.en, 'english');
  assert.equal(whisper.LANGUAGES.hi, 'hindi');
  assert.equal(whisper.LANGUAGES.fr, 'french');
  assert.equal(whisper.LANGUAGES.ta, 'tamil');
  const names = codes.map((c) => whisper.LANGUAGES[c]);
  assert.equal(new Set(names).size, codes.length, 'names are unique');
});

test('resolveLanguage maps the free-text language setting case-insensitively, by code or name', () => {
  assert.equal(whisper.resolveLanguage({ setting: 'English' }), 'en');
  assert.equal(whisper.resolveLanguage({ setting: 'Hindi' }), 'hi');
  assert.equal(whisper.resolveLanguage({ setting: ' Hindi ' }), 'hi');
  assert.equal(whisper.resolveLanguage({ setting: 'HINDI' }), 'hi');
  assert.equal(whisper.resolveLanguage({ setting: 'hi' }), 'hi');
  assert.equal(whisper.resolveLanguage({ setting: 'French' }), 'fr');
  assert.equal(whisper.resolveLanguage({ setting: 'telugu' }), 'te');
});

test('resolveLanguage fails closed to en for anything unknown, malformed, or empty', () => {
  for (const bad of [undefined, null, '', '   ', 'Klingon', 'english; rm -rf /', 'en-US', 42, {}]) {
    assert.equal(whisper.resolveLanguage({ setting: bad }), 'en', `setting ${JSON.stringify(bad)}`);
  }
  assert.equal(whisper.resolveLanguage({}), 'en');
});

test('WHISPER_LANG stays the explicit override and is itself validated', () => {
  assert.equal(whisper.resolveLanguage({ setting: 'English', env: 'hi' }), 'hi');
  assert.equal(whisper.resolveLanguage({ setting: 'English', env: 'HINDI' }), 'hi');
  // An invalid env value is ignored, not passed through: the mapped
  // setting (or the default) wins.
  assert.equal(whisper.resolveLanguage({ setting: 'English', env: 'klingon' }), 'en');
  assert.equal(whisper.resolveLanguage({ setting: 'Hindi', env: 'klingon' }), 'hi');
  assert.equal(whisper.resolveLanguage({ setting: 'English', env: '  ' }), 'en');
  assert.equal(whisper.resolveLanguage({ setting: 'English', env: 7 }), 'en');
});

// voice.transcribe's injected `run` receives an options object, so these
// chain through the REAL whisper.transcribe with a capturing runner to
// assert the exact CLI args whisper-cli would receive.
const throughReal = (capture) => (opts) =>
  whisper.transcribe({ ...opts, runner: (bin, args) => { capture({ bin, args }); return Promise.resolve({ stdout: 'transcript' }); } });

test('transcribe forces en on an English-only model file regardless of the requested language', async () => {
  let seen = null;
  const find = () => ({ available: true, bin: '/bin/whisper-cli', model: '/models/ggml-small.en.bin' });
  const out = await voice.transcribe({ pcm: tonePcm() }, { find, run: throughReal((s) => { seen = s; }), language: 'hi' });
  assert.equal(out.ok, true);
  const l = seen.args[seen.args.indexOf('-l') + 1];
  assert.equal(l, 'en');
});

test('transcribe passes a known language to a multilingual model and never an unknown one', async () => {
  const find = () => ({ available: true, bin: '/bin/whisper-cli', model: '/models/ggml-small.bin' });
  for (const [requested, expected] of [['hi', 'hi'], ['Hindi', 'hi'], ['klingon', 'en'], [undefined, 'en'], ['english; rm -rf /', 'en']]) {
    let seen = null;
    await voice.transcribe({ pcm: tonePcm() }, { find, run: throughReal((s) => { seen = s; }), language: requested });
    const l = seen.args[seen.args.indexOf('-l') + 1];
    assert.equal(l, expected, `requested ${String(requested)}`);
    assert.ok(whisper.isKnownLanguage(l), `the -l value ${l} is always a verified code`);
  }
});

test('the -l value is always a verified code, whatever garbage the caller supplies', async () => {
  const find = () => ({ available: true, bin: '/bin/whisper-cli', model: '/models/ggml-base.bin' });
  const garbage = ['../../etc/passwd', '-nt', '--help', '$(whoami)', 'hi\n-np', {}, [], true, 'हिंदी'];
  for (const g of garbage) {
    let seen = null;
    await voice.transcribe({ pcm: tonePcm() }, { find, run: throughReal((s) => { seen = s; }), language: g });
    const l = seen.args[seen.args.indexOf('-l') + 1];
    assert.ok(whisper.isKnownLanguage(l), `garbage ${JSON.stringify(g)} must never reach -l`);
  }
});
