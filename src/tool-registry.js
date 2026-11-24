'use strict';

// Gate 2 slice 1: typed tool registry. Pure: no fs, no network, no timers,
// no model. It holds immutable tool definitions and validates arguments
// against each definition's strict schema. It authorizes nothing by itself;
// the policy engine decides. Until Gate 2 acceptance, NO real tool is
// registered anywhere in the app: this module ships empty and only test
// fixtures define tools.
//
// Rules:
//  1. Capability classes are exactly read_only, reversible_write, sensitive,
//     forbidden. Payment, purchase, destructive-deletion and legal/binding
//     tools must be defined as 'sensitive' (the policy engine then requires a
//     fresh one-time approval for every execution and never accepts a
//     standing grant for them). A definition with any other capability is
//     refused.
//  2. A definition is immutable once defined: every object is deeply frozen
//     and redefining a name is refused.
//  3. Argument validation is strict: no coercion, no defaults, no unknown
//     fields, no prototype-polluting keys, bounded sizes. An argument set
//     that is not exactly what the schema declares is rejected with reason
//     codes, never silently repaired.
//  4. Validation never executes anything; it reads definitions only.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CompanionToolRegistry = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const digestModule = (typeof require === 'function') ? require('./digest') : root.CompanionDigest;
  const { plainDataProblem } = digestModule;

  const CAPABILITIES = ['read_only', 'reversible_write', 'sensitive', 'forbidden'];
  const NAME_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){0,3}$/;
  const TYPES = ['string', 'number', 'integer', 'boolean', 'string_array'];

  const LIMITS = {
    name: 64,
    description: 400,
    maxFields: 16,
    maxString: 500,
    maxArray: 32,
    maxProperties: 32,
    maxEnum: 16,
  };

  // Conservative, explicit critical-name matching. Tool names in these
  // namespaces, or with a segment naming a destructive deletion, are
  // CRITICAL actions (payments/purchases, destructive deletion, legal or
  // binding submissions). The registry refuses to register such a tool
  // unless it is defined as capability 'sensitive' or flagged critical:true,
  // and the policy engine separately refuses to authorize any misclassified
  // one that somehow exists, so a misclassification can neither be created
  // nor executed. Matching is deliberate and over-broad in coverage, narrow
  // in mechanism: extend these explicit lists, never pattern-guess new
  // shapes, and when in doubt a name is treated as critical (fail closed).
  const CRITICAL_NAMESPACES = new Set([
    'payments', 'payment', 'purchases', 'purchase', 'checkout', 'billing',
    'legal', 'compliance', 'signature', 'signatures', 'filing', 'filings',
    'contract', 'contracts', 'submission', 'submissions', 'deletion',
  ]);
  const DESTRUCTIVE_DELETE_PREFIXES = ['delete', 'destroy', 'erase', 'wipe', 'purge', 'permanen'];

  function isCriticalName(name) {
    if (typeof name !== 'string') return false;
    const segments = name.split('.');
    if (CRITICAL_NAMESPACES.has(segments[0])) return true;
    return segments.some((seg) => DESTRUCTIVE_DELETE_PREFIXES.some((p) => seg.startsWith(p)));
  }

  function isPlainObject(v) {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
  }

  function deepFreeze(v) {
    if (v && typeof v === 'object') {
      for (const k of Object.keys(v)) deepFreeze(v[k]);
      Object.freeze(v);
    }
    return v;
  }

  const DEF_FIELDS = ['name', 'description', 'capability', 'schema', 'critical'];
  const SPEC_FIELDS = ['type', 'description', 'required', 'enum', 'maxLength', 'maxItems'];

  function validateDefinition(def) {
    if (!isPlainObject(def)) return ['definition_not_object'];
    const errors = [];
    for (const k of Object.keys(def)) {
      if (!DEF_FIELDS.includes(k)) errors.push('unknown_definition_field:' + k);
    }
    if (typeof def.name !== 'string' || !NAME_RE.test(def.name) || def.name.length > LIMITS.name) errors.push('bad_name');
    if (typeof def.description !== 'string' || def.description.length === 0 || def.description.length > LIMITS.description) errors.push('bad_description');
    if (typeof def.capability !== 'string' || !CAPABILITIES.includes(def.capability)) errors.push('bad_capability');
    if (def.critical !== undefined && typeof def.critical !== 'boolean') errors.push('bad_critical');
    if (isCriticalName(def.name) && def.capability === 'sensitive' === false && def.critical !== true) {
      errors.push('critical_name_requires_sensitive_or_critical');
    }
    if (!isPlainObject(def.schema)) return errors.concat(['bad_schema']);
    for (const k of Object.keys(def.schema)) {
      if (k !== 'properties') errors.push('unknown_schema_field:' + k);
    }
    if (!isPlainObject(def.schema.properties) || Object.keys(def.schema.properties).length > LIMITS.maxFields) {
      return errors.concat(['bad_schema_properties']);
    }
    for (const [field, spec] of Object.entries(def.schema.properties)) {
      if (!/^[a-z][a-z0-9_]{0,31}$/.test(field)) { errors.push('bad_field_name:' + field); continue; }
      if (!isPlainObject(spec)) { errors.push('bad_field_spec:' + field); continue; }
      for (const sk of Object.keys(spec)) {
        if (!SPEC_FIELDS.includes(sk)) errors.push('unknown_field_option:' + field + '.' + sk);
      }
      if (typeof spec.type !== 'string' || !TYPES.includes(spec.type)) errors.push('bad_field_type:' + field);
      if (spec.description !== undefined && (typeof spec.description !== 'string' || spec.description.length > LIMITS.description)) errors.push('bad_field_description:' + field);
      if (spec.required !== undefined && spec.required !== true) errors.push('bad_field_required:' + field);
      if (spec.maxLength !== undefined && (typeof spec.maxLength !== 'number' || !Number.isInteger(spec.maxLength) || spec.maxLength < 1 || spec.maxLength > LIMITS.maxString)) errors.push('bad_field_maxLength:' + field);
      if (spec.maxItems !== undefined && (typeof spec.maxItems !== 'number' || !Number.isInteger(spec.maxItems) || spec.maxItems < 1 || spec.maxItems > LIMITS.maxArray)) errors.push('bad_field_maxItems:' + field);
      if (spec.enum !== undefined && (!Array.isArray(spec.enum) || spec.enum.length === 0 || spec.enum.length > LIMITS.maxEnum || spec.enum.some((e) => typeof e !== 'string' || e.length > 64))) errors.push('bad_field_enum:' + field);
    }
    return errors;
  }

  const FORBIDDEN_ARG_KEYS = ['__proto__', 'constructor', 'prototype'];

  function validateArgsAgainst(def, args) {
    if (args === undefined || args === null) return ['args_missing'];
    if (!isPlainObject(args)) return ['args_not_object'];
    // Only plain JSON-like data passes: symbol keys, non-enumerable
    // properties, accessors, sparse arrays and arrays with extra properties
    // are refused up front, so a caller can never smuggle structure the
    // schema never declared.
    const argsProblem = plainDataProblem(args);
    if (argsProblem) return ['args_not_plain_data:' + argsProblem];
    const errors = [];
    const fields = def.schema.properties;
    const argKeys = Object.keys(args);
    if (argKeys.length > Object.keys(fields).length) errors.push('too_many_fields');
    for (const k of argKeys) {
      if (FORBIDDEN_ARG_KEYS.includes(k)) { errors.push('forbidden_field:' + k); continue; }
      if (!Object.prototype.hasOwnProperty.call(fields, k)) { errors.push('unknown_field:' + k); continue; }
      const spec = fields[k];
      const v = args[k];
      const vProblem = plainDataProblem(v);
      if (vProblem) { errors.push('unsupported_value:' + k + ':' + vProblem); continue; }
      switch (spec.type) {
        case 'string': {
          if (typeof v !== 'string') { errors.push('wrong_type:' + k); break; }
          const max = spec.maxLength !== undefined ? spec.maxLength : LIMITS.maxString;
          if (v.length > max) { errors.push('string_too_long:' + k); break; }
          if (spec.enum && !spec.enum.includes(v)) errors.push('value_not_allowed:' + k);
          break;
        }
        case 'number':
          if (typeof v !== 'number' || !Number.isFinite(v)) errors.push('wrong_type:' + k);
          break;
        case 'integer':
          if (typeof v !== 'number' || !Number.isInteger(v) || !Number.isFinite(v)) errors.push('wrong_type:' + k);
          break;
        case 'boolean':
          if (typeof v !== 'boolean') errors.push('wrong_type:' + k);
          break;
        case 'string_array': {
          if (!Array.isArray(v)) { errors.push('wrong_type:' + k); break; }
          const max = spec.maxItems !== undefined ? spec.maxItems : LIMITS.maxArray;
          if (v.length > max) { errors.push('array_too_long:' + k); break; }
          if (v.some((e) => typeof e !== 'string' || e.length > LIMITS.maxString)) errors.push('array_element_wrong_type:' + k);
          break;
        }
        default:
          errors.push('bad_field_type:' + k);
      }
    }
    for (const [field, spec] of Object.entries(fields)) {
      if (spec.required === true && !Object.prototype.hasOwnProperty.call(args, field)) errors.push('missing_field:' + field);
    }
    return errors;
  }

  function createRegistry() {
    const byName = new Map();
    return {
      define(def) {
        const errors = validateDefinition(def);
        if (errors.length) return { ok: false, errors };
        if (byName.has(def.name)) return { ok: false, errors: ['duplicate_name'] };
        const stored = deepFreeze({
          name: def.name,
          description: def.description,
          capability: def.capability,
          critical: def.critical === true,
          schema: deepFreeze(JSON.parse(JSON.stringify(def.schema))),
        });
        byName.set(def.name, stored);
        return { ok: true };
      },
      has(name) { return typeof name === 'string' && byName.has(name); },
      get(name) { return typeof name === 'string' ? (byName.get(name) || null) : null; },
      list() { return [...byName.values()]; },
      validateArgs(name, args) {
        const def = typeof name === 'string' ? byName.get(name) : null;
        if (!def) return { ok: false, errors: ['unknown_tool'] };
        const errors = validateArgsAgainst(def, args);
        return errors.length ? { ok: false, errors } : { ok: true, errors: [] };
      },
    };
  }

  return { CAPABILITIES, createRegistry, validateDefinition, isCriticalName, LIMITS };
});
