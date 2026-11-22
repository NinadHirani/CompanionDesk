'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pcm16ToWav } = require('../src/wav');
const vad = require('../src/vad');
const whisper = require('../src/whisper');
const voice = require('../src/voice');

const RATE = 16000;
const tone = (ms, amp = 0.3, freq = 440) => Int16Array.from({ length: (RATE * ms) / 1000 }, (_, i) => Math.round(Math.sin((2 * Math.PI * freq * i) / RATE) * amp * 32767));
const silence = (ms) => new Int16Array((RATE * ms) / 1000);
const concat = (...a) => { const out = new Int16Array(a.reduce((n, x) => n + x.length, 0)); let o = 0; for (const x of a) { out.set(x, o); o += x.length; } return out; };
const bytes = (i16) => Buffer.from(i16.buffer, i16.byteOffset, i16.byteLength);

test('wav: a correct 44-byte header followed by the samples', () => {
  const pcm = bytes(tone(100));
  const wav = pcm16ToWav(pcm, 16000);
  assert.equal(wav.length, 44 + pcm.length);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(4), 36 + pcm.length);
  assert.equal(wav.toString('ascii', 8, 16), 'WAVEfmt ');
  assert.equal(wav.readUInt16LE(20), 1, 'PCM');
  assert.equal(wav.readUInt16LE(22), 1, 'mono');
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt32LE(28), 32000, 'byte rate');
  assert.equal(wav.readUInt16LE(34), 16, 'bits');
  assert.equal(wav.toString('ascii', 36, 40), 'data');
  assert.equal(wav.readUInt32LE(40), pcm.length);
  assert.deepEqual(wav.subarray(44), pcm);
});

test('vad: silence and faint noise are not speech; a tone is', () => {
  assert.equal(vad.hasSpeech(silence(2000)), false);
  const hiss = Int16Array.from({ length: RATE * 2 }, (_, i) => Math.round((Math.sin(i * 12.9898) * 43758.5453 % 1) * 0.004 * 32767));
  assert.equal(vad.hasSpeech(hiss), false, 'background hiss');
  assert.equal(vad.hasSpeech(tone(1000)), true);
});

test('vad: a blip shorter than 300 ms is not enough', () => {
  assert.equal(vad.hasSpeech(concat(silence(500), tone(100), silence(500))), false);
  assert.equal(vad.hasSpeech(concat(silence(500), tone(400), silence(500))), true);
});

test('vad: trimming keeps the spoken part with a little padding', () => {
  const rec = concat(silence(1000), tone(600), silence(1000));
  const trimmed = vad.trimSilence(rec, RATE, { padMs: 200 });
  const ms = (trimmed.length / RATE) * 1000;
  assert.ok(ms >= 600 && ms <= 1100, `trimmed to ${ms} ms`);
  assert.ok(vad.hasSpeech(trimmed));
  assert.equal(vad.trimSilence(silence(1000)).length, 0, 'nothing to keep');
});

test('whisper: output is cleaned of timestamps and non-speech tags', () => {
  const raw = '[00:00:00.000 --> 00:00:02.000]   What is due\n[00:00:02.000 --> 00:00:04.000]  this week?\n[BLANK_AUDIO]\n(silence)\n';
  assert.equal(whisper.cleanTranscript(raw), 'What is due this week?');
  assert.equal(whisper.cleanTranscript('  plain text, no stamps  '), 'plain text, no stamps');
  assert.equal(whisper.cleanTranscript('[BLANK_AUDIO]\n'), '');
});

test('whisper: found only in fixed places or env, and the reason is reported', () => {
  const have = new Set(['/opt/homebrew/bin/whisper-cli', '/m/ggml-base.en.bin']);
  const exists = (p) => have.has(p);
  assert.deepEqual(whisper.findWhisper({ env: {}, modelsDir: '/m', exists }), { available: true, bin: '/opt/homebrew/bin/whisper-cli', model: '/m/ggml-base.en.bin' });
  assert.deepEqual(whisper.findWhisper({ env: {}, modelsDir: '/other', exists }), { available: false, reason: 'no_model' });
  assert.deepEqual(whisper.findWhisper({ env: {}, modelsDir: '/m', exists: () => false }), { available: false, reason: 'no_binary' });
  assert.equal(whisper.findWhisper({ env: { WHISPER_BIN: '/x/w', WHISPER_MODEL: '/x/m.bin' }, exists: (p) => p === '/x/w' || p === '/x/m.bin' }).bin, '/x/w');
});

function fakeWhisper(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companiondesk-fakew-'));
  const bin = path.join(dir, 'fake-whisper.sh');
  fs.writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return { dir, bin };
}

test('whisper: a real child process transcribes a WAV and the temp audio is deleted', async () => {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'companiondesk-log-')), 'seen.txt');
  const { bin } = fakeWhisper(`
while [ $# -gt 0 ]; do case "$1" in -f) f="$2"; shift;; -m) m="$2"; shift;; -l) l="$2"; shift;; esac; shift; done
head -c 4 "$f" > ${log}; echo " $f $m $l" >> ${log}
echo "[00:00:00.000 --> 00:00:01.000]  hello from the stand-in"
echo "[BLANK_AUDIO]"`);
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'companiondesk-tmp-'));
  const text = await whisper.transcribe({ pcm: bytes(tone(500)), bin, model: '/models/m.bin', language: 'en', tmpDir: tmpRoot });
  assert.equal(text, 'hello from the stand-in');
  const seen = fs.readFileSync(log, 'utf8');
  assert.ok(seen.startsWith('RIFF'), 'the binary received a real WAV');
  assert.ok(seen.includes('/models/m.bin en'));
  assert.deepEqual(fs.readdirSync(tmpRoot), [], 'no audio left on disk');
});

test('whisper: a failing or hanging binary rejects, and still leaves no audio behind', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'companiondesk-tmp-'));
  const fail = fakeWhisper('exit 3');
  await assert.rejects(() => whisper.transcribe({ pcm: bytes(tone(500)), bin: fail.bin, model: 'm', tmpDir: tmpRoot }));
  const hang = fakeWhisper('sleep 5');
  const t0 = Date.now();
  await assert.rejects(() => whisper.transcribe({ pcm: bytes(tone(500)), bin: hang.bin, model: 'm', tmpDir: tmpRoot, timeoutMs: 300 }));
  assert.ok(Date.now() - t0 < 3000, 'the timeout fired');
  assert.deepEqual(fs.readdirSync(tmpRoot), []);
});

test('voice service: refuses bad input, silence, long audio and a missing binary', async () => {
  const found = { available: true, bin: 'b', model: 'm' };
  const calls = [];
  const run = async (a) => { calls.push(a); return 'what is due this week'; };
  const deps = { find: () => found, run };

  assert.equal((await voice.transcribe(null, deps)).error, 'bad_request');
  assert.equal((await voice.transcribe({ pcm: 'text' }, deps)).error, 'bad_request');
  assert.equal((await voice.transcribe({ pcm: Buffer.alloc(3) }, deps)).error, 'bad_request', 'odd byte count');
  assert.equal((await voice.transcribe({ pcm: bytes(tone(100)) }, deps)).error, 'no_speech', 'too short');
  assert.equal((await voice.transcribe({ pcm: bytes(silence(2000)) }, deps)).error, 'no_speech');
  assert.equal((await voice.transcribe({ pcm: Buffer.alloc(voice.MAX_BYTES + 2) }, deps)).error, 'too_long');
  assert.deepEqual(await voice.transcribe({ pcm: bytes(tone(1000)) }, { ...deps, find: () => ({ available: false, reason: 'no_binary' }) }), { ok: false, error: 'voice_unavailable', reason: 'no_binary' });
  assert.equal(calls.length, 0, 'the transcriber never ran for any of those');
});

test('voice service: speech is trimmed and transcribed; failures are reported, not thrown', async () => {
  const seen = [];
  const deps = { find: () => ({ available: true, bin: 'b', model: 'm' }), run: async (a) => { seen.push(a); return 'what is due this week'; } };
  const rec = concat(silence(1000), tone(800), silence(1000));
  assert.deepEqual(await voice.transcribe({ pcm: bytes(rec) }, deps), { ok: true, text: 'what is due this week' });
  assert.ok(seen[0].pcm.length < bytes(rec).length, 'dead air was trimmed before transcribing');
  assert.equal(seen[0].bin, 'b');

  assert.deepEqual(await voice.transcribe({ pcm: bytes(rec) }, { ...deps, run: async () => { throw new Error('boom'); } }), { ok: false, error: 'transcribe_failed' });
  assert.deepEqual(await voice.transcribe({ pcm: bytes(rec) }, { ...deps, run: async () => '' }), { ok: false, error: 'no_speech' });
  // ArrayBuffer and typed-array views from IPC are accepted too.
  assert.equal((await voice.transcribe({ pcm: rec.buffer.slice(0) }, deps)).ok, true);
  assert.equal((await voice.transcribe({ pcm: new Uint8Array(bytes(rec)) }, deps)).ok, true);
});

test('voice status reports why it is unavailable', () => {
  assert.deepEqual(voice.status({ find: () => ({ available: false, reason: 'no_model' }) }), { ok: true, available: false, reason: 'no_model' });
  assert.deepEqual(voice.status({ find: () => ({ available: true, bin: 'b', model: 'm' }) }), { ok: true, available: true });
});
