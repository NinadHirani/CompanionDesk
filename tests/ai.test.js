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

test('complete falls back to the cloud key only when local fails', async () => {
  const ai = createAi({
    geminiKey: 'test-key',
    fetchImpl: mockFetch([
      ['/api/chat', () => ({ ok: false, status: 500, text: async () => '' })],
      ['generativelanguage.googleapis.com', () => ({
        ok: true,
        json: async () => ({ candidates: [{ content: { parts: [{ text: 'cloud answer' }] } }] }),
      })],
    ]),
  });
  assert.equal(await ai.complete({ prompt: 'q' }), 'cloud answer');
});

test('complete throws when local is down and no cloud key exists', async () => {
  const ai = createAi({
    fetchImpl: mockFetch([['/api/chat', () => ({ ok: false, status: 500, text: async () => '' })]]),
  });
  await assert.rejects(() => ai.complete({ prompt: 'q' }), /ollama_http_500/);
});
