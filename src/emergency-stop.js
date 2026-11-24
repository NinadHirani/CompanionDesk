'use strict';

// Gate 2 slice 1: the emergency stop. One global state for the whole
// agent-foundation layer: while it is active, EVERY tool authorization is
// refused, read-only included, no matter what grants or approvals exist. It
// can only be reset by an explicit user action: a reset attempt that does
// not name the user is refused and changes nothing.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CompanionEmergencyStop = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  const ACTORS = ['user', 'agent', 'system'];

  function createEmergencyStop() {
    let active = false;
    let reason = null;
    let activatedAt = null;
    let activatedBy = null;
    let resetCount = 0;
    return {
      activate(why, { by } = {}) {
        if (typeof why !== 'string' || why.length === 0 || why.length > 200) return { ok: false, reason: 'bad_reason' };
        if (typeof by !== 'string' || !ACTORS.includes(by)) return { ok: false, reason: 'bad_actor' };
        active = true;
        reason = why;
        activatedAt = new Date().toISOString();
        activatedBy = by;
        return { ok: true };
      },
      reset({ by } = {}) {
        if (typeof by !== 'string' || by !== 'user') return { ok: false, reason: 'reset_requires_user' };
        if (!active) return { ok: false, reason: 'not_active' };
        active = false;
        reason = null;
        activatedAt = null;
        activatedBy = null;
        resetCount += 1;
        return { ok: true };
      },
      isActive() { return active; },
      snapshot() { return { active, reason, activatedAt, activatedBy, resetCount }; },
      // Restore the persisted stop state. An active stop at shutdown comes
      // back active; reset requires a real reset call, never a restart.
      hydrate(snap) {
        if (!snap || typeof snap !== 'object') return { ok: false, reason: 'invalid_snapshot' };
        if (typeof snap.active !== 'boolean' || !Number.isInteger(snap.resetCount) || snap.resetCount < 0) {
          return { ok: false, reason: 'invalid_snapshot' };
        }
        if (snap.active) {
          if (typeof snap.reason !== 'string' || !snap.reason || snap.reason.length > 200) {
            return { ok: false, reason: 'invalid_snapshot' };
          }
          active = true;
          reason = snap.reason;
          activatedAt = typeof snap.activatedAt === 'string' ? snap.activatedAt : null;
          activatedBy = typeof snap.activatedBy === 'string' ? snap.activatedBy : null;
        } else {
          if (snap.reason !== undefined && snap.reason !== null) return { ok: false, reason: 'invalid_snapshot' };
          active = false;
          reason = null;
        }
        resetCount = snap.resetCount;
        return { ok: true };
      },
    };
  }

  return { createEmergencyStop, ACTORS };
});
