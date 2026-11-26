'use strict';

// Red-first tests for the Gate 4 file-access EXECUTION slice (26 Nov
// 2026): real file operations run THROUGH the policy core via an
// injected io adapter. The executor never bypasses a policy refusal, the
// existence probe feeds the policy the real state before any write, and
// OS errors surface verbatim (code + message). A real-fs integration
// test proves the OS path end to end in a temp dir.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs/promises');

const mod = require('../src/agent-tool-file-access.js');

function fakeIo(over) {
  const calls = [];
  const files = new Map(Object.entries(Object.assign({ '/data/todo.txt': 'hello' }, (over && over.files) || {})));
  const dirs = new Set(Object.keys(Object.assign({}, (over && over.dirs) || {})));
  const io = {
    exists: async (p) => files.has(p) || dirs.has(p),
    readFile: async (p) => {
      calls.push(['readFile', p]);
      if (!files.has(p)) { const e = new Error('ENOENT: no such file or directory, open ' + p); e.code = 'ENOENT'; throw e; }
      return files.get(p);
    },
    listDir: async (p) => {
      calls.push(['listDir', p]);
      if (!dirs.has(p)) { const e = new Error('ENOTDIR: not a directory, scandir ' + p); e.code = 'ENOTDIR'; throw e; }
      const out = [];
      for (const name of files.keys()) if (path.dirname(name) === p) out.push({ name: path.basename(name), kind: 'file' });
      for (const d of dirs) if (path.dirname(d) === p) out.push({ name: path.basename(d), kind: 'folder' });
      return out;
    },
    writeFile: async (p, content) => {
      calls.push(['writeFile', p]);
      files.set(p, content);
      return Buffer.byteLength(content, 'utf8');
    },
    deletePath: async (p) => {
      calls.push(['deletePath', p]);
      if (!files.has(p)) { const e = new Error('ENOENT: no such file or directory, unlink ' + p); e.code = 'ENOENT'; throw e; }
      files.delete(p);
    },
    mkdir: async (p) => { calls.push(['mkdir', p]); dirs.add(p); },
  };
  return { io, calls, files, dirs };
}

function tool(io) {
  return mod.createFileAccessTool({ clock: () => 1000, io });
}

test('read runs through the policy and returns the content, performed and named', async () => {
  const h = fakeIo();
  const r = await tool(h.io).execute({ action: 'read', path: '/data/todo.txt' });
  assert.equal(r.ok, true);
  assert.equal(r.performed, true);
  assert.equal(r.target, '/data/todo.txt');
  assert.equal(r.content, 'hello');
  assert.deepEqual(h.calls, [['readFile', '/data/todo.txt']]);
});

test('a policy refusal reaches the io layer ZERO times', async () => {
  const h = fakeIo();
  const r = await tool(h.io).execute({ action: 'delete', path: '/data/todo.txt' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'delete_requires_confirmation');
  assert.deepEqual(h.calls, [], 'nothing touched the filesystem');
  const w = await tool(h.io).execute({ action: 'write', path: '/data/todo.txt', content: 'x', existsHint: true });
  assert.equal(w.ok, false);
  assert.deepEqual(h.calls, [], 'still nothing touched');
});

test('a write to a genuinely new path needs no confirm: the executor probes existence first', async () => {
  const h = fakeIo();
  const r = await tool(h.io).execute({ action: 'write', path: '/data/new.txt', content: 'hi' });
  assert.equal(r.ok, true);
  assert.equal(r.performed, true);
  assert.equal(r.bytes, 2);
  assert.equal(h.files.get('/data/new.txt'), 'hi');
  assert.ok(h.calls.some((c) => c[0] === 'writeFile'));
});

test('a write to an existing path still refuses without confirmed, and honors confirmed', async () => {
  const h = fakeIo();
  const refused = await tool(h.io).execute({ action: 'write', path: '/data/todo.txt', content: 'over' });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'overwrite_requires_confirmation');
  assert.deepEqual(h.calls, [], 'the probe happened but no write');
  assert.equal(h.files.get('/data/todo.txt'), 'hello', 'the file is unchanged');
  const ok = await tool(h.io).execute({ action: 'write', path: '/data/todo.txt', content: 'over', confirmed: true });
  assert.equal(ok.ok, true);
  assert.equal(h.files.get('/data/todo.txt'), 'over');
});

test('a write whose content is over 64 KiB is refused before any io call', async () => {
  const h = fakeIo();
  const big = 'x'.repeat(65537);
  const r = await tool(h.io).execute({ action: 'write', path: '/data/new.bin', content: big });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'content_too_large');
  assert.deepEqual(h.calls, []);
});

test('an io error surfaces verbatim: code and message, nothing invented', async () => {
  const h = fakeIo();
  const r = await tool(h.io).execute({ action: 'read', path: '/data/missing.txt' });
  assert.equal(r.ok, false);
  assert.equal(r.performed, true, 'the operation was attempted and the OS refused');
  assert.equal(r.reason, 'os_error');
  assert.equal(r.code, 'ENOENT');
  assert.ok(/no such file or directory/.test(r.message));
});

test('list returns bounded entries through the policy; delete and mkdir work on confirm', async () => {
  const h = fakeIo({ dirs: { '/data': true, '/data/sub': true } });
  const l = await tool(h.io).execute({ action: 'list', path: '/data' });
  assert.equal(l.ok, true);
  assert.equal(l.performed, true);
  assert.deepEqual(l.entries.map((e) => e.name).sort(), ['sub', 'todo.txt']);
  const d = await tool(h.io).execute({ action: 'delete', path: '/data/todo.txt', confirmed: true });
  assert.equal(d.ok, true);
  assert.equal(h.files.has('/data/todo.txt'), false);
  const m = await tool(h.io).execute({ action: 'mkdir', path: '/data/fresh' });
  assert.equal(m.ok, true);
  assert.equal(h.dirs.has('/data/fresh'), true);
});

test('without an io adapter the tool stays policy-only and claims no execution', async () => {
  const t = mod.createFileAccessTool({ clock: () => 1000 });
  const r = await t.execute({ action: 'read', path: '/data/todo.txt' });
  assert.equal(r.ok, true);
  assert.notEqual(r.performed, true, 'no performed flag without an executor');
  assert.equal(r.content, undefined);
});

test('REAL FS: a full round trip in a temp dir, and an OS error verbatim', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-exec-'));
  const realIo = {
    exists: async (p) => { try { await fsp.stat(p); return true; } catch { return false; } },
    readFile: async (p) => {
      const st = await fsp.stat(p);
      if (st.size > 262144) { const e = new Error('file larger than 262144 bytes'); e.code = 'EFTOOBIG'; throw e; }
      return fsp.readFile(p, 'utf8');
    },
    listDir: async (p) => {
      const ents = await fsp.readdir(p, { withFileTypes: true });
      return ents.slice(0, 500).map((e) => ({ name: e.name, kind: e.isDirectory() ? 'folder' : 'file' }));
    },
    writeFile: async (p, content) => { await fsp.writeFile(p, content, 'utf8'); return Buffer.byteLength(content, 'utf8'); },
    deletePath: async (p) => { await fsp.unlink(p); },
    mkdir: async (p) => { await fsp.mkdir(p); },
  };
  try {
    const t = tool(realIo);
    const target = path.join(dir, 'note.txt');
    const w = await t.execute({ action: 'write', path: target, content: 'real bytes' });
    assert.equal(w.ok, true, JSON.stringify(w));
    assert.equal(await fsp.readFile(target, 'utf8'), 'real bytes');
    const r = await t.execute({ action: 'read', path: target });
    assert.equal(r.content, 'real bytes');
    const l = await t.execute({ action: 'list', path: dir });
    assert.ok(l.entries.some((e) => e.name === 'note.txt'));
    const sub = path.join(dir, 'sub');
    assert.equal((await t.execute({ action: 'mkdir', path: sub })).ok, true);
    assert.equal((await fsp.stat(sub)).isDirectory(), true);
    const d = await t.execute({ action: 'delete', path: target, confirmed: true });
    assert.equal(d.ok, true);
    assert.equal(await realIo.exists(target), false);
    const miss = await t.execute({ action: 'read', path: path.join(dir, 'gone.txt') });
    assert.equal(miss.ok, false);
    assert.equal(miss.code, 'ENOENT');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
