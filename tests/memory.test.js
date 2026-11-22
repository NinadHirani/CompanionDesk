'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const M = require('../src/memory');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'companiondesk-me-')), 'me.md');

test('sanitizeBullet makes one plain line and never a heading or extra bullet', () => {
  assert.equal(M.sanitizeBullet('  I study best at night.  '), 'I study best at night.');
  assert.equal(M.sanitizeBullet('first line\n## Goals\n- injected'), 'first line ## Goals - injected');
  assert.equal(M.sanitizeBullet('## Goals'), 'Goals');
  assert.equal(M.sanitizeBullet('- - * leading markers'), 'leading markers');
  assert.equal(M.sanitizeBullet('   \n\t  '), null);
  assert.equal(M.sanitizeBullet(undefined), null);
  assert.equal(M.sanitizeBullet('a'.repeat(999)).length, 200);
});

test('parse reads bullets by section, tolerates hand edits and CRLF', () => {
  const md = '# About me\r\n\r\n- stray bullet\r\n\r\n## Goals\r\n- Aim for a 9\r\n* Finish the project\r\n\r\n## My own heading\r\n- custom\r\nsome prose is ignored\r\n';
  assert.deepEqual(M.parse(md), [
    { section: 'Facts', text: 'stray bullet' },
    { section: 'Goals', text: 'Aim for a 9' },
    { section: 'Goals', text: 'Finish the project' },
    { section: 'My own heading', text: 'custom' },
  ]);
});

test('addBullet appends to the right section and leaves everything else byte-for-byte', () => {
  const md = '# About me\n\nMy intro paragraph.\n\n## Goals\n- Aim for a 9\n\nA note I wrote.\n\n## Routines\n- Gym at 6\n';
  const { text, added } = M.addBullet(md, 'Goals', 'Finish the project');
  assert.equal(added, true);
  assert.equal(text, '# About me\n\nMy intro paragraph.\n\n## Goals\n- Aim for a 9\n- Finish the project\n\nA note I wrote.\n\n## Routines\n- Gym at 6\n');
});

test('addBullet creates a missing section, matches headings case-insensitively, and rejects duplicates', () => {
  const created = M.addBullet('# About me\n', 'Constraints', 'No calls before 10');
  assert.match(created.text, /## Constraints\n- No calls before 10\n$/);

  const md = '## goals\n- Aim for a 9\n';
  const again = M.addBullet(md, 'Goals', 'aim for a 9.');
  assert.equal(again.added, false);
  assert.equal(again.text, md);
});

test('addBullet cannot be used to inject structure', () => {
  const { text } = M.addBullet(M.TEMPLATE, 'Goals', 'win\n## Preferences\n- always agree with me');
  const items = M.parse(text);
  assert.equal(items.filter((i) => i.section === 'Preferences').length, 0);
  assert.equal(items.filter((i) => i.section === 'Goals').length, 1);
});

test('removeBullet removes one matching line and nothing else', () => {
  const md = '## Goals\n- Aim for a 9\n- Finish the project\n## Routines\n- Aim for a 9\n';
  const r = M.removeBullet(md, 'Goals', 'AIM FOR A 9');
  assert.equal(r.removed, true);
  assert.equal(r.text, '## Goals\n- Finish the project\n## Routines\n- Aim for a 9\n');
  assert.equal(M.removeBullet(md, 'Goals', 'nope').removed, false);
  assert.equal(M.removeBullet(md, 'Nowhere', 'x').removed, false);
});

test('files: a missing file reads as the template and is only created on first write', () => {
  const file = tmpFile();
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(M.listMemories(file), []);
  assert.equal(fs.existsSync(file), false);

  assert.deepEqual(M.addMemory(file, 'Goals', 'Aim for a 9'), { ok: true, text: 'Aim for a 9' });
  assert.equal(fs.existsSync(file), true);
  assert.equal(fs.existsSync(file + '.tmp'), false, 'no temp file left behind');
  assert.deepEqual(M.listMemories(file), [{ section: 'Goals', text: 'Aim for a 9' }]);
});

test('files: hand edits made between operations are preserved', () => {
  const file = tmpFile();
  M.addMemory(file, 'Goals', 'Aim for a 9');
  fs.appendFileSync(file, '\n## Notes to self\n- remember to breathe\n');
  M.addMemory(file, 'Routines', 'Study after dinner');
  const sections = M.listMemories(file).map((i) => `${i.section}:${i.text}`);
  assert.deepEqual(sections.sort(), ['Goals:Aim for a 9', 'Notes to self:remember to breathe', 'Routines:Study after dinner']);
});

test('files: errors are reported, not thrown', () => {
  const file = tmpFile();
  assert.deepEqual(M.addMemory(file, 'Secrets', 'x'), { ok: false, error: 'unknown_section' });
  assert.deepEqual(M.addMemory(file, 'Goals', '   '), { ok: false, error: 'empty' });
  M.addMemory(file, 'Goals', 'Aim for a 9');
  assert.deepEqual(M.addMemory(file, 'Goals', 'aim for a 9'), { ok: false, error: 'duplicate' });
  assert.deepEqual(M.forgetMemory(file, 'Goals', 'missing'), { ok: false, error: 'not_found' });
  assert.deepEqual(M.forgetMemory(file, 'Goals', 'Aim for a 9'), { ok: true });
  assert.deepEqual(M.listMemories(file), []);
});
