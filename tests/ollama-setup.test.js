'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const OSU = require('../src/ollama-setup');

test('setupState: the four stages', () => {
  assert.equal(OSU.setupState({ ollamaRunning: true, modelPresent: true }).stage, 'ready');
  assert.equal(OSU.setupState({ ollamaRunning: false }).stage, 'install');
  assert.equal(OSU.setupState({ ollamaRunning: true, modelPresent: false }).stage, 'pull');
  assert.equal(OSU.setupState({ mobile: true }).stage, 'unsupported');
  // install stage carries the plan for the platform
  const st = OSU.setupState({ platform: 'darwin' });
  assert.equal(st.stage, 'install');
  assert.equal(st.plan.kind, 'guided');
  // pull stage carries size
  const pull = OSU.setupState({ ollamaRunning: true, modelPresent: false, model: 'llama3.2:latest' });
  assert.equal(pull.stage, 'pull');
  assert.ok(pull.size.bytes > 1e9);
});

test('installPlan: official routes, linux is a user-run command', () => {
  const mac = OSU.installPlan('darwin');
  assert.equal(mac.kind, 'guided');
  assert.equal(mac.url, 'https://ollama.com/download/mac');
  assert.ok(mac.steps.length >= 2);

  const win = OSU.installPlan('win32');
  assert.equal(win.kind, 'guided');
  assert.equal(win.url, 'https://ollama.com/download/windows');

  const linux = OSU.installPlan('linux');
  assert.equal(linux.kind, 'command');
  assert.equal(linux.url, 'https://ollama.com/download/linux');
  assert.match(linux.command, /ollama\.com\/install\.sh/);
  assert.match(linux.command, /^curl -fsSL/);

  assert.equal(OSU.installPlan('freebsd'), null);
});

test('isOpenableUrl: only the official pages open', () => {
  for (const url of ['https://ollama.com/download/mac', 'https://ollama.com/download/windows', 'https://ollama.com/download/linux']) {
    assert.equal(OSU.isOpenableUrl(url), true);
  }
  for (const url of [null, '', 'http://evil.example/x.zip', 'https://ollama.com/download/mac.exe', 'file:///etc/passwd']) {
    assert.equal(OSU.isOpenableUrl(url), false, url);
  }
});

test('modelPresent: family semantics, mirroring ai.status', () => {
  // ai.status() treats any llama3.2:* tag as the model being loaded, so the
  // setup card must agree with that or the two views will fight.
  assert.equal(OSU.modelPresent(['llama3.2:1b', 'gemma3:4b'], 'llama3.2:latest'), true);
  assert.equal(OSU.modelPresent(['llama3.2:1b'], 'llama3.2:1b'), true);
  assert.equal(OSU.modelPresent(['llama3.2:3b'], 'llama3.2:latest'), true);
  assert.equal(OSU.modelPresent(['llama3.2:1b'], 'llama3:1b'), false);
  assert.equal(OSU.modelPresent([], 'llama3.2:latest'), false);
});

test('detectOllama: running, models, version; down when unreachable', async () => {
  const good = OSU.detectOllama({
    ollamaUrl: 'http://127.0.0.1:11434',
    fetchImpl: async (url) => {
      if (url.endsWith('/api/tags')) {
        return { ok: true, json: async () => ({ models: [{ name: 'llama3.2:1b' }] }) };
      }
      return { ok: true, json: async () => ({ version: '0.4.2' }) };
    },
  });
  const r = await good;
  assert.equal(r.running, true);
  assert.deepEqual(r.models, ['llama3.2:1b']);
  assert.equal(r.version, '0.4.2');

  const down = await OSU.detectOllama({
    ollamaUrl: 'http://127.0.0.1:11434',
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
  });
  assert.equal(down.running, false);
  assert.deepEqual(down.models, []);
});

test('parsePullLine: percent math and missing totals', () => {
  assert.deepEqual(OSU.parsePullLine({ status: 'pulling manifest' }), { status: 'pulling manifest', completed: null, total: null, pct: null });
  const half = OSU.parsePullLine({ status: 'downloading', completed: 500, total: 1000 });
  assert.equal(half.pct, 50);
  const over = OSU.parsePullLine({ status: 'downloading', completed: 1100, total: 1000 });
  assert.equal(over.pct, 100);
  const under = OSU.parsePullLine({ status: 'downloading', completed: -5, total: 1000 });
  assert.equal(under.pct, 0);
});

test('pullModel: streams NDJSON progress, errors, and no-body guard', async () => {
  const lines = [
    JSON.stringify({ status: 'pulling manifest' }),
    JSON.stringify({ status: 'downloading sha256:x', completed: 250, total: 1000 }),
    JSON.stringify({ status: 'success' }),
  ];
  const enc = new TextEncoder();
  const progresses = [];
  const res = await OSU.pullModel({
    ollamaUrl: 'http://127.0.0.1:11434',
    model: 'llama3.2:latest',
    onProgress: (p) => progresses.push(p.pct),
    fetchImpl: async () => ({
      ok: true,
      body: new ReadableStream({
        start(c) { for (const l of lines) c.enqueue(enc.encode(l + '\n')); c.close(); },
      }),
    }),
  });
  assert.equal(res.ok, true);
  assert.deepEqual(progresses, [null, 25, null]);

  await assert.rejects(
    OSU.pullModel({ fetchImpl: async () => ({ ok: true, body: null }) }),
    /no_stream_body/
  );

  await assert.rejects(
    OSU.pullModel({
      fetchImpl: async () => ({
        ok: true,
        body: new ReadableStream({ start(c) { c.enqueue(enc.encode(JSON.stringify({ error: 'registry down' }) + '\n')); c.close(); } }),
      }),
    }),
    /registry down/
  );
});

test('pullModel: cancellation rejects and no further progress is reported', async () => {
  const ac = new AbortController();
  const seen = [];
  const p = OSU.pullModel({
    ollamaUrl: 'http://127.0.0.1:11434',
    model: 'llama3.2:latest',
    signal: ac.signal,
    onProgress: (x) => seen.push(x),
    fetchImpl: async (_url, init) => ({
      ok: true,
      body: { getReader: () => ({ read: () => new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted')))) }) },
    }),
  });
  setTimeout(() => ac.abort(), 10);
  await assert.rejects(p, /aborted/);
  assert.deepEqual(seen, []);
});

test('diskVerdict: headroom is enforced', () => {
  const ok = OSU.diskVerdict({ freeBytes: 3 * 1024 * 1024 * 1024, neededBytes: 2 * 1024 * 1024 * 1024 });
  assert.equal(ok.enough, true);
  const tight = OSU.diskVerdict({ freeBytes: 2.1 * 1024 * 1024 * 1024, neededBytes: 2 * 1024 * 1024 * 1024 });
  assert.equal(tight.enough, false);
  assert.ok(tight.neededBytes > 2 * 1024 * 1024 * 1024);
});

// The safety contract, checked against the source itself: this module may
// never spawn a process, run a script, or open a URL it has not allowlisted.
test('safety: no process execution anywhere in the module', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'ollama-setup.js'), 'utf8');
  for (const banned of ['child_process', 'spawn(', 'execFile', 'exec(', 'openExternal', 'shell.']) {
    assert.ok(!src.includes(banned), `module must not contain ${banned}`);
  }
});

test('REGRESSION: the pull stream tail is parsed even without a trailing newline', async () => {
  const enc = new TextEncoder();
  // A terminal error line that lacks the trailing newline must still fail
  // the pull, not be silently dropped and reported as ok.
  await assert.rejects(
    OSU.pullModel({
      ollamaUrl: 'http://127.0.0.1:11434',
      model: 'llama3.2:latest',
      fetchImpl: async () => ({
        ok: true,
        body: new ReadableStream({
          start(c) {
            c.enqueue(enc.encode(JSON.stringify({ status: 'downloading', completed: 100, total: 1000 }) + '\n'));
            c.enqueue(enc.encode(JSON.stringify({ error: 'pull failed at the end' })));
            c.close();
          },
        }),
      }),
    }),
    /pull failed at the end/
  );

  // And a final progress line without the newline still reports its percent.
  const seen = [];
  const res = await OSU.pullModel({
    ollamaUrl: 'http://127.0.0.1:11434',
    model: 'llama3.2:latest',
    onProgress: (p) => seen.push(p.pct),
    fetchImpl: async () => ({
      ok: true,
      body: new ReadableStream({
        start(c) {
          c.enqueue(enc.encode(JSON.stringify({ status: 'downloading', completed: 250, total: 1000 }) + '\n'));
          c.enqueue(enc.encode(JSON.stringify({ status: 'success', completed: 1000, total: 1000 })));
          c.close();
        },
      }),
    }),
  });
  assert.equal(res.ok, true);
  assert.deepEqual(seen, [25, 100]);
});
