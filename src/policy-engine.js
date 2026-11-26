'use strict';

// Gate 2 slice 1: the policy engine. Pure. It is the only door to tool
// execution and it denies by default: a call is allowed only when the tool
// is registered, its arguments validate exactly, an explicit user grant
// covers this exact tool, the grant is neither revoked nor expired, and,
// for sensitive or otherwise critical tools, a valid one-time approval
// bound to the exact argument set is presented. Nothing implicit is ever
// granted: a wildcard grant, a capability-name grant, or anything wider
// than one registered tool is refused at grant time, so it can never exist.
//
// Order of checks (first refusal wins):
//  1. emergency stop active  -> stop_active (blocks everything, read-only
//     included, grants and approvals notwithstanding)
//  2. unknown tool           -> unknown_tool
//  3. capability forbidden   -> forbidden_tool
//  4. malformed arguments    -> invalid_args (checked BEFORE grants: bad
//     args can never ride on any grant)
//  5. no grant for this tool -> no_grant
//  6. grant revoked/expired  -> grant_revoked / grant_expired
//  7. sensitive or critical  -> a valid approval for these exact args is
//     required; standing grants NEVER authorize these
//
// authorize() verifies the approval but does NOT consume it. The executor
// consumes it through the approval desk immediately before execution; that
// boundary belongs to the later orchestrator slice and is deliberately not
// built here.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CompanionPolicy = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const registryModule = (typeof require === 'function') ? require('./tool-registry') : root.CompanionToolRegistry;
  const { isCriticalName } = registryModule;

  function createPolicyEngine({ registry, approvals, emergencyStop, audit, clock } = {}) {
    if (!registry) throw new TypeError('policy engine needs a registry');
    // Optional durable audit sink (Stage B, 26 Nov 2026): when present,
    // every grant, revocation and hydrate skip lands in the durable
    // audit BEFORE the state moves (audit-first, like every other Gate 2
    // transition). A refused or throwing append refuses the transition:
    // no grant without its entry. Omitted (as in every pre-Stage-B test
    // and the current wiring, where grants have no production caller)
    // the engine behaves exactly as before.
    const now = clock || (() => Date.now());
    const grants = new Map(); // exact tool name -> grant record

    function deny(reason, extra) {
      return { allowed: false, reason, ...(extra || {}) };
    }

    // The user's explicit, exact, narrow grant. Anything broader than one
    // registered tool is refused here.
    function grantTool({ tool, capability, ttlMs, expiresAt } = {}) {
      if (typeof tool !== 'string') return { ok: false, reason: 'grant_tool_invalid' };
      if (tool === '*') return { ok: false, reason: 'wildcard_grant_refused' };
      const def = registry.get(tool);
      if (!def) return { ok: false, reason: 'unknown_tool' };
      if (def.capability === 'forbidden') return { ok: false, reason: 'forbidden_tool' };
      if (capability !== undefined && capability !== def.capability) return { ok: false, reason: 'capability_mismatch' };
      let exp = null;
      if (expiresAt !== undefined) {
        if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return { ok: false, reason: 'grant_expiry_invalid' };
        exp = expiresAt;
      } else if (ttlMs !== undefined) {
        if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0) return { ok: false, reason: 'grant_expiry_invalid' };
        exp = now() + ttlMs;
      }
      if (audit) {
        // Audit-first: the entry must be accepted BEFORE the grant exists.
        // Detail carries the tool name and expiry only, never arguments.
        const detail = exp === null ? { tool } : { tool, expires_at: exp };
        let entry = null;
        try {
          entry = audit.append({ actor: 'user', action: 'grant.granted', decision: 'allowed', detail });
        } catch (err) {
          return { ok: false, reason: 'grant_audit_failed' };
        }
        if (!entry || entry.ok !== true) return { ok: false, reason: 'grant_audit_failed' };
      }
      const record = { tool, capability: def.capability, grantedAt: now(), expiresAt: exp, revoked: false };
      grants.set(tool, record);
      return { ok: true, grant: { ...record } };
    }

    function revoke(tool) {
      if (typeof tool !== 'string' || !grants.has(tool)) return { ok: false, reason: 'no_grant' };
      if (audit) {
        let entry = null;
        try {
          entry = audit.append({ actor: 'user', action: 'grant.revoked', decision: 'allowed', detail: { tool } });
        } catch (err) {
          return { ok: false, reason: 'grant_audit_failed' };
        }
        if (!entry || entry.ok !== true) return { ok: false, reason: 'grant_audit_failed' };
      }
      grants.get(tool).revoked = true;
      return { ok: true };
    }

    function authorize({ tool, args, approvalId } = {}) {
      if (emergencyStop && emergencyStop.isActive()) return deny('stop_active');
      if (typeof tool !== 'string') return deny('unknown_tool');
      const def = registry.get(tool);
      if (!def) return deny('unknown_tool');
      if (def.capability === 'forbidden') return deny('forbidden_tool');
      // Belt and braces with the registry: a name that matches the critical
      // namespaces but is not flagged sensitive/critical can never authorize,
      // even if a registry without the registration-time check produced it.
      const criticalDeclared = def.capability === 'sensitive' || def.critical === true;
      if (isCriticalName(tool) && !criticalDeclared) return deny('critical_name_misclassified');
      const check = registry.validateArgs(tool, args);
      if (!check.ok) return deny('invalid_args', { errors: check.errors });
      const g = grants.get(tool);
      if (!g) return deny('no_grant');
      if (g.revoked) return deny('grant_revoked');
      if (g.expiresAt !== null && now() >= g.expiresAt) return deny('grant_expired');
      const critical = criticalDeclared;
      if (critical) {
        if (approvalId === undefined || approvalId === null) return deny('approval_required');
        // Fail closed (26 Nov 2026): a missing approvals desk or a verify()
        // that throws is a denial with a stable refusal record, never an
        // exception escaping the only door to tool execution.
        if (!approvals || typeof approvals.verify !== 'function') return deny('approval_desk_missing');
        let v;
        try {
          v = approvals.verify(approvalId, { tool, args });
        } catch (err) {
          return deny('approval_desk_error');
        }
        if (!v.ok) return deny('approval_invalid', { approvalReason: v.reason });
      }
      const grant = { tool: g.tool, capability: g.capability, grantedAt: g.grantedAt, expiresAt: g.expiresAt };
      return critical
        ? { allowed: true, tool, capability: def.capability, critical, grant, approvalId }
        : { allowed: true, tool, capability: def.capability, critical, grant };
    }

    return {
      grantTool,
      revoke,
      authorize,
      listGrants: () => [...grants.values()].map((g) => ({ ...g })),
      // Persisted-state surface: restore grants exactly as saved, including
      // expiry and revocation. Every row is re-validated against the registry
      // before it is trusted; anything that fails validation is refused
      // (reported in skipped) rather than silently repaired.
      hydrateGrants(records) {
        const list = Array.isArray(records) ? records : [];
        // Two passes keep audit-first ordering: every row is validated
        // BEFORE anything is applied, the skip entry (one bounded system
        // entry, never one per row) is accepted, and only then does any
        // grant come back. A refused or throwing append refuses the whole
        // hydrate and restores nothing.
        const valid = [];
        let skipped = 0;
        for (const g of list) {
          if (!g || typeof g.tool !== 'string') { skipped += 1; continue; }
          const def = registry.get(g.tool);
          if (!def || g.capability !== def.capability) { skipped += 1; continue; }
          if (!Number.isFinite(g.grantedAt) || !(g.expiresAt === null || Number.isFinite(g.expiresAt)) || typeof g.revoked !== 'boolean') { skipped += 1; continue; }
          valid.push({ tool: g.tool, capability: g.capability, grantedAt: g.grantedAt, expiresAt: g.expiresAt, revoked: g.revoked });
        }
        if (audit && skipped > 0) {
          let entry = null;
          try {
            entry = audit.append({ actor: 'system', action: 'grant.hydrate_skipped', detail: { skipped } });
          } catch (err) {
            return { ok: false, reason: 'grant_hydrate_audit_failed' };
          }
          if (!entry || entry.ok !== true) return { ok: false, reason: 'grant_hydrate_audit_failed' };
        }
        for (const g of valid) grants.set(g.tool, { ...g });
        return { ok: true, restored: valid.length, skipped };
      },
    };
  }

  return { createPolicyEngine };
});
