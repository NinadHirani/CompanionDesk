'use strict';

// Gate 2 slice 1: agent safety foundation. Adversarial suite for the pure
// modules: typed tool registry, approval decisions, policy engine,
// append-only audit, emergency stop. No tool is registered here beyond
// harmless fixtures; no UI, no IPC, no wiring.

const test = require('node:test');
const assert = require('node:assert');
const { canonicalJson, sha256Hex } = require('../src/digest');
const { CAPABILITIES, createRegistry, isCriticalName } = require('../src/tool-registry');
const { createApprovalDesk, argsDigest } = require('../src/approval');
const { createPolicyEngine } = require('../src/policy-engine');
const { createAuditLog, chainHash, toCanonicalEntry } = require('../src/audit');
const { createEmergencyStop } = require('../src/emergency-stop');

let now = 0;
const clock = () => now;

function fixtureRegistry() {
  const registry = createRegistry();
  registry.define({ name: 'notes.search', description: 'Search local notes (read-only fixture)', capability: 'read_only', schema: { properties: { query: { type: 'string', required: true, maxLength: 200 }, limit: { type: 'integer' } } } });
  registry.define({ name: 'notes.rename_tag', description: 'Rename a tag (reversible fixture)', capability: 'reversible_write', schema: { properties: { from: { type: 'string', required: true, maxLength: 64 }, to: { type: 'string', required: true, maxLength: 64 } } } });
  registry.define({ name: 'payments.charge', description: 'Charge a payment (sensitive fixture)', capability: 'sensitive', schema: { properties: { amount: { type: 'integer', required: true }, currency: { type: 'string', required: true, maxLength: 8 } } } });
  registry.define({ name: 'calendar.export', description: 'Export calendar (critical reversible fixture)', capability: 'reversible_write', critical: true, schema: { properties: { format: { type: 'string', required: true, maxLength: 8 } } } });
  registry.define({ name: 'system.shutdown', description: 'Shut the app down (forbidden fixture)', capability: 'forbidden', schema: { properties: { scope: { type: 'string', required: true, maxLength: 32 } } } });
  return registry;
}

function world() {
  const registry = fixtureRegistry();
  const approvals = createApprovalDesk({ clock });
  const emergencyStop = createEmergencyStop();
  const engine = createPolicyEngine({ registry, approvals, emergencyStop, clock });
  const audit = createAuditLog({ clock });
  return { registry, approvals, emergencyStop, engine, audit };
}

test('digest matches the SHA-256 standard test vectors', () => {
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256Hex('a'.repeat(1000000)).slice(0, 16), 'cdc76e5c9914fb92');
});

test('canonicalJson sorts keys at every depth and is stable across key order', () => {
  assert.equal(canonicalJson({ b: 1, a: { z: 1, y: [2, 1] } }), '{"a":{"y":[2,1],"z":1},"b":1}');
  assert.equal(canonicalJson({ x: 1, y: 2 }), canonicalJson({ y: 2, x: 1 }));
  assert.equal(canonicalJson(null), 'null');
  assert.equal(canonicalJson([-0.0, 0]), '[-0,0]');
  assert.throws(() => canonicalJson({ a: NaN }), TypeError);
  assert.throws(() => canonicalJson({ a: () => 1 }), TypeError);
});

test('the registry refuses broken definitions and never registers twice', () => {
  const registry = createRegistry();
  assert.deepEqual(registry.define(null), { ok: false, errors: ['definition_not_object'] });
  assert.match(JSON.stringify(registry.define({ name: 'Bad Name!', description: 'd', capability: 'read_only', schema: { properties: {} } })), /bad_name/);
  assert.match(JSON.stringify(registry.define({ name: 'a.b', description: 'd', capability: 'risky', schema: { properties: {} } })), /bad_capability/);
  assert.match(JSON.stringify(registry.define({ name: 'a.b', description: 'd', capability: 'read_only', schema: { properties: {}, extra: 1 } })), /unknown_schema_field/);
  assert.match(JSON.stringify(registry.define({ name: 'a.b', description: 'd', capability: 'read_only', schema: { properties: { q: { type: 'array' } } } })), /bad_field_type/);
  assert.match(JSON.stringify(registry.define({ name: 'a.b', description: 'd', capability: 'read_only', schema: { properties: { q: { type: 'string' } } }, whoops: true })), /unknown_definition_field/);
  assert.equal(registry.define({ name: 'a.b', description: 'd', capability: 'read_only', schema: { properties: {} } }).ok, true);
  assert.match(JSON.stringify(registry.define({ name: 'a.b', description: 'd', capability: 'read_only', schema: { properties: {} } })), /duplicate_name/);
});

test('the four capability classes are exactly as specified', () => {
  assert.deepEqual([...CAPABILITIES], ['read_only', 'reversible_write', 'sensitive', 'forbidden']);
});

test('definitions are deeply immutable', () => {
  const registry = createRegistry();
  registry.define({ name: 'a.b', description: 'd', capability: 'read_only', schema: { properties: { q: { type: 'string' } } } });
  const def = registry.get('a.b');
  assert.throws(() => { 'use strict'; def.capability = 'forbidden'; }, TypeError);
  assert.throws(() => { 'use strict'; def.schema.properties.q.type = 'number'; }, TypeError);
  assert.equal(registry.get('a.b').capability, 'read_only');
  assert.equal(registry.get('a.b').schema.properties.q.type, 'string');
  assert.equal(Object.isFrozen(def), true);
});

test('a fresh registry ships with no tools registered', () => {
  assert.deepEqual(createRegistry().list(), []);
});

test('argument validation refuses extra, missing, wrong-typed and oversized values', () => {
  const registry = createRegistry();
  registry.define({
    name: 't.x',
    description: 'fixture',
    capability: 'read_only',
    schema: {
      properties: {
        q: { type: 'string', required: true, maxLength: 4 },
        n: { type: 'integer' },
        f: { type: 'number' },
        b: { type: 'boolean' },
        tags: { type: 'string_array', maxItems: 2 },
        mode: { type: 'string', enum: ['fast', 'slow'] },
      },
    },
  });
  assert.match(JSON.stringify(registry.validateArgs('t.x', { q: 'ok', extra: 1 })), /unknown_field:extra/);
  assert.match(JSON.stringify(registry.validateArgs('t.x', {})), /missing_field:q/);
  assert.match(JSON.stringify(registry.validateArgs('t.x', { q: 1 })), /wrong_type:q/);
  assert.match(JSON.stringify(registry.validateArgs('t.x', { q: 'ok', n: 1.5 })), /wrong_type:n/);
  assert.match(JSON.stringify(registry.validateArgs('t.x', { q: 'ok', f: 'x' })), /wrong_type:f/);
  assert.match(JSON.stringify(registry.validateArgs('t.x', { q: 'ok', b: 'yes' })), /wrong_type:b/);
  assert.match(JSON.stringify(registry.validateArgs('t.x', { q: 'ok', tags: [1] })), /array_element_wrong_type/);
  assert.match(JSON.stringify(registry.validateArgs('t.x', { q: 'ok', mode: 'nope' })), /value_not_allowed/);
  assert.match(JSON.stringify(registry.validateArgs('t.x', { q: 'toolong' })), /string_too_long/);
  assert.match(JSON.stringify(registry.validateArgs('t.x', { q: 'ok', tags: ['a', 'b', 'c'] })), /array_too_long/);
  assert.match(JSON.stringify(registry.validateArgs('t.x', { q: 'ok', n: 1, f: 1, b: true, tags: [], mode: 'fast', zz: 1 })), /too_many_fields/);
  assert.deepEqual(registry.validateArgs('t.x', { q: 'ok' }), { ok: true, errors: [] });
  assert.deepEqual(registry.validateArgs('t.x', { q: 'ok', n: 3, f: 1.5, b: false, tags: ['a'], mode: 'fast' }), { ok: true, errors: [] });
});

test('argument validation refuses oversized global values and non-object args', () => {
  const registry = createRegistry();
  registry.define({ name: 't.g', description: 'fixture', capability: 'read_only', schema: { properties: { q: { type: 'string' } } } });
  assert.match(JSON.stringify(registry.validateArgs('t.g', { q: 'x'.repeat(501) })), /string_too_long/);
  assert.match(JSON.stringify(registry.validateArgs('t.g', [])), /args_not_object/);
  assert.match(JSON.stringify(registry.validateArgs('t.g', 'str')), /args_not_object/);
  assert.match(JSON.stringify(registry.validateArgs('t.g', null)), /args_missing/);
  assert.match(JSON.stringify(registry.validateArgs('t.g', undefined)), /args_missing/);
  assert.match(JSON.stringify(registry.validateArgs('unknown.tool', {})), /unknown_tool/);
});

test('prototype-polluting argument keys are refused', () => {
  const registry = createRegistry();
  registry.define({ name: 't.p', description: 'fixture', capability: 'read_only', schema: { properties: { q: { type: 'string' } } } });
  for (const bad of ['{"__proto__":1}', '{"constructor":1}', '{"prototype":1}']) {
    const args = JSON.parse(bad);
    args.q = 'ok';
    assert.match(JSON.stringify(registry.validateArgs('t.p', args)), /forbidden_field/, bad);
  }
});

test('an approval binds the exact tool and the exact args', () => {
  const { approvals } = world();
  const a = approvals.request({ tool: 'payments.charge', args: { amount: 100, currency: 'INR' } }).approval;
  assert.equal(a.tool, 'payments.charge');
  assert.equal(a.argsDigest, argsDigest('payments.charge', { amount: 100, currency: 'INR' }));
  assert.match(approvals.verify(a.id, { tool: 'notes.search', args: { amount: 100, currency: 'INR' } }).reason, /tool_mismatch/);
  assert.match(approvals.verify(a.id, { tool: 'payments.charge', args: { amount: 101, currency: 'INR' } }).reason, /args_mismatch/);
  assert.match(approvals.verify(a.id, { tool: 'payments.charge', args: { amount: 100, currency: 'USD' } }).reason, /args_mismatch/);
  // key order of the same args does not change the binding
  assert.equal(approvals.verify(a.id, { tool: 'payments.charge', args: { currency: 'INR', amount: 100 } }).ok, true);
});

test('an approval is strictly one-time', () => {
  const { approvals } = world();
  const a = approvals.request({ tool: 'payments.charge', args: { amount: 5, currency: 'INR' } }).approval;
  assert.equal(approvals.consume(a.id, { tool: 'payments.charge', args: { amount: 5, currency: 'INR' } }).ok, true);
  assert.match(approvals.consume(a.id, { tool: 'payments.charge', args: { amount: 5, currency: 'INR' } }).reason, /approval_used/);
  assert.match(approvals.verify(a.id, { tool: 'payments.charge', args: { amount: 5, currency: 'INR' } }).reason, /approval_used/);
});

test('an approval expires and never outlives its window', () => {
  const { approvals } = world();
  const a = approvals.request({ tool: 'payments.charge', args: { amount: 1, currency: 'INR' } }).approval;
  now += 2 * 60000; // default ttl is 2 minutes
  assert.match(approvals.verify(a.id, { tool: 'payments.charge', args: { amount: 1, currency: 'INR' } }).reason, /approval_expired/);
  assert.match(approvals.consume(a.id, { tool: 'payments.charge', args: { amount: 1, currency: 'INR' } }).reason, /approval_expired/);
});

test('unknown, cancelled and malformed approval requests are refused', () => {
  const { approvals } = world();
  assert.match(approvals.verify('deadbeefdeadbeef', { tool: 'x', args: {} }).reason, /approval_unknown/);
  assert.match(approvals.request({ args: {} }).reason, /approval_tool_invalid/);
  assert.match(approvals.request({ tool: 'x.y' }).reason, /approval_args_missing/);
  const a = approvals.request({ tool: 'x.y', args: { a: 1 } }).approval;
  assert.equal(approvals.cancel(a.id).ok, true);
  assert.match(approvals.verify(a.id, { tool: 'x.y', args: { a: 1 } }).reason, /approval_cancelled/);
  assert.match(approvals.cancel(a.id).reason, /approval_not_cancellable/);
});

test('the policy engine denies by default: unknown tool and no grant', () => {
  const { engine } = world();
  assert.match(engine.authorize({ tool: 'does.not_exist', args: {} }).reason, /unknown_tool/);
  assert.match(engine.authorize({ tool: 'notes.search', args: { query: 'x' } }).reason, /no_grant/);
});

test('wrong scope is no grant at all: a grant covers exactly one tool', () => {
  const { engine } = world();
  engine.grantTool({ tool: 'notes.search' });
  assert.match(engine.authorize({ tool: 'notes.rename_tag', args: { from: 'a', to: 'b' } }).reason, /no_grant/);
  assert.equal(engine.authorize({ tool: 'notes.search', args: { query: 'x' } }).allowed, true);
});

test('malformed args are rejected before any grant is even consulted', () => {
  const { engine } = world();
  engine.grantTool({ tool: 'notes.search' });
  const d = engine.authorize({ tool: 'notes.search', args: {} });
  assert.equal(d.allowed, false);
  assert.equal(d.reason, 'invalid_args');
  assert.match(JSON.stringify(d.errors), /missing_field:query/);
  assert.equal(engine.authorize({ tool: 'notes.search', args: { query: 'x', hack: 1 } }).reason, 'invalid_args');
  assert.equal(engine.authorize({ tool: 'notes.search', args: [1, 2] }).reason, 'invalid_args');
});

test('no implicit broad grants exist', () => {
  const { engine, registry } = world();
  assert.match(engine.grantTool({ tool: '*' }).reason, /wildcard_grant_refused/);
  assert.match(engine.grantTool({ tool: 'not.a_tool' }).reason, /unknown_tool/);
  assert.match(engine.grantTool({ tool: 'notes.search', capability: 'sensitive' }).reason, /capability_mismatch/);
  // a capability name is not a tool: granting "read_only" grants nothing
  assert.match(engine.grantTool({ tool: 'read_only' }).reason, /unknown_tool/);
  assert.equal(registry.get('notes.search').capability, 'read_only');
  assert.match(engine.authorize({ tool: 'notes.search', args: { query: 'x' } }).reason, /no_grant/);
});

test('grants expire and can be revoked, and revocation wins', () => {
  const { engine } = world();
  engine.grantTool({ tool: 'notes.search', ttlMs: 1000 });
  assert.equal(engine.authorize({ tool: 'notes.search', args: { query: 'x' } }).allowed, true);
  now += 1001;
  assert.match(engine.authorize({ tool: 'notes.search', args: { query: 'x' } }).reason, /grant_expired/);
  assert.match(engine.revoke('never.granted').reason, /no_grant/);
  engine.grantTool({ tool: 'notes.rename_tag' });
  engine.revoke('notes.rename_tag');
  assert.match(engine.authorize({ tool: 'notes.rename_tag', args: { from: 'a', to: 'b' } }).reason, /grant_revoked/);
});

test('read-only and reversible-write tools run under an exact grant', () => {
  const { engine } = world();
  engine.grantTool({ tool: 'notes.search' });
  engine.grantTool({ tool: 'notes.rename_tag' });
  const ro = engine.authorize({ tool: 'notes.search', args: { query: 'x' } });
  assert.equal(ro.allowed, true);
  assert.equal(ro.capability, 'read_only');
  assert.equal(ro.critical, false);
  const rw = engine.authorize({ tool: 'notes.rename_tag', args: { from: 'a', to: 'b' } });
  assert.equal(rw.allowed, true);
  assert.equal(rw.capability, 'reversible_write');
});

test('sensitive tools never accept a standing grant', () => {
  const { engine } = world();
  engine.grantTool({ tool: 'payments.charge' });
  const d = engine.authorize({ tool: 'payments.charge', args: { amount: 1, currency: 'INR' } });
  assert.equal(d.allowed, false);
  assert.equal(d.reason, 'approval_required');
  // even with an approvalId present, a standing grant alone never bypasses
  // the approval check: the approval must match these exact args
  const d2 = engine.authorize({ tool: 'payments.charge', args: { amount: 1, currency: 'INR' }, approvalId: 'notarealid00000000' });
  assert.equal(d2.reason, 'approval_invalid');
  assert.equal(d2.approvalReason, 'approval_unknown');
});

test('a valid one-time approval authorizes exactly one sensitive execution', () => {
  const { engine, approvals } = world();
  engine.grantTool({ tool: 'payments.charge' });
  const args = { amount: 250, currency: 'INR' };
  const a = approvals.request({ tool: 'payments.charge', args }).approval;
  const ok = engine.authorize({ tool: 'payments.charge', args, approvalId: a.id });
  assert.equal(ok.allowed, true);
  assert.equal(ok.critical, true);
  assert.equal(approvals.consume(a.id, { tool: 'payments.charge', args }).ok, true);
  const again = engine.authorize({ tool: 'payments.charge', args, approvalId: a.id });
  assert.equal(again.allowed, false);
  assert.equal(again.reason, 'approval_invalid');
  assert.equal(again.approvalReason, 'approval_used');
});

test('args modified after approval are refused', () => {
  const { engine, approvals } = world();
  engine.grantTool({ tool: 'payments.charge' });
  const approved = { amount: 100, currency: 'INR' };
  const a = approvals.request({ tool: 'payments.charge', args: approved }).approval;
  const modified = { amount: 100000, currency: 'INR' };
  const d = engine.authorize({ tool: 'payments.charge', args: modified, approvalId: a.id });
  assert.equal(d.allowed, false);
  assert.equal(d.approvalReason, 'approval_args_mismatch');
  // and the consumption of the modified args is refused too, so nothing leaks
  assert.match(approvals.consume(a.id, { tool: 'payments.charge', args: modified }).reason, /args_mismatch/);
});

test('a stale approval is refused even with unchanged args', () => {
  const { engine, approvals } = world();
  engine.grantTool({ tool: 'payments.charge' });
  const args = { amount: 10, currency: 'INR' };
  const a = approvals.request({ tool: 'payments.charge', args }).approval;
  now += 3 * 60000; // past the 2-minute default ttl
  const d = engine.authorize({ tool: 'payments.charge', args, approvalId: a.id });
  assert.equal(d.allowed, false);
  assert.equal(d.approvalReason, 'approval_expired');
});

test('a critical-flagged tool requires fresh approval regardless of capability class', () => {
  const { engine, approvals } = world();
  engine.grantTool({ tool: 'calendar.export' });
  assert.equal(engine.authorize({ tool: 'calendar.export', args: { format: 'ics' } }).reason, 'approval_required');
  const a = approvals.request({ tool: 'calendar.export', args: { format: 'ics' } }).approval;
  assert.equal(engine.authorize({ tool: 'calendar.export', args: { format: 'ics' }, approvalId: a.id }).allowed, true);
});

test('forbidden tools are always denied, at grant time and at authorize time', () => {
  const { engine } = world();
  assert.match(engine.grantTool({ tool: 'system.shutdown' }).reason, /forbidden_tool/);
  assert.equal(engine.grantTool({ tool: 'system.shutdown' }).ok, false);
  assert.match(engine.authorize({ tool: 'system.shutdown', args: { scope: 'all' } }).reason, /forbidden_tool/);
});

test('an active emergency stop blocks every authorization, read-only included', () => {
  const { engine, emergencyStop } = world();
  engine.grantTool({ tool: 'notes.search' });
  engine.grantTool({ tool: 'payments.charge' });
  assert.equal(emergencyStop.activate('operator panic stop', { by: 'user' }).ok, true);
  assert.equal(engine.authorize({ tool: 'notes.search', args: { query: 'x' } }).reason, 'stop_active');
  const args = { amount: 1, currency: 'INR' };
  const a = { id: '0'.repeat(64) };
  assert.equal(engine.authorize({ tool: 'payments.charge', args, approvalId: a.id }).reason, 'stop_active');
});

test('only an explicit user action can reset the stop', () => {
  const { emergencyStop } = world();
  emergencyStop.activate('test', { by: 'agent' });
  assert.match(emergencyStop.reset({ by: 'agent' }).reason, /reset_requires_user/);
  assert.match(emergencyStop.reset({ by: 'system' }).reason, /reset_requires_user/);
  assert.equal(emergencyStop.isActive(), true, 'a non-user reset changes nothing');
  assert.equal(emergencyStop.reset({ by: 'user' }).ok, true);
  assert.equal(emergencyStop.isActive(), false);
  assert.match(emergencyStop.reset({ by: 'user' }).reason, /not_active/);
});

test('stop activation validates its inputs', () => {
  const { emergencyStop } = world();
  assert.match(emergencyStop.activate('', { by: 'user' }).reason, /bad_reason/);
  assert.match(emergencyStop.activate('x'.repeat(201), { by: 'user' }).reason, /bad_reason/);
  assert.match(emergencyStop.activate('why', { by: 'nobody' }).reason, /bad_actor/);
  assert.equal(emergencyStop.isActive(), false, 'a refused activation does not activate');
});

test('the audit log accepts exactly its allowlisted schema', () => {
  const { audit } = world();
  const ok = audit.append({ actor: 'agent', action: 'tool.authorize', tool: 'notes.search', decision: 'denied', reason: 'no_grant', detail: { capability: 'read_only', elapsed_ms: 3, retried: false } });
  assert.equal(ok.ok, true);
  assert.equal(ok.seq, 1);
  assert.match(JSON.stringify(audit.append({ actor: 'root', action: 'x' })), /bad_actor/);
  assert.match(JSON.stringify(audit.append({ actor: 'agent', action: 'BAD ACTION!' })), /bad_action/);
  assert.match(JSON.stringify(audit.append({ actor: 'agent', action: 'x', tool: 'Bad Tool' })), /bad_tool/);
  assert.match(JSON.stringify(audit.append({ actor: 'agent', action: 'x', decision: 'maybe' })), /bad_decision/);
  assert.match(JSON.stringify(audit.append({ actor: 'agent', action: 'x', reason: 'NO GRANT' })), /bad_reason/);
  assert.match(JSON.stringify(audit.append({ actor: 'agent', action: 'x', approvalId: 'ZZZ' })), /bad_approvalId/);
  assert.match(JSON.stringify(audit.append({ actor: 'agent', action: 'x', zzz: 1 })), /unknown_field/);
  assert.match(JSON.stringify(audit.append({ actor: 'agent', action: 'x', detail: { s: 'x'.repeat(201) } })), /detail_value_too_long/);
  assert.match(JSON.stringify(audit.append({ actor: 'agent', action: 'x', detail: { nested: { a: 1 } } })), /bad_detail_value/);
  assert.match(JSON.stringify(audit.append({ actor: 'agent', action: 'x', detail: [1, 2] })), /bad_detail/);
  const nine = {};
  for (let i = 0; i < 9; i++) nine['f' + i] = i;
  assert.match(JSON.stringify(audit.append({ actor: 'agent', action: 'x', detail: nine })), /detail_too_many_keys/);
  assert.match(JSON.stringify(audit.append('not an object')), /entry_not_object/);
  assert.match(JSON.stringify(audit.append({ actor: 'agent', action: 'x', at: 'yesterday' })), /bad_at/);
});

test('the audit log refuses secret-shaped keys in any position', () => {
  const { audit } = world();
  for (const k of ['api_key', 'password', 'user_prompt', 'prompt_text', 'tool_output', 'gemini_key', 'credentials', 'auth_token', 'raw_args', 'request_body', 'model_output', 'result_text', 'conversation_history', 'transcript', 'KEY', 'secret_value']) {
    const res = audit.append({ actor: 'agent', action: 'x', detail: { [k]: 'value' } });
    assert.equal(res.ok, false, k);
    assert.match(JSON.stringify(res), /forbidden_detail_key|bad_detail_key/, k);
  }
  // and nothing of the sort is ever stored
  assert.equal(JSON.stringify(audit.read()).includes('value'), false);
});

test('prompt text can never enter the log, even as a top-level field', () => {
  const { audit } = world();
  const res = audit.append({ actor: 'agent', action: 'x', prompt: 'secret user prompt text' });
  assert.equal(res.ok, false);
  assert.match(JSON.stringify(res), /unknown_field:prompt/);
  assert.equal(audit.length, 0);
});

test('the audit log is append-only: no update or delete API, and reads are independent copies', () => {
  const { audit } = world();
  assert.equal(audit.update, undefined);
  assert.equal(audit.delete, undefined);
  assert.equal(audit['delete'], undefined);
  audit.append({ actor: 'agent', action: 'tool.authorize', tool: 'notes.search', decision: 'allowed' });
  const a = audit.read()[0];
  const b = audit.read()[0];
  assert.notEqual(a, b, 'reads return fresh copies, not references into the store');
  a.action = 'changed-copy-only';
  assert.equal(b.action, 'tool.authorize', 'mutating one copy changes nothing else');
  assert.equal(audit.verify().ok, true, 'the stored chain still verifies');
});

test('the audit hash chain detects edits, deletions and insertions', () => {
  const { audit } = world();
  audit.append({ actor: 'agent', action: 'tool.authorize', tool: 'notes.search', decision: 'allowed', reason: 'grant_valid' });
  audit.append({ actor: 'agent', action: 'tool.authorize', tool: 'notes.search', decision: 'denied', reason: 'no_grant' });
  audit.append({ actor: 'agent', action: 'tool.authorize', tool: 'payments.charge', decision: 'denied', reason: 'approval_required' });
  assert.equal(audit.length, 3);
  assert.equal(audit.verify().ok, true);
  assert.equal(audit.verify(audit.exportAll()).ok, true);

  const edited = audit.exportAll();
  edited[1].reason = 'fabricated';
  assert.equal(audit.verify(edited).ok, false);
  assert.equal(audit.verify(edited).brokenAt, 2);

  const deleted = audit.exportAll();
  deleted.splice(1, 1);
  assert.equal(audit.verify(deleted).ok, false);
  assert.equal(audit.verify(deleted).brokenAt, 3);

  const inserted = audit.exportAll();
  inserted.splice(1, 0, { ...inserted[0], seq: 2, reason: 'injected' });
  assert.equal(audit.verify(inserted).ok, false);
  assert.equal(audit.verify(inserted).brokenAt, 2);

  const first = audit.exportAll();
  first[0].at = '1999-01-01T00:00:00.000Z';
  assert.equal(audit.verify(first).ok, false);
});

test('audit entries carry a monotonic sequence and chain hashes', () => {
  const { audit } = world();
  audit.append({ actor: 'agent', action: 'a' });
  audit.append({ actor: 'agent', action: 'b' });
  audit.append({ actor: 'agent', action: 'c' });
  const entries = audit.read();
  assert.deepEqual(entries.map((e) => e.seq), [1, 2, 3]);
  assert.equal(entries[1].hash.length, 64);
  assert.notEqual(entries[0].hash, entries[1].hash);
  assert.notEqual(entries[1].hash, entries[2].hash);
  assert.equal(audit.lastHash, entries[2].hash);
});

test('the full authorize flow records a sanitized audit trail end to end', () => {
  const { engine, approvals, audit } = world();
  engine.grantTool({ tool: 'notes.search' });
  engine.grantTool({ tool: 'payments.charge' });

  const record = (d) => {
    if (!d.allowed) return audit.append({ actor: 'agent', action: 'tool.authorize', tool: d.tool, decision: 'denied', reason: d.reason });
    return audit.append({ actor: 'agent', action: 'tool.authorize', tool: d.tool, decision: 'allowed', reason: 'grant_valid', detail: { capability: d.capability, critical: d.critical } });
  };

  record(engine.authorize({ tool: 'notes.search', args: { query: 'x' } }));
  record(engine.authorize({ tool: 'notes.rename_tag', args: { from: 'a', to: 'b' } }));
  record(engine.authorize({ tool: 'payments.charge', args: { amount: 1, currency: 'INR' } }));
  const args = { amount: 500, currency: 'INR' };
  const a = approvals.request({ tool: 'payments.charge', args }).approval;
  record(engine.authorize({ tool: 'payments.charge', args, approvalId: a.id }));
  approvals.consume(a.id, { tool: 'payments.charge', args });
  record(engine.authorize({ tool: 'payments.charge', args, approvalId: a.id }));

  assert.equal(audit.length, 5);
  const reasons = audit.read().map((e) => e.reason);
  assert.deepEqual(reasons, ['grant_valid', 'no_grant', 'approval_required', 'grant_valid', 'approval_invalid']);
  // the trail carries no argument values, no prompts, no raw output: check
  // every stored field except the hash and timestamp, whose hex/clock text
  // is irrelevant here
  const blob = JSON.stringify(audit.read().map((e) => { const { hash, at, ...rest } = e; return rest; }));
  assert.equal(blob.includes('500'), false);
  assert.equal(blob.includes('INR'), false);
  assert.equal(blob.includes('amount'), false);
  assert.equal(blob.includes('currency'), false);
  assert.equal(blob.includes('query'), false);
  assert.equal(audit.verify().ok, true);
});

// ---- hardening round (review of 3d4d5f7) ----

test('approval ids are unpredictable: secure randomness, not seq or time', () => {
  const { approvals } = world();
  const a1 = approvals.request({ tool: 'payments.charge', args: { amount: 1, currency: 'INR' } }).approval;
  const a2 = approvals.request({ tool: 'payments.charge', args: { amount: 1, currency: 'INR' } }).approval;
  assert.equal(/^[a-f0-9]{64}$/.test(a1.id), true);
  assert.equal(/^[a-f0-9]{64}$/.test(a2.id), true);
  assert.notEqual(a1.id, a2.id, 'identical args at an identical clock still mint distinct ids');
  assert.notEqual(a1.id, a1.argsDigest, 'the id is not derived from the args digest');
  // an injected generator is used verbatim (test seam; production uses
  // crypto.randomBytes on desktop and crypto.getRandomValues in the browser)
  const fixed = createApprovalDesk({ clock, randomHex: () => 'a'.repeat(64) });
  assert.equal(fixed.request({ tool: 'x.y', args: {} }).approval.id, 'a'.repeat(64));
});

test('approval requests fail closed without secure randomness', () => {
  const desk = createApprovalDesk({ clock, randomHex: () => null });
  const res = desk.request({ tool: 'payments.charge', args: { amount: 1, currency: 'INR' } });
  assert.deepEqual(res, { ok: false, reason: 'secure_randomness_unavailable' });
  assert.equal(desk.get('a'.repeat(64)), null, 'nothing is stored on a failed mint');
  // a weak or wrongly shaped id is refused too
  const weak = createApprovalDesk({ clock, randomHex: (n) => 'x'.repeat(n) });
  assert.match(weak.request({ tool: 'x.y', args: {} }).reason, /secure_randomness_unavailable/);
});

test('approval requests refuse args that are not plain JSON-like data', () => {
  const { approvals } = world();
  const acc = {};
  Object.defineProperty(acc, 'amount', { get() { return 100; }, enumerable: true });
  assert.match(approvals.request({ tool: 'payments.charge', args: acc }).reason, /approval_args_not_plain_data/);
  const sparse = ['a', 'b'];
  delete sparse[0];
  assert.match(approvals.request({ tool: 'notes.search', args: { tags: sparse } }).reason, /approval_args_not_plain_data/);
  const sym = {};
  sym[Symbol('s')] = 1;
  assert.match(approvals.request({ tool: 'x.y', args: sym }).reason, /approval_args_not_plain_data/);
});

test('sparse arrays and arrays with extra properties are refused in args and digests', () => {
  const { registry } = world();
  const sparse = ['a', 'b'];
  delete sparse[0];
  assert.match(JSON.stringify(registry.validateArgs('notes.search', { query: 'x', tags: sparse })), /args_not_plain_data:sparse_or_extra_array_keys/);
  const extra = ['a', 'b'];
  extra.extra = 'x';
  assert.match(JSON.stringify(registry.validateArgs('notes.search', { query: 'x', tags: extra })), /args_not_plain_data:sparse_or_extra_array_keys/);
  assert.throws(() => canonicalJson(sparse), TypeError);
  assert.throws(() => canonicalJson(extra), TypeError);
  // a hole in the middle is just as sparse
  const holed = ['a', 'b', 'c'];
  delete holed[1];
  assert.throws(() => canonicalJson(holed), TypeError);
});

test('symbol keys, non-enumerable properties and accessors are refused in args and digests', () => {
  const { registry } = world();
  const sym = {};
  sym[Symbol('s')] = 1;
  sym.query = 'ok';
  assert.match(JSON.stringify(registry.validateArgs('notes.search', sym)), /args_not_plain_data:symbol_key/);
  const hidden = {};
  Object.defineProperty(hidden, 'hidden', { value: 1, enumerable: false });
  hidden.query = 'ok';
  assert.match(JSON.stringify(registry.validateArgs('notes.search', hidden)), /args_not_plain_data:non_enumerable_property/);
  const acc = {};
  Object.defineProperty(acc, 'query', { get() { return 'evil'; }, enumerable: true });
  assert.match(JSON.stringify(registry.validateArgs('notes.search', acc)), /args_not_plain_data:accessor_property/);
  const accArr = ['a'];
  Object.defineProperty(accArr, 0, { get() { return 'evil'; }, enumerable: true });
  assert.match(JSON.stringify(registry.validateArgs('notes.search', { query: 'x', tags: accArr })), /args_not_plain_data:accessor_property/);
  for (const bad of [sym, hidden, acc]) {
    assert.throws(() => canonicalJson(bad), TypeError);
  }
  // getter side effects never run during validation or digesting
  let touched = false;
  const spy = {};
  Object.defineProperty(spy, 'query', { get() { touched = true; return 'ok'; }, enumerable: true });
  registry.validateArgs('notes.search', spy);
  assert.equal(touched, false, 'validation must not execute a getter');
});

test('critical action names cannot be registered as read-only or reversible', () => {
  const registry = createRegistry();
  for (const [name, capability] of [
    ['payments.refund', 'read_only'],
    ['payments.charge', 'reversible_write'],
    ['purchase.confirm', 'read_only'],
    ['checkout.pay', 'reversible_write'],
    ['billing.subscribe', 'read_only'],
    ['legal.file_return', 'reversible_write'],
    ['compliance.submit_report', 'read_only'],
    ['contract.sign', 'reversible_write'],
    ['filing.submit', 'read_only'],
    ['files.delete_all', 'reversible_write'],
    ['cache.destroy', 'read_only'],
    ['temp.erase', 'read_only'],
    ['notes.wipe_all', 'read_only'],
    ['cleanup.purge_cache', 'read_only'],
    ['old_data.permanently_remove', 'reversible_write'],
  ]) {
    const res = registry.define({ name, description: 'fixture', capability, schema: { properties: {} } });
    assert.equal(res.ok, false, name + ' must not register as ' + capability);
    assert.match(JSON.stringify(res), /critical_name_requires_sensitive_or_critical/, name);
  }
  // the same names register fine as sensitive or explicitly critical
  assert.equal(registry.define({ name: 'payments.refund', description: 'd', capability: 'sensitive', schema: { properties: {} } }).ok, true);
  assert.equal(registry.define({ name: 'legal.notify', description: 'd', capability: 'reversible_write', critical: true, schema: { properties: {} } }).ok, true);
  // and genuinely harmless names are untouched
  assert.equal(registry.define({ name: 'notes.search', description: 'd', capability: 'read_only', schema: { properties: {} } }).ok, true);
  assert.equal(registry.define({ name: 'notes.rename_tag', description: 'd', capability: 'reversible_write', schema: { properties: {} } }).ok, true);
  assert.equal(isCriticalName('notes.search'), false);
  assert.equal(isCriticalName('payments.refund'), true);
});

test('the policy engine refuses a misclassified critical name even from a registry without the check', () => {
  const fakeRegistry = {
    get(name) {
      return name === 'payments.refund'
        ? { name, description: 'misclassified', capability: 'read_only', critical: false, schema: { properties: {} } }
        : null;
    },
    validateArgs(name, args) {
      return name === 'payments.refund' && typeof args === 'object' && args !== null ? { ok: true, errors: [] } : { ok: false, errors: ['unknown_tool'] };
    },
  };
  const approvals = createApprovalDesk({ clock });
  const emergencyStop = createEmergencyStop();
  const engine = createPolicyEngine({ registry: fakeRegistry, approvals, emergencyStop, clock });
  engine.grantTool({ tool: 'payments.refund' });
  const d = engine.authorize({ tool: 'payments.refund', args: {} });
  assert.equal(d.allowed, false);
  assert.equal(d.reason, 'critical_name_misclassified');
  // with an approval presented it is STILL refused: the flag itself is wrong
  const a = approvals.request({ tool: 'payments.refund', args: {} }).approval;
  assert.equal(engine.authorize({ tool: 'payments.refund', args: {}, approvalId: a.id }).reason, 'critical_name_misclassified');
});

test('audit verify enforces contiguous sequence numbers starting at 1', () => {
  const { audit } = world();
  for (const cap of ['a', 'b', 'c']) {
    audit.append({ actor: 'agent', action: 'tool.authorize', tool: 'notes.search', decision: 'allowed', reason: 'grant_valid', detail: { capability: cap } });
  }
  assert.equal(audit.verify().ok, true);
  const ex = audit.exportAll();

  // attacker drops entry 2 and rehashes entry 3 against entry 1's hash:
  // the chain would pass, the sequence gap must not
  const rehashed = { ...ex[2] };
  rehashed.hash = chainHash(3, ex[0].hash, toCanonicalEntry(rehashed));
  const gap = audit.verify([ex[0], rehashed]);
  assert.equal(gap.ok, false);
  assert.equal(gap.reason, 'sequence_gap');
  assert.equal(gap.brokenAt, 3);

  // plain gap without rehash
  const plainGap = audit.verify([ex[0], ex[2]]);
  assert.equal(plainGap.ok, false);
  assert.equal(plainGap.reason, 'sequence_gap');

  // a list not starting at 1 is rejected
  const shifted = audit.verify([ex[1], ex[2]]);
  assert.equal(shifted.ok, false);
  assert.equal(shifted.reason, 'sequence_gap');

  // non-integer or missing sequences are malformed, not passable
  assert.equal(audit.verify([{ ...ex[0], seq: 1.5 }]).reason, 'malformed_entry');
  assert.equal(audit.verify([{ ...ex[0], seq: undefined }]).reason, 'malformed_entry');

  // the intact log still verifies, contiguity included
  assert.equal(audit.verify(ex).ok, true);
});

// REGRESSION (26 Nov 2026): the approval-verification step assumed a
// constructed, well-behaved approvals desk. With no desk configured at all
// the engine threw a TypeError out of authorize(), and a desk whose
// verify() threw propagated the exception: the only door to tool execution
// crashed instead of denying. The gate's contract is deny by default with a
// stable refusal record, so both cases must come back as denials.
test('a missing or failing approvals desk is a denial, not a crash', () => {
  const registry = fixtureRegistry();
  const engine = createPolicyEngine({ registry });
  engine.grantTool({ tool: 'calendar.export' });
  const d = engine.authorize({ tool: 'calendar.export', args: { format: 'ics' }, approvalId: 'whatever00000000' });
  assert.equal(d.allowed, false);
  assert.equal(d.reason, 'approval_desk_missing');
  const engine2 = createPolicyEngine({ registry, approvals: { verify: () => { throw new Error('desk blew up'); } } });
  engine2.grantTool({ tool: 'calendar.export' });
  const d2 = engine2.authorize({ tool: 'calendar.export', args: { format: 'ics' }, approvalId: 'whatever00000000' });
  assert.equal(d2.allowed, false);
  assert.equal(d2.reason, 'approval_desk_error');
  // the ordinary critical path is untouched
  const engine3 = createPolicyEngine({ registry, approvals: createApprovalDesk({ clock }) });
  engine3.grantTool({ tool: 'calendar.export' });
  assert.equal(engine3.authorize({ tool: 'calendar.export', args: { format: 'ics' } }).reason, 'approval_required');
});

// REGRESSION (26 Nov 2026): verify() (and through it consume()) called
// argsDigest without the fail-closed guard request() has. Non-plain args
// (an accessor property, a symbol-keyed property) made canonicalJson throw
// a TypeError out of the desk instead of returning a stable refusal, the
// same crash-instead-of-deny class the policy engine had. request() already
// answers this exact input with 'approval_args_not_plain_data', so verify()
// must refuse the same way.
test('verify and consume refuse non-plain args instead of throwing', () => {
  const { registry, approvals, engine } = world();
  const args = { amount: 250, currency: 'INR' };
  const a = approvals.request({ tool: 'payments.charge', args }).approval;
  const hostile = { get amount() { return 250; }, currency: 'INR' };
  const v = approvals.verify(a.id, { tool: 'payments.charge', args: hostile });
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'approval_args_not_plain_data');
  const symArgs = {}; symArgs[Symbol('s')] = 1; Object.assign(symArgs, args);
  const v2 = approvals.verify(a.id, { tool: 'payments.charge', args: symArgs });
  assert.equal(v2.ok, false);
  assert.equal(v2.reason, 'approval_args_not_plain_data');
  // consume inherits the same refusal and the approval stays usable
  const c = approvals.consume(a.id, { tool: 'payments.charge', args: hostile });
  assert.equal(c.ok, false);
  assert.equal(c.reason, 'approval_args_not_plain_data');
  assert.equal(approvals.get(a.id).state, 'pending');
  // the ordinary path is untouched: matching plain args still verify and consume
  const ok = approvals.consume(a.id, { tool: 'payments.charge', args });
  assert.equal(ok.ok, true);
});
