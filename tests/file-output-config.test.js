'use strict';

// File-output root config core (28 Nov 2026, under Ninad's standing
// authorization): the pure validation/store policy for the file_write
// gate's root folder setting. The Workspace panel's explicit control is
// the only surface that reaches it; the renderer and the model can never
// set or widen the root on their own. An unset root keeps every
// file_write call refused (file_output_root_unconfigured).

const test = require('node:test');
const assert = require('node:assert');

const { createFileOutputRootConfig } = require('../src/file-output-config.js');

function store(initial) {
  const data = { file_output_root: initial === undefined ? '' : initial };
  return {
    data,
    getSetting(key, fallback) { return key in data ? data[key] : fallback; },
    setSetting(key, value) { data[key] = value; },
  };
}

test('get on an empty store reports not configured and never throws', () => {
  const s = store();
  const cfg = createFileOutputRootConfig({ getSetting: s.getSetting, setSetting: s.setSetting });
  assert.deepEqual(cfg.get(), { ok: true, configured: false, root: null });
});

test('set stores a trimmed absolute POSIX path and get reflects it', () => {
  const s = store();
  const cfg = createFileOutputRootConfig({ getSetting: s.getSetting, setSetting: s.setSetting });
  const r = cfg.set('  /Users/ninad/CompanionDesk output  ');
  assert.equal(r.ok, true);
  assert.equal(r.configured, true);
  assert.equal(r.root, '/Users/ninad/CompanionDesk output');
  assert.equal(s.data.file_output_root, '/Users/ninad/CompanionDesk output');
  assert.deepEqual(cfg.get(), { ok: true, configured: true, root: '/Users/ninad/CompanionDesk output' });
});

test('set accepts a Windows drive-letter absolute path', () => {
  const s = store();
  const cfg = createFileOutputRootConfig({ getSetting: s.getSetting, setSetting: s.setSetting });
  const r = cfg.set('C:\\Users\\ninad\\CompanionDesk output');
  assert.equal(r.ok, true);
  assert.equal(r.root, 'C:\\Users\\ninad\\CompanionDesk output');
});

const BAD = [
  ['relative path', 'Users/ninad/output'],
  ['home shorthand', '~/output'],
  ['file url', 'file:///Users/ninad/output'],
  ['null byte', '/Users/ninad/out\u0000put'],
  ['newline', '/Users/ninad/out\nput'],
  ['too long', '/' + 'a'.repeat(512)],
  ['non-string', 42],
  ['object', {}],
];

for (const [label, bad] of BAD) {
  test('set refuses: ' + label, () => {
    const s = store();
    const cfg = createFileOutputRootConfig({ getSetting: s.getSetting, setSetting: s.setSetting });
    const r = cfg.set(bad);
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.reason, 'bad_root');
    assert.equal(s.data.file_output_root, '', 'nothing stored');
    assert.equal(cfg.get().configured, false);
  });
}

test('set with an empty or blank value clears back to the unset default', () => {
  const s = store('/Users/ninad/out');
  const cfg = createFileOutputRootConfig({ getSetting: s.getSetting, setSetting: s.setSetting });
  for (const v of ['', '   ', undefined, null]) {
    const r = cfg.set(v);
    assert.equal(r.ok, true);
    assert.equal(r.configured, false, 'cleared for ' + JSON.stringify(v));
    assert.equal(r.root, null);
    assert.equal(s.data.file_output_root, '');
  }
});

test('a failing store surfaces setting_failed and leaves the old value intact', () => {
  const s = store('/Users/ninad/out');
  let boom = false;
  const cfg = createFileOutputRootConfig({
    getSetting: s.getSetting,
    setSetting(key, value) { if (boom) throw new Error('disk gone'); s.setSetting(key, value); },
  });
  boom = true;
  const r = cfg.set('/Users/ninad/other');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'setting_failed');
  assert.equal(s.data.file_output_root, '/Users/ninad/out', 'old value intact');
  assert.equal(cfg.get().root, '/Users/ninad/out');
});

test('a missing getSetting or setSetting is a construction error', () => {
  assert.throws(() => createFileOutputRootConfig({}), /getSetting and setSetting/);
});
