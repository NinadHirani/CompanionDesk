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

// The language table whisper.cpp itself recognizes, verified live from its
// own source (src/whisper.cpp, the g_lang map, ggml-org/whisper.cpp master,
// 24 Nov 2026): each two-letter code is exactly what whisper-cli accepts on
// -l, paired with the language name whisper.cpp maps it to. Nothing outside
// this table is ever passed to the CLI as a language.
const LANGUAGES = Object.freeze({
  'en': 'english',
  'zh': 'chinese',
  'de': 'german',
  'es': 'spanish',
  'ru': 'russian',
  'ko': 'korean',
  'fr': 'french',
  'ja': 'japanese',
  'pt': 'portuguese',
  'tr': 'turkish',
  'pl': 'polish',
  'ca': 'catalan',
  'nl': 'dutch',
  'ar': 'arabic',
  'sv': 'swedish',
  'it': 'italian',
  'id': 'indonesian',
  'hi': 'hindi',
  'fi': 'finnish',
  'vi': 'vietnamese',
  'he': 'hebrew',
  'uk': 'ukrainian',
  'el': 'greek',
  'ms': 'malay',
  'cs': 'czech',
  'ro': 'romanian',
  'da': 'danish',
  'hu': 'hungarian',
  'ta': 'tamil',
  'no': 'norwegian',
  'th': 'thai',
  'ur': 'urdu',
  'hr': 'croatian',
  'bg': 'bulgarian',
  'lt': 'lithuanian',
  'la': 'latin',
  'mi': 'maori',
  'ml': 'malayalam',
  'cy': 'welsh',
  'sk': 'slovak',
  'te': 'telugu',
  'fa': 'persian',
  'lv': 'latvian',
  'bn': 'bengali',
  'sr': 'serbian',
  'az': 'azerbaijani',
  'sl': 'slovenian',
  'kn': 'kannada',
  'et': 'estonian',
  'mk': 'macedonian',
  'br': 'breton',
  'eu': 'basque',
  'is': 'icelandic',
  'hy': 'armenian',
  'ne': 'nepali',
  'mn': 'mongolian',
  'bs': 'bosnian',
  'kk': 'kazakh',
  'sq': 'albanian',
  'sw': 'swahili',
  'gl': 'galician',
  'mr': 'marathi',
  'pa': 'punjabi',
  'si': 'sinhala',
  'km': 'khmer',
  'sn': 'shona',
  'yo': 'yoruba',
  'so': 'somali',
  'af': 'afrikaans',
  'oc': 'occitan',
  'ka': 'georgian',
  'be': 'belarusian',
  'tg': 'tajik',
  'sd': 'sindhi',
  'gu': 'gujarati',
  'am': 'amharic',
  'yi': 'yiddish',
  'lo': 'lao',
  'uz': 'uzbek',
  'fo': 'faroese',
  'ps': 'pashto',
  'tk': 'turkmen',
  'nn': 'nynorsk',
  'mt': 'maltese',
  'sa': 'sanskrit',
  'lb': 'luxembourgish',
  'my': 'myanmar',
  'bo': 'tibetan',
  'tl': 'tagalog',
  'mg': 'malagasy',
  'as': 'assamese',
  'tt': 'tatar',
  'ln': 'lingala',
  'ha': 'hausa',
  'ba': 'bashkir',
  'jw': 'javanese',
  'su': 'sundanese',
});

// Exact, case-insensitive lookup of a code ("hi") or a language name
// ("Hindi") against the verified table. Anything else returns null: a
// string we cannot verify is never handed to the binary.
function lookupLanguage(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (!s) return null;
  if (Object.prototype.hasOwnProperty.call(LANGUAGES, s)) return s;
  for (const code of Object.keys(LANGUAGES)) {
    if (LANGUAGES[code] === s) return code;
  }
  return null;
}

// The transcription language: the user's WHISPER_LANG env stays the explicit
// override (M6 decision), but only a value the verified table knows is
// passed on; the existing free-text `language` setting is mapped the same
// way; an unknown value fails closed to 'en', the behavior before this
// slice. 'auto' is deliberately not enabled: language detection is a
// behavior change, not a mapping.
function resolveLanguage({ setting = null, env = null } = {}) {
  return lookupLanguage(env) || lookupLanguage(setting) || 'en';
}

// A code the table knows (the only thing transcribe will pass to -l).
function isKnownLanguage(v) {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(LANGUAGES, v);
}

module.exports = { findWhisper, cleanTranscript, transcribe, LANGUAGES, resolveLanguage, lookupLanguage, isKnownLanguage };
