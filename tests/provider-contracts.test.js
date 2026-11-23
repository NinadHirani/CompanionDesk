'use strict';

// M1 slice 5: provider contract tests against scripted fake servers. No
// sockets, no real Ollama or Gemini, no network: tests/fixtures/
// fake-servers.js IS the server side of each HTTP contract, replayed
// through createAi's injectable fetchImpl. This file pins the contracts and
// the privacy guarantees: bounded timeouts, no retries, no cloud without
// explicit per-request consent, vision never cloud, and no key material in
// any URL or error.

const test = require('node:test');
const assert = require('node:assert');
const { createAi } = require('../src/ai');
const F = require('./fixtures/fake-servers');

const GEM = 'https://generativelanguage.googleapis.com/v1beta/models';
const KEY = 'sk-TEST-KEY-DO-NOT-LEAK-0f3a';

function aiWith(handler, over = {}) {
  const { fetchImpl, calls } = F.makeFetch(handler);
  const ai = createAi({
    fetchImpl, geminiKey: KEY, cloudEnabled: true,
    probeTimeoutMs: 20, chatTimeoutMs: 20, cloudTimeoutMs: 20,
    ...over,
  });
  return { ai, calls };
}

const gemCalls = (calls) => calls.filter((c) => c.url.startsWith('https://generativelanguage'));
const localCalls = (calls) => calls.filter((c) => !c.url.startsWith('https://generativelanguage'));
// A canary the tests would see if the cloud was ever contacted.
const cloudReply = () => F.jsonOk({ candidates: [{ content: { parts: [{ text: 'CLOUD-LEAK-CANARY' }] } }] });

// --- the Ollama chat contract -------------------------------------------

test('chatOllama sends the exact Ollama request contract', async () => {
  let body;
  const { ai, calls } = aiWith((call) => { body = JSON.parse(call.body); return F.ndjson(['Hi']); });
  const out = await ai.chat({
    system: 'sys', prompt: 'hello', model: 'llama3.2:latest', temperature: 0.4,
    history: [
      { role: 'user', content: 'earlier q' },
      { role: 'assistant', content: 'earlier a' },
      { role: '', content: '' }, // an empty turn is dropped
    ],
    images: ['QUJD'],
  });
  assert.equal(out, 'Hi');
  const call = calls[0];
  assert.equal(call.method, 'POST');
  assert.equal(call.url, 'http://127.0.0.1:11434/api/chat');
  assert.equal(call.headers['content-type'], 'application/json');
  assert.deepEqual(body, {
    model: 'llama3.2:latest',
    stream: true,
    options: { temperature: 0.4 },
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'earlier q' },
      { role: 'assistant', content: 'earlier a' },
      { role: 'user', content: 'hello', images: ['QUJD'] },
    ],
  });
});

test('streaming NDJSON reaches onToken per piece, buffers split lines, skips garbage', async () => {
  const { ai } = aiWith(() => F.rawNdjson([
    '{"mess', 'age":{"content":"Hel',
    'lo"}}\n',
    '<<not json>>\n', // a malformed line: skipped, the stream continues
    '{"message":{"content":"!"}}\n',
  ]));
  const seen = [];
  const out = await ai.chat({ prompt: 'x', onToken: (t) => seen.push(t) });
  assert.equal(out, 'Hello!');
  assert.deepEqual(seen, ['Hello', '!']);
});

test('a non-2xx chat reply is one named error and exactly one attempt', async () => {
  const { ai, calls } = aiWith((call) => (call.url.endsWith('/api/chat') ? F.jsonErr(503) : F.jsonOk({ models: [{ name: 'llama3.2:latest' }] })));
  await assert.rejects(() => ai.chat({ prompt: 'x' }), /ollama_http_503/);
  assert.equal(localCalls(calls).length, 1); // no retry anywhere
});

test('malformed /api/tags reads as "not answering", never a throw', async () => {
  const { ai } = aiWith(() => new Response('<<not json>>', { status: 200 }));
  assert.equal(await ai.listModels(), null);
  const st = await ai.status();
  assert.equal(st.ollama, false);
  assert.deepEqual(await ai.probeLocal(), { healthy: false, models: null, fault: { code: 'malformed', detail: null } });
});

test('a timed-out chat is one aborted call and never retried', async () => {
  const { ai, calls } = aiWith((call) => F.hangOnSignal(call), { chatTimeoutMs: 20 });
  await assert.rejects(() => ai.chat({ prompt: 'x' }), (e) => e.name === 'TimeoutError');
  assert.equal(calls.length, 1);
});

test('an abort mid-stream keeps the tokens already seen and never touches the cloud', async () => {
  const ac = new AbortController();
  const { ai, calls } = aiWith((call) => {
    if (call.url.endsWith('/api/tags')) return F.jsonOk({ models: [{ name: 'llama3.2:latest' }] });
    if (call.url.endsWith('/api/chat')) return F.ndjsonHang(ac.signal, 'partial ');
    return cloudReply();
  }, { probeTimeoutMs: 50 });
  const seen = [];
  await assert.rejects(
    () => ai.completeRouted({
      task: 'chat', prompt: 'x', cloudEnabled: true, cloudConsent: true,
      onToken: (t) => { seen.push(t); if (seen.length === 1) ac.abort(); },
    }),
    (e) => e.name === 'AbortError',
  );
  assert.deepEqual(seen, ['partial ']);
  assert.equal(gemCalls(calls).length, 0); // an abort never escalates to the cloud
});

// --- the /api/show capability contract ----------------------------------

test('/api/show: the capability contract; every unreadable shape stays null', async () => {
  let body;
  const { ai, calls } = aiWith((call) => {
    if (call.url.endsWith('/api/show')) { body = JSON.parse(call.body); return F.jsonOk({ capabilities: ['chat', 'vision'] }); }
    return F.jsonOk({ models: [] });
  });
  assert.deepEqual(await ai.modelCapabilities('gemma3:4b'), ['chat', 'vision']);
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(body, { model: 'gemma3:4b' });

  for (const bad of [F.jsonErr(404), new Response('<<garbage>>', { status: 200 }), F.jsonOk({})]) {
    const { ai: one } = aiWith((call) => (call.url.endsWith('/api/show') ? bad : F.jsonOk({ models: [] })));
    assert.equal(await one.modelCapabilities('gemma3:4b'), null);
  }
});

// --- the Gemini contract and the consent gates ---------------------------

// Cloud handler that answers the health probe and the chat call correctly.
function cloudUp() {
  return (call) => {
    if (call.url.endsWith('/api/tags')) return F.jsonOk({ models: [{ name: 'llama3.2:latest' }] });
    if (call.url.endsWith('/api/chat')) return F.jsonErr(500); // local fails, cloud reconsidered
    if (call.url === GEM) return F.jsonOk({ models: [] }); // health probe
    if (call.url.endsWith(':generateContent')) return cloudReply();
    return cloudReply();
  };
}

test('the cloud fallback receives one part and never history or images', async () => {
  const { ai, calls } = aiWith(cloudUp(), { probeTimeoutMs: 100, chatTimeoutMs: 100, cloudTimeoutMs: 100 });
  const out = await ai.completeRouted({
    task: 'chat', privacyMode: 'standard', cloudEnabled: true, cloudConsent: true,
    prompt: 'the prompt', system: 'the system',
    history: [{ role: 'user', content: 'SECRET-HISTORY-CANARY' }],
    images: ['QUJD'],
  });
  assert.equal(out, 'CLOUD-LEAK-CANARY');
  const gem = gemCalls(calls);
  assert.equal(gem.length, 2); // one bounded health probe, then the chat call
  const chat = gem.find((c) => c.method === 'POST');
  assert.equal(chat.url, `${GEM}/gemini-2.0-flash:generateContent`);
  assert.ok(gem.every((c) => !c.url.includes(KEY))); // the key never travels in a URL
  assert.equal(chat.headers['x-goog-api-key'], KEY); // it travels in a header
  const sent = JSON.parse(chat.body);
  assert.deepEqual(sent, { contents: [{ parts: [{ text: 'the system\n\nthe prompt' }] }] });
  assert.ok(!JSON.stringify(sent).includes('SECRET-HISTORY-CANARY'));
  assert.ok(!JSON.stringify(sent).includes('images'));
});

test('a malformed cloud payload reads as a named bad response, never a raw parser error', async () => {
  const handler = (call) => {
    if (call.url.endsWith('/api/tags')) return F.jsonOk({ models: [{ name: 'llama3.2:latest' }] });
    if (call.url.endsWith('/api/chat')) return F.jsonErr(500);
    if (call.url === GEM) return F.jsonOk({ models: [] });
    return new Response('<<garbage>>', { status: 200 });
  };
  const { ai } = aiWith(handler, { probeTimeoutMs: 50 });
  await assert.rejects(
    () => ai.completeRouted({ task: 'chat', prompt: 'x', cloudEnabled: true, cloudConsent: true }),
    /gemini_bad_response/,
  );
});

test('an empty cloud reply is a named error, never a silent success', async () => {
  const handler = (call) => {
    if (call.url.endsWith('/api/tags')) return F.jsonOk({ models: [{ name: 'llama3.2:latest' }] });
    if (call.url.endsWith('/api/chat')) return F.jsonErr(500);
    if (call.url === GEM) return F.jsonOk({ models: [] });
    return F.jsonOk({ candidates: [{ content: { parts: [{}] } }] }); // a part with no text
  };
  const { ai } = aiWith(handler, { probeTimeoutMs: 50 });
  await assert.rejects(
    () => ai.completeRouted({ task: 'chat', prompt: 'x', cloudEnabled: true, cloudConsent: true }),
    /gemini_empty_response/,
  );
});

test('no key material ever appears in a URL or an error, whatever fails', async () => {
  const { ai, calls } = aiWith((call) => {
    if (call.url.endsWith('/api/tags')) return F.jsonOk({ models: [{ name: 'llama3.2:latest' }] });
    if (call.url.endsWith('/api/chat')) return F.jsonErr(500);
    if (call.url === GEM) return F.jsonErr(429); // probe fails -> cloud_provider_down
    return F.jsonErr(429);
  }, { probeTimeoutMs: 50 });
  let caught = null;
  try { await ai.completeRouted({ task: 'chat', prompt: 'x', cloudEnabled: true, cloudConsent: true }); } catch (e) { caught = e; }
  assert.ok(caught && /gemini_http_429|cloud_provider_down/.test(caught.message));
  assert.ok(!String(caught.message).includes(KEY));
  assert.ok(calls.every((c) => !c.url.includes(KEY))); // header-only, everywhere
  const keyCheck = await ai.testGeminiKey({ key: KEY });
  assert.ok(!JSON.stringify(keyCheck).includes(KEY)); // reasons never carry the key
});

test('testGeminiKey sends the key in a header only and names plain failure reasons', async () => {
  const { ai, calls } = aiWith((call) => (call.url === GEM ? F.jsonErr(401) : F.jsonOk({ models: [] })));
  const r = await ai.testGeminiKey({ key: KEY });
  assert.deepEqual(r, { ok: false, reason: 'gemini_http_401' });
  assert.equal(calls[0].headers['x-goog-api-key'], KEY);
  assert.ok(!calls[0].url.includes(KEY));
  const { ai: ai2 } = aiWith(() => { throw new Error('network down'); });
  assert.deepEqual(await ai2.testGeminiKey({ key: KEY }), { ok: false, reason: 'gemini_network_error' });
});

test('the cloud is never touched without explicit per-request consent', async () => {
  const { ai, calls } = aiWith((call) => {
    if (call.url.endsWith('/api/tags')) return F.jsonOk({ models: [] }); // nothing installed
    return cloudReply();
  });
  const out = await ai.completeRouted({ task: 'chat', prompt: 'x', cloudEnabled: true, cloudConsent: false });
  assert.equal(out.needsCloudConsent, true);
  assert.equal(out.localError, 'no_local_model');
  assert.equal(out.cloud.provider, 'gemini');
  assert.equal(gemCalls(calls).length, 0); // not even a health probe runs
});

test('local_only privacy is the named refusal after a local failure, with no cloud touch', async () => {
  const { ai, calls } = aiWith((call) => {
    if (call.url.endsWith('/api/tags')) return F.jsonOk({ models: [{ name: 'llama3.2:latest' }] });
    if (call.url.endsWith('/api/chat')) return F.jsonErr(500);
    return cloudReply();
  });
  await assert.rejects(
    () => ai.completeRouted({ task: 'chat', prompt: 'x', privacyMode: 'local_only', cloudEnabled: true, cloudConsent: true }),
    (e) => e.reason === 'privacy_local_only',
  );
  assert.equal(gemCalls(calls).length, 0);
});

test('vision (the screen path) never reaches the cloud even fully armed and consented', async () => {
  const { ai, calls } = aiWith((call) => {
    if (call.url.endsWith('/api/tags')) return F.jsonOk({ models: [{ name: 'llama3.2:latest' }] }); // a chat model only
    if (call.url.endsWith('/api/show')) return F.jsonOk({ capabilities: ['chat'] });
    return cloudReply();
  });
  await assert.rejects(
    () => ai.completeRouted({ task: 'vision', prompt: 'x', cloudEnabled: true, cloudConsent: true, visionModel: 'gemma3:4b' }),
    (e) => e.reason === 'no_vision_model_local',
  );
  assert.equal(gemCalls(calls).length, 0);
});

test('an unknown task refuses with its own reason and nothing but the local probe', async () => {
  const { ai, calls } = aiWith(() => F.jsonOk({ models: [] }));
  await assert.rejects(
    () => ai.completeRouted({ task: 'screen', prompt: 'x', cloudEnabled: true, cloudConsent: true }),
    (e) => e.reason === 'unknown_task',
  );
  assert.equal(localCalls(calls).length, 1); // only the tags probe
  assert.equal(gemCalls(calls).length, 0);
});

test('no retry after a refusal: a declined cloud ask stays declined', async () => {
  const { ai, calls } = aiWith((call) => {
    if (call.url.endsWith('/api/tags')) return F.jsonOk({ models: [] });
    return cloudReply();
  });
  const first = await ai.completeRouted({ task: 'chat', prompt: 'x', cloudEnabled: true, cloudConsent: false });
  assert.equal(first.needsCloudConsent, true);
  const second = await ai.completeRouted({ task: 'chat', prompt: 'x', cloudEnabled: true, cloudConsent: false });
  assert.equal(second.needsCloudConsent, true);
  assert.equal(gemCalls(calls).length, 0); // still nothing sent, still nothing probed
  assert.equal(localCalls(calls).length, 2); // one probe per ask, never accumulated retries
});

test('with cloud disabled a local failure stays local: one attempt, no fallback', async () => {
  const { ai, calls } = aiWith((call) => {
    if (call.url.endsWith('/api/tags')) return F.jsonOk({ models: [{ name: 'llama3.2:latest' }] });
    return F.jsonErr(500);
  }, { cloudEnabled: false });
  await assert.rejects(() => ai.completeRouted({ task: 'chat', prompt: 'x' }), /ollama_http_500/);
  assert.equal(localCalls(calls).filter((c) => c.url.endsWith('/api/chat')).length, 1);
  assert.equal(gemCalls(calls).length, 0);
});
