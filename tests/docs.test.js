'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readDocs } = require('../src/docs');

const ROOT = path.join(__dirname, '..');

test('the real privacy policy and terms ship and say what they must', () => {
  const d = readDocs(ROOT);
  assert.equal(d.ok, true);
  assert.match(d.version, /^\d+\.\d+\.\d+/);
  assert.match(d.privacy, /Last updated/);
  assert.match(d.privacy, /_about-me\.md/, 'the policy describes the about-me file');
  assert.match(d.privacy, /not sent|NOT sent/i, 'the policy states what the cloud fallback does not receive');
  assert.match(d.terms, /MIT License/);
});

test('a missing file is reported, not thrown', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companiondesk-docs-'));
  fs.writeFileSync(path.join(dir, 'TERMS.md'), 'terms');
  assert.deepEqual(readDocs(dir), { ok: false, version: null, privacy: null, terms: 'terms' });
});

test('packaging includes everything the app loads at runtime', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const files = pkg.build.files;
  for (const needed of ['src/**/*', 'renderer/**/*', 'prompts/**/*', 'build/icon.png', 'PRIVACY_POLICY.md', 'TERMS.md']) {
    assert.ok(files.includes(needed), `build.files must include ${needed}`);
  }
  assert.ok(fs.existsSync(path.join(ROOT, 'build', 'icon.png')));
  assert.match(pkg.build.mac.extendInfo.NSMicrophoneUsageDescription, /never sent anywhere/);
  assert.equal(pkg.build.mac.icon, 'build/icon.png');
});

test('every script and stylesheet the pages load actually exists', () => {
  const pages = ['index.html', 'overlay.html'];
  for (const page of pages) {
    const html = fs.readFileSync(path.join(ROOT, 'renderer', page), 'utf8');
    for (const m of html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)) {
      assert.ok(fs.existsSync(path.join(ROOT, 'renderer', m[1])), `${page} loads missing file ${m[1]}`);
    }
  }
  const rec = fs.readFileSync(path.join(ROOT, 'renderer', 'recorder.js'), 'utf8');
  const worklet = rec.match(/addModule\('([^']+)'\)/)[1];
  assert.ok(fs.existsSync(path.join(ROOT, 'renderer', worklet)), 'the audio worklet file exists');
});
