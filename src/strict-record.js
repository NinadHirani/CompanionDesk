'use strict';

// Shared strict record validation for the agent persistence surfaces.
//
// plainRecords(value): value must be a real Array with no holes, and every
// element must be a plain object (prototype Object.prototype or null) whose
// own properties are all string-keyed, enumerable, writable, configurable
// data descriptors holding non-function values. Symbols, accessors,
// non-enumerables and non-writables are refused. Descriptors are inspected
// BEFORE any value is read, so a hostile getter is never invoked and a
// proxy never gets the chance to run code on property access.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CompanionStrictRecord = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  function plainRecords(value) {
    if (!Array.isArray(value)) return { ok: false, reason: 'not_array' };
    for (let i = 0; i < value.length; i++) {
      if (!(i in value)) return { ok: false, reason: 'sparse_array', index: i };
      const r = value[i];
      if (r === null || typeof r !== 'object' || Array.isArray(r)) {
        return { ok: false, reason: 'not_plain_record', index: i };
      }
      const proto = Object.getPrototypeOf(r);
      if (proto !== Object.prototype && proto !== null) {
        return { ok: false, reason: 'not_plain_record', index: i };
      }
      if (Object.getOwnPropertySymbols(r).length) {
        return { ok: false, reason: 'symbol_key', index: i };
      }
      const descs = Object.getOwnPropertyDescriptors(r);
      for (const name of Object.getOwnPropertyNames(r)) {
        const d = descs[name];
        // Accessors (get/set) have no value and no writable: refused before
        // anything is read. Non-enumerables, non-writables and
        // non-configurables are refused: persisted records are plain data.
        if (!('value' in d) || d.get !== undefined || d.set !== undefined) {
          return { ok: false, reason: 'accessor_property', index: i, key: name };
        }
        if (!d.enumerable || d.writable !== true || d.configurable !== true) {
          return { ok: false, reason: 'bad_descriptor', index: i, key: name };
        }
        if (typeof d.value === 'function') {
          return { ok: false, reason: 'function_value', index: i, key: name };
        }
      }
    }
    return { ok: true, records: value };
  }

  // Strict SQLite integer flags: exactly 0 or 1. Truthy coercion is never
  // used: a stored 2, a string '1' or a float 1.0-from-text all refuse.
  function strictFlag(value) {
    if (value === 0) return false;
    if (value === 1) return true;
    return null;
  }

  // Bounded integer timestamps: a safe integer inside a sane calendar range
  // (1970-01-02 .. 2100-01-01). Floats, strings and negatives refuse.
  const TS_MIN = 86400000;      // 1970-01-02T00:00:00Z
  const TS_MAX = 4102444800000; // 2100-01-01T00:00:00Z
  function strictTimestamp(value) {
    if (Number.isSafeInteger(value) && value >= TS_MIN && value <= TS_MAX) return value;
    return null;
  }

  return { plainRecords, strictFlag, strictTimestamp, TS_MIN, TS_MAX };
});
