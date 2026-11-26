'use strict';

// Red-first behavioral tests for the Gate 4 file-access policy core
// (Ninad's 26 Nov 2026 decision C: broad filesystem access where the OS
// allows, implemented with safeguards). The core is PURE: it decides and
// displays, never touches the filesystem. Every refusal names its reason.

const test = require('node:test');
const assert = require('node:assert');

let createFileAccessPolicy;
try { createFileAccessPolicy = require('../src/agent-tool-file-access.js').createFileAccessPolicy; }
catch (e) { createFileAccessPolicy = null; }

function policy() {
  if (!createFileAccessPolicy) return null;
  return createFileAccessPolicy({ clock: () => 1000, platform: 'darwin' });
}

test('a read and a list of an absolute path pass with the real target shown and no confirmation', () => {
  const p = policy();
  if (!p) return assert.ok(false, 'module missing');
  for (const action of ['read', 'list']) {
    const d = p.propose({ action, path: '/Users/ninad/notes/todo.txt' });
    assert.equal(d.ok, true, action);
    assert.equal(d.action, action);
    assert.equal(d.target, '/Users/ninad/notes/todo.txt');
    assert.equal(d.requiresConfirmation, false, action);
  }
});

test('a relative path and a null byte are refused with named reasons', () => {
  const p = policy();
  if (!p) return assert.ok(false, 'module missing');
  assert.deepEqual(p.propose({ action: 'read', path: 'notes/todo.txt' }), { ok: false, reason: 'path_must_be_absolute' });
  assert.equal(p.propose({ action: 'read', path: '/a\u0000b' }).reason, 'path_invalid');
  assert.equal(p.propose({ action: 'read', path: '/a\nb' }).reason, 'path_invalid');
});

test('a write to a path known to exist requires an explicit confirm and refuses without one', () => {
  const p = policy();
  if (!p) return assert.ok(false, 'module missing');
  const d = p.propose({ action: 'write', path: '/Users/ninad/notes/todo.txt', existsHint: true });
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'overwrite_requires_confirmation');
  assert.equal(d.target, '/Users/ninad/notes/todo.txt', 'the target is still named in the refusal');
  const ok = p.propose({ action: 'write', path: '/Users/ninad/notes/todo.txt', existsHint: true, confirmed: true });
  assert.equal(ok.ok, true);
  assert.equal(ok.confirmed, true);
});

test('a write whose existence is unknown requires confirmation too (safe default)', () => {
  const p = policy();
  if (!p) return assert.ok(false, 'module missing');
  const d = p.propose({ action: 'write', path: '/Users/ninad/notes/new.txt' });
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'overwrite_requires_confirmation');
});

test('a write to a path known to be new needs no confirmation', () => {
  const p = policy();
  if (!p) return assert.ok(false, 'module missing');
  const d = p.propose({ action: 'write', path: '/Users/ninad/notes/new.txt', existsHint: false });
  assert.equal(d.ok, true);
  assert.equal(d.requiresConfirmation, false);
});

test('a delete always requires an explicit confirm, without exception', () => {
  const p = policy();
  if (!p) return assert.ok(false, 'module missing');
  const plain = p.propose({ action: 'delete', path: '/Users/ninad/notes/old.txt' });
  assert.equal(plain.ok, false);
  assert.equal(plain.reason, 'delete_requires_confirmation');
  const withHint = p.propose({ action: 'delete', path: '/Users/ninad/notes/old.txt', existsHint: false });
  assert.equal(withHint.ok, false, 'even a path that may not exist');
  assert.equal(withHint.reason, 'delete_requires_confirmation');
  const ok = p.propose({ action: 'delete', path: '/Users/ninad/notes/old.txt', confirmed: true });
  assert.equal(ok.ok, true);
  assert.equal(ok.requiresConfirmation, true);
  assert.equal(ok.confirmed, true);
});

test('mkdir on an existing directory changes nothing and says so; unknown actions are refused', () => {
  const p = policy();
  if (!p) return assert.ok(false, 'module missing');
  const d = p.propose({ action: 'mkdir', path: '/Users/ninad/notes', existsHint: true });
  assert.equal(d.ok, true);
  assert.equal(d.changesNothing, true);
  assert.equal(p.propose({ action: 'chmod', path: '/x' }).reason, 'unknown_action');
  assert.equal(p.propose({ action: 'write' }).reason, 'path_must_be_absolute');
});

test('normalization collapses dot segments and doubles slashes and shows the target', () => {
  const p = policy();
  if (!p) return assert.ok(false, 'module missing');
  const d = p.propose({ action: 'read', path: '/Users/ninad/./notes//todo.txt' });
  assert.equal(d.ok, true);
  assert.equal(d.target, '/Users/ninad/notes/todo.txt');
  const esc = p.propose({ action: 'read', path: '/Users/ninad/notes/../../etc/hosts' });
  assert.equal(esc.ok, true, 'broad access is the approved mode; the REAL resolved target must be visible');
  assert.equal(esc.target, '/Users/etc/hosts', 'POSIX .. resolution from /Users/ninad/notes is /Users');
});

test('scoped roots start unset by default and the sandbox note is explicit', () => {
  const p = policy();
  if (!p) return assert.ok(false, 'module missing');
  assert.deepEqual(p.roots(), {}, 'no scoped roots until someone sets one');
  assert.equal(typeof p.SANDBOX_NOTE, 'string');
  assert.ok(/OS/i.test(p.SANDBOX_NOTE));
  assert.ok(/never/i.test(p.SANDBOX_NOTE));
});

test('the tool definition is sensitive and validates like schedule_create does', () => {
  const mod = require('../src/agent-tool-file-access.js');
  const def = mod.FILE_ACCESS_TOOL_DEFINITION;
  assert.equal(def.name, 'file_access');
  assert.equal(def.capability, 'sensitive');
  assert.equal(def.critical, false);
  const actions = def.schema.properties.action.enum;
  assert.deepEqual(actions.sort(), ['delete', 'list', 'mkdir', 'read', 'write']);
});

test('the tool execute mirrors the policy and performs NO filesystem work', () => {
  const mod = require('../src/agent-tool-file-access.js');
  const inst = mod.createFileAccessTool({ clock: () => 1000 });
  const refused = inst.execute({ action: 'delete', path: '/tmp/x' });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'delete_requires_confirmation');
  const ok = inst.execute({ action: 'read', path: '/tmp/x' });
  assert.equal(ok.ok, true);
  assert.equal(ok.fileWritten, undefined, 'no execution side effect is claimed');
  assert.equal(ok.performed, undefined, 'the executor layer performs the real op, a later slice');
});
