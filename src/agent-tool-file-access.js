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
    // Execution slice (26 Nov 2026): with an io adapter the tool performs
    // the real filesystem operation THROUGH the policy. The adapter is
    // injected (tests use a fake; main.js wires the real fs), so the tool
    // never reaches for the OS itself. Without one it stays policy-only
    // and claims no execution.
    var io = opts && opts.io ? opts.io : null;
    var MAX_WRITE_BYTES = 65536; // same byte cap as the file-output gate
    var IO_METHODS = { read: 'readFile', list: 'listDir', write: 'writeFile', delete: 'deletePath', mkdir: 'mkdir' };

    function osError(err, action, target, attempted) {
      // Surface the OS reason verbatim: code and message, nothing invented.
      return {
        ok: false, action: action, target: target,
        performed: attempted === true,
        reason: 'os_error',
        code: String((err && err.code) || ''),
        message: String((err && err.message) || String(err)),
      };
    }

    function finish(d, args) {
      var p;
      if (d.action === 'write') {
        var content = args.content;
        if (Buffer.byteLength(content, 'utf8') > MAX_WRITE_BYTES) {
          return { ok: false, action: 'write', target: d.target, performed: false, reason: 'content_too_large', maxBytes: MAX_WRITE_BYTES };
        }
        p = io.writeFile(d.target, content).then(
          function (bytes) {
            return { ok: true, action: 'write', target: d.target, performed: true, bytes: bytes === undefined ? Buffer.byteLength(content, 'utf8') : bytes };
          },
          function (err) { return osError(err, 'write', d.target, true); });
        return p;
      }
      p = io[IO_METHODS[d.action]](d.target).then(
        function (out) {
          if (d.action === 'read') return { ok: true, action: 'read', target: d.target, performed: true, content: out };
          if (d.action === 'list') return { ok: true, action: 'list', target: d.target, performed: true, entries: out };
          return { ok: true, action: d.action, target: d.target, performed: true };
        },
        function (err) { return osError(err, d.action, d.target, true); });
      return p;
    }

    function exec(args) {
      if (!io) return decide(args); // policy-only: no execution, no performed flag
      var hint = args && typeof args === 'object' ? args.existsHint : undefined;
      var d = decide(args);
      if (!d.ok) {
        // Target visibility: before refusing a write as an overwrite with
        // no existence hint, probe the real state once and re-decide. A
        // genuinely new path proceeds; an existing one still demands
        // confirmed. The probe itself never writes anything.
        if (d.reason === 'overwrite_requires_confirmation' && hint === undefined && typeof io.exists === 'function') {
          return io.exists(d.target).then(
            function (really) {
              var d2 = decide(Object.assign({}, args, { existsHint: !!really }));
              if (d2.ok) return finish(d2, args);
              return d2;
            },
            function (err) { return osError(err, 'write', d.target, true); });
        }
        return d;
      }
      return finish(d, args);
    }

    return {
      definition: FILE_ACCESS_TOOL_DEFINITION,
      SANDBOX_NOTE: SANDBOX_NOTE,
      // Policy first, execution second: every operation runs through
      // decide(), a refusal never reaches the io layer, and an OS refusal
      // surfaces verbatim instead of being swallowed.
      execute: function (args) { return exec(args); },
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
