'use strict';

// M1 slice 2: per-ask routing integration. Every test here pins one rule the
// shipped privacy posture depends on: the router decides, probes are live and
// bounded, the cloud is never touched without consent FOR THAT request, and
// vision never leaves the device.

const test = require('node:test');
const assert = require('node:assert');
const { createAi } = require('../src/ai');

// A tiny routing mock: each route is [match, handler(opts)]; match is a URL
// substring or a function(url, opts). Every call is recorded for assertions
// about what was (and was never) sent.
function mockFetch(routes) {
  const calls = [];
  const fetch = async (url, opts) => {
    calls.push({ url: String(url), opts: opts || {} });
    for (const [match, handler] of routes) {
      const hit = typeof match === 'string' ? String(url).includes(match) : match(url, opts);
      if (hit) return handler(opts || {});
    }
    throw new Error('unrouted: ' + url);
  };
  fetch.calls = calls;
  return fetch;
}

const OLLAMA_UP = ['/api/tags', () => ({
  ok: true,
  json: async () => ({ models: [{ name: 'llama3.2:latest' }] }),
})];

const CLOUD_OK = ['generativelanguage.googleapis.com', (opts) => {
  if (String(opts.url || '').endsWith('/models')) return { ok: true, json: async () => ({ models: [] }) };
  return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'cloud answer' }] } }] }) };
}];

const { makeTestRegistry } = require('./fixtures/registry-fixtures');

function baseAi(fetch, extra = {}) {
  return createAi({
    fetchImpl: fetch,
    geminiKey: () => 'k-test',
    cloudEnabled: true,
    // the retired-id fixture: pre-retirement transport contract coverage.
    // The regression test below uses the REAL registry.
    registryOverride: makeTestRegistry(),
    ...extra,
  });
}

test('a failed health probe with the cloud armed offers consent and sends nothing', async () => {
  const fetch = mockFetch([['/api/tags', () => ({ ok: false, status: 500 })]]);
  const ai = baseAi(fetch);
  const res = await ai.completeRouted({ system: 's', prompt: 'p' });
  assert.equal(res.needsCloudConsent, true);
  assert.equal(res.localError, 'ollama_down');
  assert.equal(fetch.calls.filter((c) => c.url.includes('googleapis')).length, 0);
});

test('legacy complete is local-only: even with a key and cloud enabled it never calls the cloud', async () => {
  const fetch = mockFetch([
    OLLAMA_UP,
    ['/api/chat', () => ({ ok: false, status: 500 })],
    CLOUD_OK,
  ]);
  const ai = baseAi(fetch);
  await assert.rejects(() => ai.complete({ system: 's', prompt: 'p' }), /ollama_http_500/);
  assert.equal(fetch.calls.filter((c) => c.url.includes('googleapis')).length, 0);
});

test('the consent disclosure passes through: a minimized payload is disclosed as minimized', async () => {
  const fetch = mockFetch([OLLAMA_UP, ['/api/chat', () => ({ ok: false, status: 500 })]]);
  const ai = baseAi(fetch);
  const res = await ai.completeRouted({
    system: 's', prompt: 'p',
    cloudDisclosure: {
      prompt: 'minimized',
      receives: ['your current question', 'the course and due-date context pack'],
      never_sent: ['conversation history', 'your calendar entries'],
    },
  });
  assert.equal(res.needsCloudConsent, true);
  assert.equal(res.cloud.prompt, 'minimized');
  assert.deepEqual(res.cloud.receives, ['your current question', 'the course and due-date context pack']);
  assert.ok(res.cloud.never_sent.includes('your calendar entries'));
  assert.ok(!res.cloud.receives.join(' ').includes('calendar'), 'minimized mode must not claim calendar data goes out');
});

test('the consent disclosure passes through: full personal context is disclosed as such', async () => {
  const fetch = mockFetch([OLLAMA_UP, ['/api/chat', () => ({ ok: false, status: 500 })]]);
  const ai = baseAi(fetch);
  const res = await ai.completeRouted({
    system: 's', prompt: 'p',
    cloudDisclosure: {
      prompt: 'full',
      receives: ['your current question', 'your next 7 days of calendar entries', 'your name and the selected saved memories', 'your activity patterns'],
    },
  });
  assert.equal(res.cloud.prompt, 'full');
  const joined = res.cloud.receives.join(' ');
  assert.match(joined, /calendar entries/);
  assert.match(joined, /saved memories/);
  assert.match(joined, /activity patterns/);
  assert.deepEqual(res.cloud.never_sent, ['conversation history', 'screenshots or images']);
});

test('without a caller disclosure the consent result stays conservative, never understated', async () => {
  const fetch = mockFetch([OLLAMA_UP, ['/api/chat', () => ({ ok: false, status: 500 })]]);
  const ai = baseAi(fetch);
  const res = await ai.completeRouted({ system: 's', prompt: 'p' });
  assert.equal(res.cloud.prompt, 'full');
  assert.match(res.cloud.receives[0], /exactly as passed/);
});

test('a failed health probe with the cloud DISABLED refuses with the local reason', async () => {
  const fetch = mockFetch([['/api/tags', () => ({ ok: false, status: 500 })]]);
  const ai = createAi({ fetchImpl: fetch, geminiKey: () => 'k', cloudEnabled: false });
  await assert.rejects(
    () => ai.completeRouted({ system: 's', prompt: 'p' }),
    (err) => err.reason === 'ollama_down'
  );
  assert.equal(fetch.calls.filter((c) => c.url.includes('googleapis')).length, 0);
});

test('a hanging health probe is bounded by the probe timeout, not forever', async () => {
  const fetch = mockFetch([['/api/tags', (opts) => new Promise((_, reject) => {
    const stall = setTimeout(() => reject(new Error('test stall')), 5000); // keeps the loop alive
    if (opts.signal && opts.signal.aborted) { clearTimeout(stall); reject(new Error('timed out')); return; }
    if (opts.signal) opts.signal.addEventListener('abort', () => { clearTimeout(stall); reject(new Error('timed out')); });
  })]]);
  const ai = createAi({ fetchImpl: fetch, probeTimeoutMs: 20 });
  const t0 = Date.now();
  await assert.rejects(() => ai.completeRouted({ system: 's', prompt: 'p' }), (err) => err.reason === 'ollama_down');
  assert.ok(Date.now() - t0 < 2000, 'probe resolved within its bound');
});

test('a saved key with cloud disabled never sends anything anywhere', async () => {
  // Local model present and healthy: local answers, no cloud probe at all.
  const fetch = mockFetch([
    OLLAMA_UP,
    ['/api/chat', () => ({ ok: true, text: async () => JSON.stringify({ message: { content: 'local' } }) })],
  ]);
  const ai = createAi({ fetchImpl: fetch, geminiKey: () => 'k-test', cloudEnabled: false });
  const answer = await ai.completeRouted({ system: 's', prompt: 'p' });
  assert.equal(answer, 'local');
  assert.equal(fetch.calls.filter((c) => c.url.includes('googleapis')).length, 0);
});

test('local failure with cloud armed but unconsented offers confirmation and sends nothing', async () => {
  const fetch = mockFetch([
    OLLAMA_UP,
    ['/api/chat', () => ({ ok: false, status: 404, text: async () => '' })], // installed model vanished
  ]);
  const ai = baseAi(fetch);
  const res = await ai.completeRouted({ system: 's', prompt: 'p', history: [{ role: 'user', content: 'earlier turn' }] });
  assert.equal(res.needsCloudConsent, true);
  assert.equal(res.cloud.provider, 'gemini');
  assert.ok(!res.cloud.receives.join(' ').includes('conversation history'), 'history is never a receive category');
  assert.ok(res.cloud.never_sent.includes('conversation history'));
  assert.ok(res.cloud.never_sent.includes('screenshots or images'));
  assert.equal(res.localError, 'ollama_http_404');
  // Not one byte went to Google, not even a health check.
  assert.equal(fetch.calls.filter((c) => c.url.includes('googleapis')).length, 0);
});

test('after a decline, a retry without consent sends nothing to the cloud', async () => {
  const fetch = mockFetch([
    OLLAMA_UP,
    ['/api/chat', () => ({ ok: false, status: 500, text: async () => '' })],
  ]);
  const ai = baseAi(fetch);
  const once = await ai.completeRouted({ system: 's', prompt: 'p' });
  assert.equal(once.needsCloudConsent, true);
  const twice = await ai.completeRouted({ system: 's', prompt: 'p' });
  assert.equal(twice.needsCloudConsent, true);
  assert.equal(fetch.calls.filter((c) => c.url.includes('googleapis')).length, 0);
});

test('explicit consent for THIS request routes the cloud, with history stripped', async () => {
  const fetch = mockFetch([
    OLLAMA_UP,
    ['/api/chat', () => ({ ok: false, status: 500, text: async () => '' })],
    CLOUD_OK,
  ]);
  const ai = baseAi(fetch);
  const answer = await ai.completeRouted({
    system: 'sys text', prompt: 'the question',
    history: [{ role: 'user', content: 'never sent' }],
    cloudArgs: { system: 'min sys', prompt: 'min prompt' },
    cloudConsent: true,
  });
  assert.equal(answer, 'cloud answer');
  const cloudCalls = fetch.calls.filter((c) => c.url.includes('googleapis'));
  assert.equal(cloudCalls.length, 2); // health probe, then the generate call
  const body = JSON.parse(cloudCalls[1].opts.body);
  const text = body.contents[0].parts[0].text;
  assert.ok(text.includes('min prompt'), 'cloudArgs replace the personal prompt');
  assert.ok(!text.includes('the question'), 'the personal prompt is not sent');
  assert.ok(!text.includes('never sent'), 'conversation history never reaches the cloud');
  assert.ok(!text.includes('sys text'), 'the personal system text is not sent');
});

test('an unhealthy cloud provider refuses even with consent', async () => {
  const fetch = mockFetch([
    OLLAMA_UP,
    ['/api/chat', () => ({ ok: false, status: 500, text: async () => '' })],
    ['/v1beta/models', () => ({ ok: false, status: 403 })],
  ]);
  const ai = baseAi(fetch);
  await assert.rejects(
    () => ai.completeRouted({ system: 's', prompt: 'p', cloudConsent: true }),
    (err) => err.reason === 'cloud_provider_down'
  );
});

test('vision is local-only: every gate open and consented still routes local', async () => {
  const fetch = mockFetch([
    ['/api/tags', () => ({ ok: true, json: async () => ({ models: [{ name: 'gemma3:4b' }] }) })],
    ['/api/show', () => ({ ok: true, json: async () => ({ capabilities: ['vision'] }) })],
    ['/api/chat', () => ({ ok: true, text: async () => JSON.stringify({ message: { content: 'seen locally' } }) })],
    CLOUD_OK,
  ]);
  const ai = baseAi(fetch);
  const answer = await ai.completeRouted({
    system: 's', prompt: 'what is on screen',
    task: 'vision', visionModel: 'gemma3:4b', cloudConsent: true,
    images: ['aGVsbG8='],
  });
  assert.equal(answer, 'seen locally');
  assert.equal(fetch.calls.filter((c) => c.url.includes('googleapis')).length, 0);
});

test('vision without a vision-capable local model refuses instead of falling back', async () => {
  const fetch = mockFetch([
    ['/api/tags', () => ({ ok: true, json: async () => ({ models: [{ name: 'llama3.2:latest' }] }) })],
    ['/api/show', () => ({ ok: true, json: async () => ({ capabilities: ['chat'] }) })],
    CLOUD_OK,
  ]);
  const ai = baseAi(fetch);
  await assert.rejects(
    () => ai.completeRouted({ system: 's', prompt: 'p', task: 'vision', visionModel: 'gemma3:4b', cloudConsent: true }),
    (err) => err.reason === 'no_vision_model_local'
  );
  assert.equal(fetch.calls.filter((c) => c.url.includes('googleapis')).length, 0);
});

test('a cancel aborts the local call and the cloud is never tried', async () => {
  const controller = new AbortController();
  const fetch = mockFetch([
    OLLAMA_UP,
    ['/api/chat', (opts) => new Promise((_, reject) => {
      if (opts.signal.aborted) { reject(new Error('The operation was aborted')); return; }
      opts.signal.addEventListener('abort', () => reject(new Error('The operation was aborted')));
      // pending until aborted
    })],
    CLOUD_OK,
  ]);
  const ai = baseAi(fetch);
  const pending = ai.completeRouted({ system: 's', prompt: 'p', signal: controller.signal });
  controller.abort();
  await assert.rejects(() => pending, (err) => err.name === 'AbortError' || /abort/i.test(String(err.message)));
  assert.equal(fetch.calls.filter((c) => c.url.includes('googleapis')).length, 0);
});

test('a cancel mid-stream stops the reader where it is', async () => {
  const controller = new AbortController();
  const seen = [];
  const fetch = mockFetch([
    OLLAMA_UP,
    ['/api/chat', (opts) => ({
      ok: true,
      body: {
        getReader() {
          return {
            async read() {
              if (controller.signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
              if (seen.length === 0) {
                seen.push(1);
                // arm the abort one tick after the first chunk is delivered
                Promise.resolve().then(() => controller.abort());
                return { done: false, value: new TextEncoder().encode(JSON.stringify({ message: { content: 'partial' } }) + '\n') };
              }
              return { done: true, value: undefined };
            },
          };
        },
      },
    })],
    CLOUD_OK,
  ]);
  const ai = baseAi(fetch);
  const tokens = [];
  await assert.rejects(
    () => ai.completeRouted({ system: 's', prompt: 'p', signal: controller.signal, onToken: (t) => tokens.push(t) }),
    (err) => err.name === 'AbortError'
  );
  assert.deepEqual(tokens, ['partial']);
  assert.equal(fetch.calls.filter((c) => c.url.includes('googleapis')).length, 0);
});

test('a bounded chat timeout aborts a hung local model without cloud fallback', async () => {
  const fetch = mockFetch([
    OLLAMA_UP,
    ['/api/chat', (opts) => new Promise((_, reject) => {
      const stall = setTimeout(() => reject(new Error('test stall')), 5000); // keeps the loop alive
      if (opts.signal && opts.signal.aborted) { clearTimeout(stall); reject(new Error('timed out')); return; }
      if (opts.signal) opts.signal.addEventListener('abort', () => { clearTimeout(stall); reject(new Error('timed out')); });
    })],
    CLOUD_OK,
  ]);
  const ai = createAi({ fetchImpl: fetch, geminiKey: () => 'k', cloudEnabled: false, chatTimeoutMs: 30 });
  await assert.rejects(() => ai.completeRouted({ system: 's', prompt: 'p' }), /timed out/);
  assert.equal(fetch.calls.filter((c) => c.url.includes('googleapis')).length, 0);
});

test('routeTask exposes the router decision for the screen path, local-only enforced', async () => {
  const fetch = mockFetch([
    ['/api/tags', () => ({ ok: true, json: async () => ({ models: [{ name: 'gemma3:4b' }] }) })],
    ['/api/show', () => ({ ok: true, json: async () => ({ capabilities: ['vision'] }) })],
    CLOUD_OK,
  ]);
  const ai = baseAi(fetch);
  const { decision } = await ai.routeTask('vision', { privacyMode: 'local_only', visionModel: 'gemma3:4b' });
  assert.equal(decision.ok, true);
  assert.equal(decision.provider, 'ollama');
  assert.equal(decision.model, 'gemma3:4b');
  assert.equal(fetch.calls.filter((c) => c.url.includes('googleapis')).length, 0);
});

test('REGRESSION: a retired cloud model id can never be the working provider (real registry)', async () => {
  const fetch = mockFetch([
    OLLAMA_UP,
    ['/api/chat', () => ({ ok: false, status: 500, text: async () => '' })],
    // NO gemini health-probe route on purpose: a retired model must be
    // refused before any cloud probe, let alone any cloud call.
  ]);
  const ai = createAi({ fetchImpl: fetch, geminiKey: () => 'k-test', cloudEnabled: true });
  await assert.rejects(
    () => ai.completeRouted({ system: 's', prompt: 'p', cloudConsent: true }),
    (err) => err.reason === 'cloud_model_retired'
  );
  assert.equal(fetch.calls.filter((c) => c.url.includes('generativelanguage')).length, 0,
    'a retired model must not trigger even a cloud health probe');
});

test('retirement never touches the local route and preserves the user configuration', async () => {
  const fetch = mockFetch([
    OLLAMA_UP,
    ['/api/chat', () => ({ ok: true, text: async () => JSON.stringify({ message: { content: 'local answer' } }) })],
  ]);
  const ai = createAi({ fetchImpl: fetch, geminiKey: () => 'k-test', cloudEnabled: true });
  const answer = await ai.completeRouted({ system: 's', prompt: 'p' });
  assert.equal(answer, 'local answer');
  assert.equal(fetch.calls.filter((c) => c.url.includes('generativelanguage')).length, 0);
});

test('REGRESSION: a cancel during the cloud health probe is a cancellation, not a provider-down refusal (completeRouted)', async () => {
  const controller = new AbortController();
  const fetch = mockFetch([
    // Ollama answers 500: the local provider is down, so the router wants
    // the cloud and the health probe is the next step. The caller cancels
    // while that probe runs.
    ['/api/tags', () => ({ ok: false, status: 500 })],
    ['generativelanguage.googleapis.com', (opts) => {
      if (opts.signal && opts.signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
      return { ok: true, json: async () => ({ models: [] }) };
    }],
  ]);
  const ai = baseAi(fetch);
  const pending = ai.completeRouted({ system: 's', prompt: 'p', cloudConsent: true, signal: controller.signal });
  controller.abort();
  await assert.rejects(
    () => pending,
    (err) => err.name === 'AbortError' || err.reason === 'cancelled'
  );
  // A cancel must never turn into a cloud call.
  assert.equal(fetch.calls.filter((c) => c.url.includes(':generateContent')).length, 0);
});

test('REGRESSION: a cancel during reconsideration after a local failure is a cancellation, not a provider-down refusal', async () => {
  const controller = new AbortController();
  const fetch = mockFetch([
    OLLAMA_UP,
    // The local chat fails for a real reason, THEN the caller cancels while
    // reconsideration probes cloud health: the abort lands on a macrotask,
    // after the failure has propagated past the caller-abort guard.
    ['/api/chat', () => {
      setTimeout(() => controller.abort(), 0);
      return { ok: false, status: 500, text: async () => '' };
    }],
    // The cloud health probe hangs until the cancel arrives, then rejects
    // the way a real fetch does.
    ['generativelanguage.googleapis.com', (opts) => new Promise((_, reject) => {
      const onAbort = () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); };
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort);
    })],
  ]);
  const ai = baseAi(fetch);
  await assert.rejects(
    () => ai.completeRouted({ system: 's', prompt: 'p', cloudConsent: true, signal: controller.signal }),
    (err) => err.name === 'AbortError' || err.reason === 'cancelled'
  );
  assert.equal(fetch.calls.filter((c) => c.url.includes(':generateContent')).length, 0);
});
