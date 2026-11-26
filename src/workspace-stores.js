/**
 * Gate 8 row stores (Ninad's 26 Nov 2026 decision A): owning row stores
 * for files/folders, local databases, structured app data, workflow/task
 * data, model/AI views. PURE in-memory containers: rows arrive ONLY
 * through explicit add() calls from a real app feature or the user, so
 * nothing auto-scans the filesystem and nothing auto-exposes itself; the
 * workspace panel shows a store only when main wires it to a view
 * explicitly. Rows are frozen copies; the store is bounded; search is a
 * bounded case-insensitive substring match over the string fields. No
 * persistence in this slice: stores reset with the process, and nothing
 * here claims otherwise.
 */
'use strict';

var MAX_FIELD_STRING = 200;
var MAX_QUERY = 100;
var MAX_SEARCH_RESULTS = 25;
var DEFAULT_MAX_ROWS = 500;

function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  var proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function createWorkspaceStore(opts) {
  if (!isPlainObject(opts)) throw new Error('workspace store requires options');
  if (typeof opts.name !== 'string' || opts.name.length === 0) throw new Error('workspace store requires a name');
  if (typeof opts.prefix !== 'string' || !/^[a-z]{1,3}$/.test(opts.prefix)) throw new Error('workspace store requires a 1-3 letter prefix');
  if (!Array.isArray(opts.fields) || opts.fields.length === 0 || opts.fields.some(function (f) { return typeof f !== 'string'; })) {
    throw new Error('workspace store requires a fields array');
  }
  var clock = opts.clock || function () { return Date.now(); };
  var maxRows = typeof opts.maxRows === 'number' && Number.isSafeInteger(opts.maxRows) && opts.maxRows > 0 ? opts.maxRows : DEFAULT_MAX_ROWS;
  var fields = opts.fields.slice();
  var fieldSet = Object.create(null);
  fields.forEach(function (f) { fieldSet[f] = true; });
  var enums = isPlainObject(opts.enums) ? opts.enums : {};
  // Optional per-field type contract: a field named here must hold exactly
  // that type (null/undefined stay allowed as "absent").
  var types = isPlainObject(opts.types) ? opts.types : {};

  var rows = [];
  var seq = 0;

  function add(row) {
    if (!isPlainObject(row)) return { ok: false, reason: 'row_invalid' };
    for (var k in row) {
      if (!fieldSet[k]) return { ok: false, reason: 'unknown_field:' + k };
      var v = row[k];
      if (v === null || v === undefined) continue;
      var t = typeof v;
      if (t !== 'string' && t !== 'number' && t !== 'boolean') return { ok: false, reason: 'wrong_type:' + k };
      var want = types[k];
      if (want && t !== want) return { ok: false, reason: 'wrong_type:' + k };
      if (t === 'string' && v.length === 0) return { ok: false, reason: 'empty_string:' + k };
      if (t === 'string' && v.length > MAX_FIELD_STRING) return { ok: false, reason: 'string_too_long:' + k };
      if (t === 'number' && !Number.isSafeInteger(v)) return { ok: false, reason: 'wrong_type:' + k };
      var allowed = enums[k];
      if (allowed && t === 'string' && allowed.indexOf(v) === -1) return { ok: false, reason: 'value_not_allowed:' + k };
    }
    if (rows.length >= maxRows) return { ok: false, reason: 'store_full' };
    seq += 1;
    var stored = Object.freeze(Object.assign({ id: opts.prefix + seq }, row, { id: opts.prefix + seq }));
    rows.push(stored);
    return { ok: true, row: stored, at: clock() };
  }

  function get(id) {
    for (var i = 0; i < rows.length; i++) if (rows[i].id === id) return rows[i];
    return undefined;
  }

  function remove(id) {
    var row = get(id);
    if (!row) return { ok: false, reason: 'unknown_id' };
    rows = rows.filter(function (r) { return r.id !== id; });
    return { ok: true, row: row };
  }

  function list() {
    return rows.slice();
  }

  function search(q) {
    if (typeof q !== 'string') return { ok: false, reason: 'query_invalid' };
    if (q.length > MAX_QUERY) return { ok: false, reason: 'query_too_long' };
    if (q.length === 0) return [];
    var needle = q.toLowerCase();
    var out = [];
    for (var i = 0; i < rows.length && out.length < MAX_SEARCH_RESULTS; i++) {
      var r = rows[i];
      for (var j = 0; j < fields.length; j++) {
        var v = r[fields[j]];
        if (typeof v === 'string' && v.toLowerCase().indexOf(needle) !== -1) { out.push(r); break; }
      }
    }
    return out;
  }

  return { name: opts.name, add: add, get: get, remove: remove, list: list, search: search };
}

module.exports = { createWorkspaceStore: createWorkspaceStore };
