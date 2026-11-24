'use strict';
// Gate 2 review fix: the file saver FAILS CLOSED when the atomic rename
// cannot replace the target. No in-place write of the target ever happens:
// the previous file stays byte-for-byte intact, the temp file is removed,
// and a sanitized persistence error is thrown (error code only, no paths,
// no file contents). Atomicity is never traded for availability.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const LocalDb = require('../src/db');

for (const code of ['EPERM', 'EACCES', 'EEXIST']) {
  test('fsSaver fails closed on rename ' + code + ': old file intact, temp cleaned, sanitized error', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-saver-'));
    const file = path.join(dir, 'store.db');
    const realRename = fs.renameSync;
    let db = null;
    let calls = 0;
    try {
      // Establish a valid on-disk store first, with the healthy saver.
      db = await LocalDb.open({ file });
      await db.flush();
      const before = fs.readFileSync(file);

      fs.renameSync = function () {
        calls++;
        const err = new Error('simulated ' + code);
        err.code = code;
        throw err;
      };
      db.run('CREATE TABLE probe (x INTEGER)');
      db.run('INSERT INTO probe VALUES (1)');
      let threw = null;
      try { db.flush(); } catch (err) { threw = err; }

      assert.ok(threw, 'the flush throws on rename failure');
      assert.match(threw.message, new RegExp('^persist_failed_rename \\(' + code + '\\)$'));
      assert.ok(!threw.message.includes(dir), 'no path in the error');
      assert.ok(!threw.message.includes(file), 'no file path in the error');
      assert.ok(fs.readFileSync(file).equals(before), 'the old target is byte-for-byte intact');
      const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
      assert.equal(leftovers.length, 0, 'the temp file was cleaned up');
      assert.equal(calls, 3, 'the rename was retried twice before failing closed');
    } finally {
      fs.renameSync = realRename;
      if (db) { try { db.close(); } catch (e) { /* best effort */ } }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('fsSaver sanitizes a non-rename write failure too', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-saver-'));
  const file = path.join(dir, 'store.db');
  const realWrite = fs.writeFileSync;
  let db = null;
  try {
    db = await LocalDb.open({ file });
    await db.flush();
    const before = fs.readFileSync(file);
    let patched = false;
    fs.writeFileSync = function (f) {
      if (patched && String(f).endsWith('.tmp')) {
        const err = new Error('ENOSPC: no space left on device, write ' + file);
        err.code = 'ENOSPC';
        throw err;
      }
      return realWrite.apply(fs, arguments);
    };
    // One healthy flush passes through the patched writer; arm it now.
    patched = true;
    db.run('CREATE TABLE probe2 (x INTEGER)');
    let threw = null;
    try { db.flush(); } catch (err) { threw = err; }
    assert.ok(threw, 'the flush throws on write failure');
    assert.match(threw.message, /^persist_failed_write \(ENOSPC\)$/);
    assert.ok(!threw.message.includes(dir), 'no path in the error');
    assert.ok(fs.readFileSync(file).equals(before), 'the old target is byte-for-byte intact');
    const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
    assert.equal(leftovers.length, 0, 'the temp file was cleaned up');
  } finally {
    fs.writeFileSync = realWrite;
    if (db) { try { db.close(); } catch (e) { /* best effort */ } }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
