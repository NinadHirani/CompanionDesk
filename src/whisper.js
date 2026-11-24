'use strict';

// Local speech-to-text through a whisper.cpp binary the user installs. Audio
// is written to a temporary file on this computer, handed to the binary, and
// deleted straight after. Nothing is sent anywhere.
//
// The binary and model are found only from fixed locations or environment
// variables, never from anything the renderer sends, so a compromised page
// cannot make the app run an arbitrary program.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { pcm16ToWav } = require('./wav');

const BIN_CANDIDATES = ['/opt/homebrew/bin/whisper-cli', '/usr/local/bin/whisper-cli', '/opt/homebrew/bin/whisper-cpp', '/usr/local/bin/whisper-cpp', '/usr/bin/whisper-cli'];
// Fixed allowlist: English .en models plus the multilingual twins, so a
// multilingual (e.g. Hindi) model can be added later just by placing its
// file in the models folder. preferredModel names the file the user
// configured; it is only an order hint inside this fixed list, never a path.
const MODEL_NAMES = [
  'ggml-small.en.bin', 'ggml-base.en.bin', 'ggml-tiny.en.bin',
  'ggml-small.bin', 'ggml-base.bin', 'ggml-tiny.bin',
];
const MODEL_RE = /^[a-z0-9.]+\.bin$/;

function normalizePreferred(preferred) {
  if (typeof preferred !== 'string' || !MODEL_RE.test(preferred)) return null;
  return MODEL_NAMES.includes(preferred) ? preferred : null;
}

// -> { available: true, bin, model } | { available: false, reason: 'no_binary' | 'no_model' }
function findWhisper({ env = process.env, modelsDir, preferred, exists = fs.existsSync } = {}) {
  const bin = [env.WHISPER_BIN, ...BIN_CANDIDATES].filter(Boolean).find((p) => exists(p));
  if (!bin) return { available: false, reason: 'no_binary' };
  const preferredModel = normalizePreferred(preferred);
  const names = [
    ...(preferredModel ? [preferredModel] : []),
    ...MODEL_NAMES.filter((n) => n !== preferredModel),
  ];
  // The user's own WHISPER_MODEL env stays an explicit path override (as
  // before); the allowlist constrains only what the app itself can select.
  // A bare allowlisted name in the env resolves inside the models folder;
  // anything else is taken as the explicit path it looks like.
  const envValue = env.WHISPER_MODEL;
  const envPath = (typeof envValue === 'string' && MODEL_NAMES.includes(envValue) && modelsDir)
    ? path.join(modelsDir, envValue)
    : envValue;
  const models = [
    envPath,
    ...(modelsDir ? names.map((n) => path.join(modelsDir, n)) : []),
  ].filter(Boolean);
  const model = models.find((p) => exists(p));
  if (!model) return { available: false, reason: 'no_model' };
  return { available: true, bin, model };
}

// Strip timestamps and non-speech tags such as [BLANK_AUDIO] or (music).
function cleanTranscript(stdout) {
  return String(stdout)
    .split(/\r?\n/)
    .map((l) => l.replace(/\[\d\d:\d\d:\d\d(\.\d+)?\s*-->\s*\d\d:\d\d:\d\d(\.\d+)?\]/g, '').trim())
    .map((l) => l.replace(/\[[A-Z_ ]+\]|\((?:silence|music|noise|[a-z ]{1,20})\)/gi, '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function run(bin, args, { timeoutMs, onSpawn }) {
  return new Promise((resolve, reject) => {
    const child = execFile(bin, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err); else resolve({ stdout });
    });
    if (onSpawn) onSpawn(child); // lets the caller cancel by killing the process
  });
}

// pcm: Buffer of 16 kHz mono Int16 samples. -> transcript text
async function transcribe({ pcm, bin, model, language = 'en', timeoutMs = 30000, tmpDir = os.tmpdir(), runner = run, onSpawn }) {
  const dir = await fs.promises.mkdtemp(path.join(tmpDir, 'companiondesk-voice-'));
  try {
    const wavFile = path.join(dir, 'speech.wav');
    await fs.promises.writeFile(wavFile, pcm16ToWav(pcm, 16000));
    const { stdout } = await runner(bin, ['-m', model, '-f', wavFile, '-l', language, '-nt', '-np'], { timeoutMs, onSpawn });
    return cleanTranscript(stdout);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

module.exports = { findWhisper, cleanTranscript, transcribe };
