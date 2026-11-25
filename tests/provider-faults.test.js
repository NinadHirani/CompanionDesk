'use strict';

// M1 slice 6: typed, sanitized provider fault diagnostics. Every failure
// class the probes can observe gets one stable code; nothing raw (server
// bodies, URLs, prompts, key material, paths) may survive into a fault.

const test = require('node:test');
const assert = require('node:assert');
const { createAi } = require('../src/ai.js');
const F = require('../src/provider-faults.js');
const ProviderStatus = require('../src/provider-status.js');
const MS = require('../src/model-selection.js');

const LLAMA = MS.DEFAULT_CHAT_MODEL;
const GEMMA = MS.DEFAULT_VISION_MODEL;

function resp(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => JSON.parse(body), text: async () => body };
}
const tags = (names) => resp(JSON.stringify({ models: names.map((n) => ({ name: n })) }));
const show = (caps) => resp(JSON.stringify({ capabilities: caps }));

test('classifyFailure distinguishes user cancellation from a bounded timeout', () => {
  assert.deepEqual(F.classifyFailure({ callerAborted: true }), { code: 'cancelled', detail: null });
  // The caller aborting outranks a timeout that fired at the same moment.
  assert.deepEqual(F.classifyFailure({ callerAborted: true, err: { name: 'TimeoutError' } }), { code: 'cancelled', detail: null });
  assert.deepEqual(F.classifyFailure({ err: { name: 'TimeoutError' } }), { code: 'timeout', detail: null });
});

test('classifyFailure maps network and app-generated errors without copying messages', () => {
  assert.deepEqual(F.classifyFailure({ err: { code: 'ECONNREFUSED' } }), { code: 'unreachable', detail: 'ECONNREFUSED' });
  assert.deepEqual(F.classifyFailure({ err: new Error('fetch failed') }), { code: 'unreachable', detail: null });
  assert.deepEqual(F.classifyFailure({ err: { message: 'ollama_http_503' } }), { code: 'http_error', detail: '503' });
  assert.deepEqual(F.classifyFailure({ status: 429 }), { code: 'http_error', detail: '429' });
  // A raw message that is not our own strict pattern never becomes detail.
  const leaky = F.classifyFailure({ err: { message: 'SECRET-TOKEN http://10.0.0.1:11434' } });
  assert.equal(JSON.stringify(leaky).includes('SECRET'), false);
});

test('fault() only passes known codes and short details', () => {
  assert.equal(F.fault({ code: 'made_up' }), null);
  assert.equal(F.fault(null), null);
  assert.deepEqual(F.fault({ code: 'timeout' }), { code: 'timeout', detail: null });
  assert.equal(F.describeFault({ code: 'made_up' }), null);
});

test('every fault code has a Settings display string', () => {
  for (const code of F.FAULT_CODES) {
    assert.equal(typeof F.faultDisplay[code], 'string');
    assert.ok(F.faultDisplay[code].length > 0, code);
  }
  assert.equal(F.describeFault({ code: 'http_error', detail: '503' }), 'Server error (503)');
});

test('probeLocal: http_error, malformed JSON and missing models array', async () => {
  const a = createAi({ fetchImpl: async () => resp('up', 503) });
  assert.deepEqual(await a.probeLocal(), { healthy: false, models: null, fault: { code: 'http_error', detail: '503' } });
  const bad = createAi({ fetchImpl: async () => resp('<<not json>>') });
  assert.deepEqual(await bad.probeLocal(), { healthy: false, models: null, fault: { code: 'malformed', detail: null } });
  const shape = createAi({ fetchImpl: async () => resp('{"models":"yes"}') });
  assert.equal((await shape.probeLocal()).fault.code, 'malformed');
  const good = createAi({ fetchImpl: async () => tags([LLAMA]) });
  assert.deepEqual(await good.probeLocal(), { healthy: true, models: [LLAMA], fault: null });
});

test('probeLocal: unreachable with an errno detail, and bare network errors', async () => {
  const refused = createAi({
    fetchImpl: async () => { const e = new Error('fetch failed'); e.code = 'ECONNREFUSED'; throw e; },
  });
  assert.deepEqual(await refused.probeLocal(), { healthy: false, models: null, fault: { code: 'unreachable', detail: 'ECONNREFUSED' } });
  const bare = createAi({ fetchImpl: async () => { throw new Error('fetch failed'); } });
  assert.deepEqual(await bare.probeLocal(), { healthy: false, models: null, fault: { code: 'unreachable', detail: null } });
});

test('probeLocal: timeout vs user cancellation', async () => {
  const timedOut = createAi({
    fetchImpl: async () => { const e = new Error('timed out'); e.name = 'TimeoutError'; throw e; },
  });
  assert.equal((await timedOut.probeLocal()).fault.code, 'timeout');
  const ctl = new AbortController();
  ctl.abort();
  const cancelled = createAi({
    fetchImpl: async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; },
  });
  assert.equal((await cancelled.probeLocal(ctl.signal)).fault.code, 'cancelled');
});

test('probe faults never carry raw bodies, URLs or error messages', async () => {
  const leaky = createAi({
    fetchImpl: async () => resp('SECRET-BODY {"models":', 200),
  });
  const out = await leaky.probeLocal();
  const flat = JSON.stringify(out);
  assert.equal(flat.includes('SECRET'), false);
  assert.equal(flat.includes('11434'), false);
  const thrown = createAi({
    fetchImpl: async () => { throw new Error('SECRET-TOKEN http://10.0.0.1:11434/api/tags'); },
  });
  const flat2 = JSON.stringify(await thrown.probeLocal());
  assert.equal(flat2.includes('SECRET'), false);
  assert.equal(flat2.includes('11434'), false);
});

test('a stale requested model is diagnosed as missing even when a fallback serves', async () => {
  const a = createAi({
    fetchImpl: async (url) => (String(url).endsWith('/api/tags') ? tags([LLAMA]) : show(['chat'])),
  });
  const { decision, faults } = await a.routeTask('chat', { model: 'qwen2.5:7b' });
  assert.equal(decision.ok, true);
  assert.equal(decision.model, LLAMA); // falls back, never auto-downloads
  assert.equal(faults.modelMissing, true);
  const none = createAi({ fetchImpl: async (url) => (String(url).endsWith('/api/tags') ? tags([]) : show([])) });
  const refused = await none.routeTask('chat', { model: 'qwen2.5:7b' });
  assert.equal(refused.decision.reason, 'no_local_model');
  assert.equal(refused.faults.modelMissing, true);
});

test('/api/show schema variations map to distinct faults', async () => {
  const ok = createAi({ fetchImpl: async (url) => (String(url).endsWith('/api/tags') ? tags([GEMMA]) : show(['vision'])) });
  const det = await ok.modelCapabilitiesDetailed(GEMMA);
  assert.deepEqual(det, { capabilities: ['vision'], fault: null });

  const noKey = createAi({ fetchImpl: async (url) => (String(url).endsWith('/api/tags') ? tags([GEMMA]) : resp('{"family":"gemma"}')) });
  assert.equal((await noKey.modelCapabilitiesDetailed(GEMMA)).fault.code, 'capability_unknown');
  const notArray = createAi({ fetchImpl: async (url) => (String(url).endsWith('/api/tags') ? tags([GEMMA]) : resp('{"capabilities":"vision"}')) });
  assert.equal((await notArray.modelCapabilitiesDetailed(GEMMA)).fault.code, 'capability_unknown');
  const absent = createAi({ fetchImpl: async (url) => (String(url).endsWith('/api/tags') ? tags([GEMMA]) : resp('gone', 404)) });
  assert.equal((await absent.modelCapabilitiesDetailed(GEMMA)).fault.code, 'model_missing');
  const err500 = createAi({ fetchImpl: async (url) => (String(url).endsWith('/api/tags') ? tags([GEMMA]) : resp('up', 500)) });
  assert.deepEqual(await err500.modelCapabilitiesDetailed(GEMMA), { capabilities: null, fault: { code: 'http_error', detail: '500' } });
  const garbage = createAi({ fetchImpl: async (url) => (String(url).endsWith('/api/tags') ? tags([GEMMA]) : resp('<<nope>>')) });
  assert.equal((await garbage.modelCapabilitiesDetailed(GEMMA)).fault.code, 'malformed');

  // Old contract unchanged: modelCapabilities still returns the bare list.
  assert.deepEqual(await ok.modelCapabilities(GEMMA), ['vision']);
});

test('a present-but-text-only model is unsuitable, not unknown, in vision routing', async () => {
  const a = createAi({
    fetchImpl: async (url) => (String(url).endsWith('/api/tags') ? tags([GEMMA]) : show(['chat'])),
  });
  const { decision, faults } = await a.routeTask('vision', { visionModel: GEMMA });
  assert.equal(decision.reason, 'no_vision_model_local');
  assert.equal(faults.capabilities[GEMMA].state, 'unsuitable');
  const unverified = createAi({
    fetchImpl: async (url) => (String(url).endsWith('/api/tags') ? tags([GEMMA]) : resp('{"family":"gemma"}')),
  });
  const again = await unverified.routeTask('vision', { visionModel: GEMMA });
  assert.equal(again.decision.reason, 'vision_unverified');
  assert.equal(again.faults.capabilities[GEMMA].state, 'unknown');
  assert.equal(again.faults.capabilities[GEMMA].fault.code, 'capability_unknown');
});

test('a timed-out probe keeps the strict refusal and never retries or falls back', async () => {
  let calls = 0;
  const a = createAi({
    fetchImpl: async (url) => { calls += 1; const e = new Error('timed out'); e.name = 'TimeoutError'; throw e; },
  });
  await assert.rejects(() => a.completeRouted({ system: 's', prompt: 'p' }), (err) => {
    assert.equal(err.reason, 'ollama_down');
    assert.equal(err.fault.code, 'timeout');
    return true;
  });
  assert.equal(calls, 1); // one bounded probe, no auto retry
});

test('a caller abort during routing rethrows and never probes the cloud', async () => {
  let cloudCalls = 0;
  const ctl = new AbortController();
  ctl.abort();
  const a = createAi({
    fetchImpl: async (url) => {
      if (String(url).includes('generativelanguage')) { cloudCalls += 1; return resp('[]'); }
      const e = new Error('aborted'); e.name = 'AbortError'; throw e;
    },
    cloudEnabled: true,
    geminiKey: 'k',
  });
  await assert.rejects(() => a.completeRouted({ system: 's', prompt: 'p', signal: ctl.signal }), (e) => e.name === 'AbortError');
  assert.equal(cloudCalls, 0);
});

test('the consent ask carries the typed local fault', async () => {
  const a = createAi({
    fetchImpl: async () => { throw new Error('fetch failed'); },
    cloudEnabled: true,
    geminiKey: 'k',
  });
  const out = await a.completeRouted({ system: 's', prompt: 'p' });
  assert.equal(out.needsCloudConsent, true);
  assert.equal(out.localError, 'ollama_down');
  assert.equal(out.localFault.code, 'unreachable');
});

test('consented cloud fallback still works after the local probe fails', async () => {
  const a = createAi({
    fetchImpl: async (url) => {
      if (String(url).includes('generativelanguage')) return resp(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'cloud' }] } }] }));
      throw new Error('fetch failed');
    },
    cloudEnabled: true,
    geminiKey: 'k',
    registryOverride: require('./fixtures/registry-fixtures').makeTestRegistry(),
  });
  const out = await a.completeRouted({ system: 's', prompt: 'p', cloudConsent: true });
  assert.equal(out, 'cloud');
});

test('provider status carries typed faults and the unsuitable state', () => {
  const down = ProviderStatus.buildProviderStatus({
    ollamaUp: false, installed: null,
    chat: { model: LLAMA, resolved: 'ollama_down' },
    vision: { model: GEMMA, resolved: 'ollama_down', visionVerified: null },
    ollamaFault: { code: 'timeout', detail: null },
  });
  assert.equal(down.ollama.fault.code, 'timeout');
  assert.equal(down.chat.fault, null);
  const missing = ProviderStatus.buildProviderStatus({
    ollamaUp: true, installed: [LLAMA],
    chat: { model: 'qwen2.5:7b', resolved: 'missing' },
    vision: { model: GEMMA, resolved: 'missing', visionVerified: null },
    caps: { [GEMMA]: ['chat'] },
    capsFaults: {},
  });
  assert.equal(missing.chat.fault.code, 'model_missing');
  assert.equal(missing.vision.capability, 'unsuitable');
  const unknown = ProviderStatus.buildProviderStatus({
    ollamaUp: true, installed: [GEMMA],
    chat: { model: LLAMA, resolved: 'fallback' },
    vision: { model: GEMMA, resolved: 'configured', visionVerified: null },
    caps: {},
    capsFaults: { [GEMMA]: { code: 'capability_unknown', detail: null } },
  });
  assert.equal(unknown.vision.capability, 'unknown');
  assert.equal(unknown.vision.fault.code, 'capability_unknown');
  // Every emitted fault code must be one the Settings view can display.
  for (const f of [down.ollama.fault, missing.chat.fault, missing.vision.fault, unknown.vision.fault]) {
    if (f) assert.ok(F.faultDisplay[f.code], f.code);
  }
});

test('model-selection passes probe faults through additively', async () => {
  const res = await MS.resolveModelSelection({
    ai: {
      listModelsDetailed: async () => ({ models: null, fault: { code: 'timeout', detail: null } }),
      modelCapabilities: async () => null,
    },
  });
  assert.equal(res.ollama, false);
  assert.equal(res.fault.code, 'timeout');
  const up = await MS.resolveModelSelection({
    ai: {
      listModelsDetailed: async () => ({ models: [{ name: GEMMA }], fault: null }),
      modelCapabilitiesDetailed: async () => ({ capabilities: null, fault: { code: 'capability_unknown', detail: null } }),
    },
  });
  assert.equal(up.fault, null);
  assert.equal(up.capsFaults[GEMMA].code, 'capability_unknown');
});

test('status() reports a typed fault and stays additive', async () => {
  const bad = createAi({ fetchImpl: async () => resp('<<not json>>') });
  const st = await bad.status();
  assert.equal(st.ollama, false);
  assert.equal(st.fault.code, 'malformed');
  const up = createAi({ fetchImpl: async () => tags([LLAMA]) });
  const good = await up.status();
  assert.equal(good.ollama, true);
  assert.equal(good.fault, null);
});

test('fault() drops any detail outside the strict whitelist (review finding)', () => {
  assert.deepEqual(F.fault({ code: 'timeout', detail: 'SECRET-TOKEN /private/path' }), { code: 'timeout', detail: null });
  assert.deepEqual(F.fault({ code: 'http_error', detail: '5033' }), { code: 'http_error', detail: null });
  assert.deepEqual(F.fault({ code: 'http_error', detail: '50' }), { code: 'http_error', detail: null });
  assert.deepEqual(F.fault({ code: 'http_error', detail: '503' }), { code: 'http_error', detail: '503' });
  assert.deepEqual(F.fault({ code: 'unreachable', detail: 'ECONNREFUSED and SECRET' }), { code: 'unreachable', detail: null });
  assert.deepEqual(F.fault({ code: 'unreachable', detail: 'econn_refused' }), { code: 'unreachable', detail: null });
  assert.deepEqual(F.fault({ code: 'unreachable', detail: 'ECONNREFUSED' }), { code: 'unreachable', detail: 'ECONNREFUSED' });
  assert.deepEqual(F.fault({ code: 'model_missing', detail: '/etc/passwd' }), { code: 'model_missing', detail: null });
  assert.deepEqual(F.fault({ code: 'malformed', detail: 'http://secret-host' }), { code: 'malformed', detail: null });
  assert.deepEqual(F.fault({ code: 'unreachable', detail: 'E'.repeat(500) }), { code: 'unreachable', detail: null });
  assert.equal(F.fault({ code: 'made_up', detail: 'x' }), null);
});

test('describeFault can never emit a non-whitelisted detail', () => {
  assert.equal(F.describeFault({ code: 'timeout', detail: 'SECRET-TOKEN http://10.0.0.1' }), 'Timed out');
  assert.equal(F.describeFault({ code: 'cancelled', detail: 'prompt text here' }), 'Cancelled');
  assert.equal(F.describeFault({ code: 'http_error', detail: '500 with SECRET' }), 'Server error');
  assert.equal(F.describeFault({ code: 'capability_unsuitable', detail: 'raw body SECRET' }), 'Not capable of this task');
});

test('provider-status normalizes upstream fault objects before display', () => {
  const dirty = ProviderStatus.buildProviderStatus({
    ollamaUp: false, installed: null,
    chat: { model: LLAMA, resolved: 'ollama_down' },
    vision: { model: GEMMA, resolved: 'ollama_down', visionVerified: null },
    ollamaFault: { code: 'timeout', detail: 'SECRET-TOKEN /private/path' },
    capsFaults: { [GEMMA]: { code: 'capability_unknown', detail: 'SECRET-BODY' } },
    caps: {},
  });
  assert.equal(dirty.ollama.fault.detail, null);
  assert.equal(dirty.vision.fault.code, 'capability_unknown');
  assert.equal(dirty.vision.fault.detail, null);
  assert.equal(JSON.stringify(dirty).includes('SECRET'), false);
  const bogus = ProviderStatus.buildProviderStatus({
    ollamaUp: false, installed: null,
    chat: { model: LLAMA, resolved: 'ollama_down' },
    vision: { model: GEMMA, resolved: 'ollama_down', visionVerified: null },
    ollamaFault: { code: 'made_up', detail: 'SECRET' },
  });
  assert.equal(bogus.ollama.fault, null); // unknown codes fail closed, no fault emitted
});


test('classifyFailure never turns a crafted status into detail (hardening, 24 Nov 2026)', () => {
  const crafted = { toString() { return 'SECRET-TOKEN http://10.0.0.1'; } };
  assert.deepEqual(F.classifyFailure({ status: crafted }), { code: 'http_error', detail: null });
  assert.equal(JSON.stringify(F.classifyFailure({ status: crafted })).includes('SECRET'), false);
  for (const bad of [NaN, Infinity, -Infinity, 0, 42, 99, 600, 999, 'abc', '5033', '50', '', '  503', '5O3', true, {}, []]) {
    const got = F.classifyFailure({ status: bad });
    assert.deepEqual(got, { code: 'http_error', detail: null }, `status ${String(bad)} must drop detail`);
  }
  // Real statuses still classify with their exact 3-digit detail.
  for (const good of [100, 404, 429, 500, 599, '503', '404']) {
    const got = F.classifyFailure({ status: good });
    assert.equal(got.code, 'http_error');
    assert.match(got.detail, /^\d{3}$/);
  }
});

test('classifyFailure carries only real errno names (strict allowlist, 24 Nov 2026)', () => {
  assert.deepEqual(F.classifyFailure({ err: { code: 'E_NOT_A_REAL_ERRNO' } }), { code: 'unreachable', detail: null });
  assert.deepEqual(F.classifyFailure({ err: { code: 'ECONNREFUSEDX' } }), { code: 'unreachable', detail: null });
  assert.deepEqual(F.classifyFailure({ err: { code: 'EHOSTUNREACH' } }), { code: 'unreachable', detail: 'EHOSTUNREACH' });
  assert.deepEqual(F.classifyFailure({ err: { code: 'ETIMEDOUT' } }), { code: 'unreachable', detail: 'ETIMEDOUT' });
  // Second layer: fault() refuses an unknown E-shaped token even when a
  // future caller hands it in directly, bypassing classifyFailure.
  assert.deepEqual(F.fault({ code: 'unreachable', detail: 'E_FABRICATED' }), { code: 'unreachable', detail: null });
  assert.deepEqual(F.fault({ code: 'unreachable', detail: 'ECONNRESET' }), { code: 'unreachable', detail: 'ECONNRESET' });
  // The full pipeline is safe even when the caller skips fault(): the raw
  // classifyFailure output never carries fabricated text.
  const raw = F.classifyFailure({ err: { code: 'E_URL http://x SECRET' } });
  assert.equal(raw.detail, null);
});

// REGRESSION (26 Nov 2026): the strict errno allowlist omitted the two DNS
// failure codes Node itself reports for an unresolvable or temporarily
// unresolvable host (getaddrinfo). They are real Node system-error names,
// which is exactly what the allowlist says it carries, so an unreachable
// host named by hostname showed "Not reachable" with no detail while the
// same failure by IP showed "Not reachable (ECONNREFUSED)".
test('classifyFailure carries the real DNS failure codes ENOTFOUND and EAI_AGAIN', () => {
  assert.deepEqual(F.classifyFailure({ err: { code: 'ENOTFOUND' } }), { code: 'unreachable', detail: 'ENOTFOUND' });
  assert.deepEqual(F.classifyFailure({ err: { code: 'EAI_AGAIN' } }), { code: 'unreachable', detail: 'EAI_AGAIN' });
  // Second layer: the direct fault() path must carry them too.
  assert.deepEqual(F.fault({ code: 'unreachable', detail: 'ENOTFOUND' }), { code: 'unreachable', detail: 'ENOTFOUND' });
  // And fabricated DNS-lookalike tokens stay refused.
  assert.deepEqual(F.fault({ code: 'unreachable', detail: 'ENOTFOUNDX' }), { code: 'unreachable', detail: null });
});
