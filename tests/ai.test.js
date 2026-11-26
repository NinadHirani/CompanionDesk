'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createAi } = require('../src/ai');

// A tiny routing mock: each route is [match, handler(opts)]; match is a URL
// substring or a function(url, opts). No network is touched.
function mockFetch(routes) {
  return async (url, opts) => {
    for (const [match, handler] of routes) {
      const hit = typeof match === 'string' ? url.includes(match) : match(url, opts);
      if (hit) return handler(opts || {});
    }
    throw new Error('unrouted: ' + url);
  };
}

test('status detects a running Ollama and a loaded model', async () => {
  const ai = createAi({ fetchImpl: mockFetch([['/api/tags', () => ({ ok: true, json: async () => ({ models: [{ name: 'llama3.2:latest' }] }) })]]) });
  const s = await ai.status();
  assert.equal(s.ollama, true);
  assert.equal(s.modelLoaded, true);
  assert.equal(s.cloud, false);
});

test('status reports Ollama down without throwing', async () => {
  const ai = createAi({ fetchImpl: mockFetch([]) });
  const s = await ai.status();
  assert.equal(s.ollama, false);
});

test('chat assembles a non-streaming NDJSON body and reports tokens', async () => {
  const ndjson = [
    JSON.stringify({ message: { content: 'Hello' } }),
    JSON.stringify({ message: { content: ' world' } }),
    JSON.stringify({ done: true }),
  ].join('\n');
  let sent;
  const ai = createAi({
    fetchImpl: mockFetch([['/api/chat', (opts) => { sent = JSON.parse(opts.body); return { ok: true, text: async () => ndjson, body: null }; }]]),
  });
  const tokens = [];
  const full = await ai.chat({ system: 'sys', prompt: 'hi', onToken: (t) => tokens.push(t) });
  assert.equal(full, 'Hello world');
  assert.deepEqual(tokens, ['Hello', ' world']);
  assert.equal(sent.model, 'llama3.2:latest');
  assert.equal(sent.messages[0].role, 'system');
  assert.equal(sent.messages[1].content, 'hi');
});

function cloudRoutes() {
  return [
    ['/api/chat', () => ({ ok: false, status: 500, text: async () => '' })],
    ['generativelanguage.googleapis.com', () => ({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'cloud answer' }] } }] }),
    })],
  ];
}

test('a streamed answer keeps its final unterminated line', async () => {
  // The stream ends after a final NDJSON line that carries no trailing
  // newline (a truncated connection, a proxy flush). An earlier token must
  // not make the answer lose that last line.
  const lines = [
    JSON.stringify({ message: { content: 'Hello' } }) + '\n',
    JSON.stringify({ message: { content: ' world' } }),
  ];
  const body = {
    getReader() {
      let i = 0;
      return { read: async () => (i < lines.length ? { done: false, value: new TextEncoder().encode(lines[i++]) } : { done: true, value: undefined }) };
    },
  };
  let sent;
  const ai = createAi({
    fetchImpl: mockFetch([['/api/chat', (opts) => { sent = JSON.parse(opts.body); return { ok: true, body }; }]]),
  });
  const tokens = [];
  const full = await ai.chat({ system: 'sys', prompt: 'hi', onToken: (t) => tokens.push(t) });
  assert.equal(full, 'Hello world');
  assert.deepEqual(tokens, ['Hello', ' world']);
  assert.equal(sent.model, 'llama3.2:latest');
});

test('complete is local-only: even with a key and cloud enabled it never calls the cloud', async () => {
  let cloudCalled = 0;
  const routes = cloudRoutes();
  const counting = async (url, opts) => {
    if (String(url).includes('generativelanguage')) cloudCalled += 1;
    return routes.find(([m]) => String(url).includes(m))[1](opts || {});
  };
  const ai = createAi({ geminiKey: 'test-key', cloudEnabled: true, fetchImpl: counting });
  await assert.rejects(() => ai.complete({ prompt: 'q' }));
  assert.equal(cloudCalled, 0); // the legacy path carries no consent, so it never transmits
});

test('a key alone routes nothing: cloudEnabled defaults false', async () => {
  const routes = cloudRoutes();
  let cloudCalled = 0;
  const counting = async (url, opts) => {
    if (String(url).includes('generativelanguage.googleapis.com')) cloudCalled += 1;
    return routes.find(([m]) => String(url).includes(m))[1](opts || {});
  };
  const ai = createAi({
    geminiKey: 'test-key',
    fetchImpl: counting,
  });
  await assert.rejects(() => ai.complete({ prompt: 'q' }), /ollama_http_500/);
  assert.equal(cloudCalled, 0); // the local error surfaced; the cloud was never contacted
});

test('status.cloud reflects the armed state: enabled AND keyed', async () => {
  const routes = [['/api/tags', () => ({ ok: true, json: async () => ({ models: [{ name: 'llama3.2:latest' }] }) })]];
  const keyedOnly = createAi({ geminiKey: 'k', fetchImpl: mockFetch(routes) });
  assert.equal((await keyedOnly.status()).cloud, false);
  const armed = createAi({ geminiKey: 'k', cloudEnabled: true, fetchImpl: mockFetch(routes) });
  assert.equal((await armed.status()).cloud, true);
  const enabledNoKey = createAi({ cloudEnabled: true, fetchImpl: mockFetch(routes) });
  assert.equal((await enabledNoKey.status()).cloud, false);
});

test('complete throws when local is down and no cloud key exists', async () => {
  const ai = createAi({
    fetchImpl: mockFetch([['/api/chat', () => ({ ok: false, status: 500, text: async () => '' })]]),
  });
  await assert.rejects(() => ai.complete({ prompt: 'q' }), /ollama_http_500/);
});
