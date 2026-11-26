'use strict';

// Gate 2 file-output gate (26 Nov 2026, approved by Ninad: D-F1 design,
// D-F2 root unset by default, D-F3 extensions .ics/.txt/.md). The pure
// validation/policy layer lives in src/agent-tool-file-output.js; disk I/O
// arrives later as an INJECTED io adapter from main (the only non-pure
// part). NOTHING IS REGISTERED: the production registry keeps carrying
// exactly the one scheduling-gate tool; the io adapter and root wiring
// arrive only with a separately-approved enable step.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRegistry, validateDefinition } = require('../src/tool-registry.js');
const { createPolicyEngine } = require('../src/policy-engine.js');
const { createApprovalDesk } = require('../src/approval.js');
const { createEmergencyStop } = require('../src/emergency-stop.js');
const { createAuditLog } = require('../src/audit.js');
const { createFileOutputTool, FILE_OUTPUT_TOOL_DEFINITION } = require('../src/agent-tool-file-output.js');

const NOW = 1_700_000_000_000;
const CAP = 65536;

// Fake io adapter implementing the three-method contract.
function fakeIo(overrides) {
  const calls = { exists: [], realpath: [], writeFileAtomic: [] };
  const base = {
    files: new Map(),
    exists: (fullPath) => { calls.exists.push(fullPath); return base.files.has(fullPath); },
    realpath: (p) => { calls.realpath.push(p); return p; },
    writeFileAtomic: (fullPath, content) => {
      calls.writeFileAtomic.push({ fullPath, content });
      base.files.set(fullPath, content);
      return { ok: true };
    },
  };
  return Object.assign(base, overrides || {}, { calls });
}

function wired(opts) {
  const registry = createRegistry();
  registry.define(FILE_OUTPUT_TOOL_DEFINITION);
  const approvals = createApprovalDesk({ clock: () => NOW });
  const emergencyStop = createEmergencyStop();
  const audit = createAuditLog({ clock: () => NOW });
  const engine = createPolicyEngine({ registry, approvals, emergencyStop, clock: () => NOW });
  const io = fakeIo(opts && opts.io);
  const tool = createFileOutputTool({
    io,
    clock: () => NOW,
    audit,
    root: opts && 'root' in opts ? opts.root : '/home/ninad/agent-files',
  });
  return { registry, approvals, engine, emergencyStop, audit, io, tool };
}

test('the definition validates and pins the approved shape', () => {
  const registry = createRegistry();
  assert.deepEqual(validateDefinition(FILE_OUTPUT_TOOL_DEFINITION), [], 'definition must validate clean');
  registry.define(FILE_OUTPUT_TOOL_DEFINITION);
  assert.equal(registry.list().length, 1);
  const def = registry.list()[0];
  assert.equal(def.name, 'file_write');
  assert.equal(def.capability, 'sensitive');
  assert.equal(def.critical, false);
});

test('registry arg validation: types, required fields, unknown fields', () => {
  const { registry } = wired();
  assert.equal(registry.validateArgs('file_write', {}).ok, false);
  assert.equal(registry.validateArgs('file_write', { name: 'a.txt' }).ok, false);
  assert.equal(registry.validateArgs('file_write', { name: 'a.txt', content: 'x', extra: 1 }).ok, false);
  assert.equal(registry.validateArgs('file_write', { name: 7, content: 'x' }).ok, false);
  assert.equal(registry.validateArgs('file_write', { name: 'a.txt', content: 'x' }).ok, true);
  // The registry's global string cap (500 chars) binds at validation; the
  // 64 KiB byte cap is the adapter's own check.
  assert.equal(registry.validateArgs('file_write', { name: 'a.txt', content: 'x'.repeat(501) }).ok, false);
});

test('root-unconfigured refusal: even a grant AND a valid approval cannot write', () => {
  const w = wired({ root: undefined });
  assert.equal(w.engine.grantTool({ tool: 'file_write' }).ok, true);
  const args = { name: 'note.txt', content: 'hello' };
  const approval = w.approvals.request({ tool: 'file_write', args }).approval;
  assert.equal(w.engine.authorize({ tool: 'file_write', args, approvalId: approval.id }).allowed, true);
  const res = w.tool.execute(args);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'file_output_root_unconfigured');
  assert.equal(w.io.calls.writeFileAtomic.length, 0);
});

test('deny ladder end to end, with digest binding on the exact content', () => {
  const w = wired();
  const args = { name: 'note.txt', content: 'hello' };
  assert.equal(w.engine.authorize({ tool: 'file_write', args }).allowed, false);
  assert.equal(w.engine.authorize({ tool: 'file_write', args }).reason, 'no_grant');
  assert.equal(w.engine.grantTool({ tool: 'file_write' }).ok, true);
  assert.equal(w.engine.authorize({ tool: 'file_write', args }).reason, 'approval_required');
  const approval = w.approvals.request({ tool: 'file_write', args }).approval;
  const swapped = { name: 'note.txt', content: 'hello!' };
  assert.equal(w.engine.authorize({ tool: 'file_write', args: swapped, approvalId: approval.id }).allowed, false);
  assert.equal(w.engine.authorize({ tool: 'file_write', args, approvalId: approval.id }).allowed, true);
});

test('traversal and name rejections', () => {
  const w = wired();
  const bad = ['..', 'a/b', '/abs', '.hidden', 'a\\b', '', 'a b.txt', 'a\t.txt', '.ics', 'x'.repeat(129)];
  for (const name of bad) {
    const res = w.tool.execute({ name, content: 'x' });
    assert.equal(res.ok, false, 'name ' + JSON.stringify(name));
    assert.equal(res.reason, 'name_invalid', 'name ' + JSON.stringify(name) + ' -> ' + res.reason);
  }
  assert.equal(w.io.calls.writeFileAtomic.length, 0);
});

test('extension allowlist: exact lowercase .ics/.txt/.md only', () => {
  const w = wired();
  for (const name of ['note', 'a.exe', 'A.TXT', 'a.md.', 'a.txt.exe', 'a.tar.gz']) {
    const res = w.tool.execute({ name, content: 'x' });
    assert.equal(res.ok, false, 'name ' + name);
    assert.equal(res.reason, 'ext_not_allowed', 'name ' + name + ' -> ' + res.reason);
  }
  for (const name of ['note.txt', 'plan.md', 'event.ics', 'a1-B_c.ics']) {
    const res = w.tool.execute({ name, content: 'x' });
    assert.notEqual(res.reason, 'name_invalid', 'name ' + name + ' should pass the name check');
    assert.notEqual(res.reason, 'ext_not_allowed', 'name ' + name + ' should pass the extension check');
  }
});

test('exists refusal: never overwrite, no partial file after refusal', () => {
  const w = wired();
  const res = w.tool.execute({ name: 'note.txt', content: 'hello' });
  assert.equal(res.ok, true, JSON.stringify(res));
  const again = w.tool.execute({ name: 'note.txt', content: 'other' });
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'file_exists');
  assert.equal(w.io.files.get('/home/ninad/agent-files/note.txt'), 'hello');
  assert.equal(w.io.calls.writeFileAtomic.length, 1);
});

test('realpath refusals: escape, missing root, io failure', () => {
  const escape = wired({ io: { realpath: () => '/somewhere/else' } });
  const r1 = escape.tool.execute({ name: 'note.txt', content: 'x' });
  assert.equal(r1.reason, 'root_realpath_mismatch');
  assert.equal(escape.io.calls.writeFileAtomic.length, 0);
  const missing = wired({ io: { realpath: () => null } });
  assert.equal(missing.tool.execute({ name: 'note.txt', content: 'x' }).reason, 'root_missing');
  const broken = wired({ io: { realpath: () => { throw new Error('EACCES'); } } });
  assert.equal(broken.tool.execute({ name: 'note.txt', content: 'x' }).reason, 'io_refusal');
  const brokenExists = wired({ io: { exists: () => { throw new Error('EIO'); } } });
  assert.equal(brokenExists.tool.execute({ name: 'note.txt', content: 'x' }).reason, 'io_refusal');
  const brokenWrite = wired({ io: { writeFileAtomic: () => { throw new Error('ENOSPC'); } } });
  assert.equal(brokenWrite.tool.execute({ name: 'note.txt', content: 'x' }).reason, 'io_refusal');
});

test('byte cap and lone-surrogate rejection', () => {
  const w = wired();
  const ascii = 'a'.repeat(CAP);
  assert.equal(w.tool.execute({ name: 'big.txt', content: ascii }).ok, true);
  const over = 'a'.repeat(CAP + 1);
  assert.equal(w.tool.execute({ name: 'over.txt', content: over }).reason, 'content_too_large');
  // 32768 two-byte chars = exactly 65536 bytes: at the cap, allowed.
  const twoByte = 'é'.repeat(32768);
  const w2 = wired();
  assert.equal(w2.tool.execute({ name: 'uni.txt', content: twoByte }).ok, true, JSON.stringify(w2));
  // One more two-byte char pushes it over the byte cap (still under the char cap).
  assert.equal(wired().tool.execute({ name: 'uni2.txt', content: 'é'.repeat(32769) }).reason, 'content_too_large');
  assert.equal(wired().tool.execute({ name: 'lone.txt', content: 'ok \uD800 tail' }).reason, 'content_not_text');
  assert.equal(wired().tool.execute({ name: 'lone2.txt', content: 'tail \uDC00' }).reason, 'content_not_text');
  assert.equal(wired().tool.execute({ name: 'notstr.txt', content: 42 }).reason, 'content_not_text');
});

test('audit entry carries name and bytes only, never content', () => {
  const w = wired();
  const content = 'secret body ' + 'x'.repeat(100);
  const res = w.tool.execute({ name: 'note.txt', content });
  assert.equal(res.ok, true);
  const entries = w.audit.read({}).filter((e) => e.action === 'file.write');
  assert.equal(entries.length, 1);
  const e = entries[0];
  assert.equal(e.actor, 'agent');
  assert.equal(e.tool, 'file_write');
  assert.equal(e.decision, 'allowed');
  assert.equal(e.detail.name, 'note.txt');
  assert.equal(e.detail.bytes, Buffer.byteLength(content, 'utf8'));
  assert.equal(JSON.stringify(e.detail).includes('secret'), false, 'content never audited');
  assert.equal(Object.keys(e.detail).length, 2);
});

test('audit append failure fails the step without writing through the io adapter twice', () => {
  const w = wired();
  // A failed audit must leave the tool's single write intact (one call),
  // and the step still reports the approved failure mode.
  w.audit.append = () => ({ ok: false });
  const res = w.tool.execute({ name: 'note.txt', content: 'x' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'audit_append_failed');
  assert.equal(w.io.calls.writeFileAtomic.length, 1);
});

test('the returned result carries name and bytes, never the content', () => {
  const w = wired();
  const res = w.tool.execute({ name: 'out.md', content: '# plan' });
  assert.equal(res.ok, true);
  assert.equal(res.file.name, 'out.md');
  assert.equal(res.file.bytes, 6);
  assert.equal(JSON.stringify(res).includes('# plan'), false);
});

test('a real reference io adapter: atomic write contract (temp+rename, 0o600, no execute bit)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fo-gate2-'));
  const calls = { exists: 0, realpath: 0, writeFileAtomic: 0 };
  const io = {
    exists: (fullPath) => { calls.exists++; return fs.existsSync(fullPath); },
    realpath: (p) => { calls.realpath++; return fs.realpathSync(p); },
    writeFileAtomic: async (fullPath, content) => {
      calls.writeFileAtomic++;
      const tmp = fullPath + '.tmp-' + Date.now() + '-' + calls.writeFileAtomic;
      fs.writeFileSync(tmp, content, { mode: 0o600 });
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, fullPath);
    },
  };
  const registry = createRegistry();
  registry.define(FILE_OUTPUT_TOOL_DEFINITION);
  const approvals = createApprovalDesk({ clock: () => NOW });
  const engine = createPolicyEngine({ registry, approvals, emergencyStop: createEmergencyStop(), clock: () => NOW });
  const audit = createAuditLog({ clock: () => NOW });
  const tool = createFileOutputTool({ io, clock: () => NOW, audit, root: dir });
  assert.equal(engine.grantTool({ tool: 'file_write' }).ok, true);
  const args = { name: 'plan.md', content: '# plan\nhello' };
  const approval = approvals.request({ tool: 'file_write', args }).approval;
  assert.equal(engine.authorize({ tool: 'file_write', args, approvalId: approval.id }).allowed, true);
  const res = tool.execute(args);
  assert.equal(res.ok, true, JSON.stringify(res));
  const written = path.join(dir, 'plan.md');
  assert.equal(fs.existsSync(written), true);
  assert.equal(fs.readFileSync(written, 'utf8'), args.content);
  const mode = fs.statSync(written).mode & 0o777;
  assert.equal(mode, 0o600, 'mode must be 0o600, got ' + mode.toString(8));
  const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp-'));
  assert.equal(leftovers.length, 0, 'no temp files left behind');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the tool module requires no filesystem module and references no other tool', () => {
  const src = fs.readFileSync('src/agent-tool-file-output.js', 'utf8');
  assert.equal(/require\(/.test(src), false, 'no requires: io arrives by injection');
  assert.equal(src.includes('fs.'), false, 'no filesystem access');
  assert.equal(src.includes('child_process'), false);
  assert.equal(src.includes('schedule_create'), false);
});

test('emergency stop stays absolute', () => {
  const w = wired();
  assert.equal(w.emergencyStop.activate('test', { by: 'user' }).ok, true);
  const args = { name: 'note.txt', content: 'x' };
  const denied = w.engine.authorize({ tool: 'file_write', args });
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, 'stop_active');
});

test('wiring lock: ipc-contract unchanged, the registry module stays free of file-output', () => {
  const contract = fs.readFileSync('src/ipc-contract.js', 'utf8');
  assert.equal(contract.includes('file_write'), false, 'the renderer contract never gains a file channel');
  const registrySrc = fs.readFileSync('src/tool-registry.js', 'utf8');
  assert.equal(registrySrc.toLowerCase().includes('file_write'), false, 'the registry module stays generic');
});
