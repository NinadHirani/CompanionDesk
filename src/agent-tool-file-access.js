/**
 * Gate 4 file-access policy core (Ninad's decision C, 26 Nov 2026):
 * broad filesystem access where the OS allows it, implemented with
 * safeguards. This module is PURE policy: it decides and displays the
 * real target, it NEVER touches the filesystem and never performs an
 * operation. The execution slice (a later step on the approved roadmap)
 * wires real fs calls THROUGH these decisions; until then nothing here
 * can read or write anything.
 *
 * Safeguards implemented here:
 *   - Target visibility: every decision names the normalized absolute
 *     target path, including inside refusals.
 *   - Destructive confirmation: a write to an existing path (or one whose
 *     existence is unknown) needs confirmed=true; a delete ALWAYS needs
 *     confirmed=true. No default path destroys anything silently.
 *   - OS sandbox respect: the policy never claims to bypass OS sandbox or
 *     permissions (see SANDBOX_NOTE); when the OS refuses, the execution
 *     layer surfaces the OS's own reason.
 *   - Scoped roots start unset by default and stay optional (broad access
 *     is the approved mode); roots() shows what is set, nothing auto-set.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CompanionAgentToolFileAccess = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SANDBOX_NOTE = 'File operations always run inside the OS sandbox and its permissions; this policy never bypasses them. When the OS refuses an operation, the OS\'s own reason is surfaced unchanged.';

  var ACTIONS = ['read', 'list', 'write', 'delete', 'mkdir'];

  var FILE_ACCESS_TOOL_DEFINITION = {
    name: 'file_access',
    description: 'read, list, write or delete one file path; destructive actions need an explicit confirm argument (Gate 4 approved 26 Nov 2026)',
    capability: 'sensitive',
    critical: false,
    schema: {
      properties: {
        action: { type: 'string', required: true, maxLength: 8, enum: ACTIONS },
        path: { type: 'string', required: true, maxLength: 500 },
        content: { type: 'string', maxLength: 500 },
        confirmed: { type: 'boolean' },
      },
    },
  };

  function isPlainObject(v) {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
    var proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
  }

  function hasControlChar(p) {
    for (var i = 0; i < p.length; i++) {
      var c = p.charCodeAt(i);
      if (c < 32 || c === 127) return true;
    }
    return false;
  }

  // Pure path normalization: collapses backslashes on drive-letter paths,
  // collapses doubled slashes and dot segments, keeps a single trailing
  // slash for root. No filesystem access of any kind.
  function normalizePath(raw) {
    var p = raw;
    var drive = null;
    var m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
    if (m) {
      drive = m[1].toUpperCase() + ':/';
      p = '/' + m[2];
    }
    p = p.replace(/\\/g, '/');
    var segs = p.split('/');
    var out = [];
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (s === '' || s === '.') continue;
      if (s === '..') {
        if (out.length > 0) out.pop();
        continue; // .. above the root stays at the root
      }
      out.push(s);
    }
    var joined = drive ? drive + out.join('/') : '/' + out.join('/');
    return joined;
  }

  function isAbsolute(p) {
    if (p.charAt(0) === '/') return true;
    return /^([A-Za-z]):[\\/]/.test(p);
  }

  function decide(args) {
    if (!isPlainObject(args)) return { ok: false, reason: 'args_invalid' };
    var action = args.action;
    if (typeof action !== 'string' || ACTIONS.indexOf(action) === -1) return { ok: false, reason: 'unknown_action' };
    var raw = args.path;
    if (typeof raw !== 'string' || raw.length === 0) return { ok: false, reason: 'path_must_be_absolute' };
    if (raw.indexOf('\u0000') !== -1 || hasControlChar(raw)) return { ok: false, reason: 'path_invalid' };
    if (raw.length > 500) return { ok: false, reason: 'path_too_long' };
    if (!isAbsolute(raw)) return { ok: false, reason: 'path_must_be_absolute' };
    var target = normalizePath(raw);
    var existsHint = args.existsHint;
    if (existsHint !== undefined && typeof existsHint !== 'boolean') return { ok: false, reason: 'args_invalid' };
    var confirmed = args.confirmed === true;

    var base = { ok: true, action: action, target: target, confirmed: confirmed, requiresConfirmation: false };

    if (action === 'write') {
      // Unknown existence counts as existing: the safe default.
      var overwrite = existsHint !== false;
      if (overwrite && !confirmed) {
        return { ok: false, action: action, target: target, reason: 'overwrite_requires_confirmation', requiresConfirmation: true };
      }
      base.requiresConfirmation = overwrite;
      return base;
    }
    if (action === 'delete') {
      if (!confirmed) {
        return { ok: false, action: action, target: target, reason: 'delete_requires_confirmation', requiresConfirmation: true };
      }
      base.requiresConfirmation = true;
      return base;
    }
    if (action === 'mkdir') {
      if (existsHint === true) base.changesNothing = true;
      return base;
    }
    return base; // read, list
  }

  function createFileAccessPolicy(opts) {
    opts = opts || {};
    // Scoped roots: unset by default, optional forever. Setting one is a
    // future scoping step, never a default.
    var roots = Object.create(null);
    return {
      propose: function (args) { return decide(args); },
      roots: function () { return Object.assign({}, roots); },
      SANDBOX_NOTE: SANDBOX_NOTE,
    };
  }

  function createFileAccessTool(opts) {
    var inst = createFileAccessPolicy(opts);
    return {
      definition: FILE_ACCESS_TOOL_DEFINITION,
      SANDBOX_NOTE: SANDBOX_NOTE,
      // Policy decision only: no filesystem work happens here. The
      // execution slice performs the real op through the policy.
      execute: function (args) { return decide(args); },
      propose: inst.propose,
      roots: inst.roots,
    };
  }

  return {
    createFileAccessPolicy: createFileAccessPolicy,
    createFileAccessTool: createFileAccessTool,
    FILE_ACCESS_TOOL_DEFINITION: FILE_ACCESS_TOOL_DEFINITION,
    SANDBOX_NOTE: SANDBOX_NOTE,
  };
});
