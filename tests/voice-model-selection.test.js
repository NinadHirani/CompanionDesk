'use strict';

const test = require('node:test');
const assert = require('node:assert');
const whisper = require('../src/whisper');
const settings = require('../src/settings');

const EXISTS = (p) => !p.endsWith('missing.bin');
const dir = '/models';

test('the configured model is preferred inside the fixed allowlist, never a path', () => {
  // small.en present, base.en also present: small.en wins when preferred
  const w = whisper.findWhisper({ modelsDir: dir, preferred: 'ggml-small.en.bin', exists: EXISTS });
  assert.equal(w.model, '/models/ggml-small.en.bin');
  // a name outside the allowlist is ignored, not honored
  const bad = whisper.findWhisper({ modelsDir: dir, preferred: 'ggml-evil.bin', exists: EXISTS });
  assert.equal(bad.model, '/models/ggml-small.en.bin', 'allowlist order still decides when the hint is unknown');
  // a path is refused as a hint: the allowlist never takes directories
  const pathy = whisper.findWhisper({ modelsDir: dir, preferred: '/etc/evil.bin', exists: EXISTS });
  assert.equal(pathy.model, '/models/ggml-small.en.bin');
  // multilingual twins are in the allowlist, so Hindi can be added later
  const hi = whisper.findWhisper({ modelsDir: dir, preferred: 'ggml-small.bin', exists: (p) => p.startsWith('/opt') || p.startsWith('/usr') || p.endsWith('ggml-small.bin') });
  assert.equal(hi.model, '/models/ggml-small.bin');
  // no preferred hint: allowlist order (small.en first, the decided default)
  const none = whisper.findWhisper({ modelsDir: dir, exists: EXISTS });
  assert.equal(none.model, '/models/ggml-small.en.bin');
  // WHISPER_MODEL env is an explicit user override: a real path wins first...
  const envPath = whisper.findWhisper({ modelsDir: dir, env: { WHISPER_MODEL: '/x/custom.bin' }, exists: (p) => p === '/opt/homebrew/bin/whisper-cli' || p === '/x/custom.bin' });
  assert.equal(envPath.model, '/x/custom.bin');
  // ...an allowlisted env name resolves in the models folder...
  const envName = whisper.findWhisper({ modelsDir: dir, env: { WHISPER_MODEL: 'ggml-tiny.en.bin' }, exists: EXISTS });
  assert.equal(envName.model, '/models/ggml-tiny.en.bin');
  // ...and a nonexistent env path falls through to the allowlist
  const envMiss = whisper.findWhisper({ modelsDir: dir, env: { WHISPER_MODEL: '/x/missing.bin' }, exists: (p) => p.startsWith('/opt') || p.startsWith('/usr') || p.startsWith('/models') });
  assert.equal(envMiss.model, '/models/ggml-small.en.bin');
});

test('settings: small.en is the default STT model and only allowlisted ids patch', () => {
  assert.equal(settings.normalizeSettings({}).voice_model, 'small.en', 'Ninad decided small.en as the initial model');
  assert.equal(settings.normalizeSettings({ voice_model: 'nonsense' }).voice_model, 'small.en');
  const ok = settings.validatePatch({ voice_model: 'small' });
  assert.equal(ok.ok, true);
  assert.equal(ok.clean.voice_model, 'small', 'the multilingual twin is selectable for later Hindi support');
  assert.deepEqual(settings.validatePatch({ voice_model: '../hack' }).errors, ['invalid_value:voice_model']);
  assert.deepEqual(settings.ENUMS.voice_model, ['small.en', 'base.en', 'tiny.en', 'small', 'base', 'tiny']);
});
