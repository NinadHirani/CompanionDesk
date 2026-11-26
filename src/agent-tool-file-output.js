// Gate 2 file-output gate: the file_write tool (26 Nov 2026).
//
// The pure validation/policy layer, implemented exactly as approved in
// docs/GATE2_SCHEDULING_FILE_OUTPUT_PROPOSAL.md Part 2 (decisions D-F1,
// D-F2 and D-F3, approved by Ninad on 26 Nov 2026) and nothing more:
//
//   - capability "sensitive": the policy engine requires a FRESH one-time
//     approval for every call, digest-bound to the exact name AND content;
//     a standing grant can NEVER authorize a write on its own.
//   - ONE text file into ONE user-configured root directory. The disk I/O
//     is an INJECTED io adapter with the narrow contract
//     { exists(fullPath), realpath(fullPath), writeFileAtomic(fullPath,
//     content) }; this module NEVER requires a filesystem module, so the
//     pure layer is testable without a disk. The io adapter and the root
//     wiring arrive only with the separately-approved enable step.
//   - least-privilege root: the root is configured ONLY main-side from a
//     user setting and arrives here by injection. Default: UNSET - every
//     call is refused (file_output_root_unconfigured) even with a grant
//     and a valid approval, until the user configures a folder on the
//     product surface. The renderer and the model can never set or widen
//     the root.
//   - flat root only: the name is a strict basename,
//     /^[A-Za-z0-9][A-Za-z0-9._-]{0,126}$/, ending in an allowlisted
//     extension (.ics, .txt, .md). No separators, no leading dot, no
//     absolute paths, no subdirectories.
//   - text only: content must be valid Unicode (lone surrogates refused)
//     and at most 65536 bytes when encoded UTF-8. The tool never parses
//     content for commands and never executes it.
//   - refuse-if-exists, always: overwrite is out of scope entirely; a
//     retried step needs BOTH a fresh approval AND a different name. The
//     atomic write contract (temp file + rename in the same directory,
//     mode 0o600, no execute bit) is the io adapter's documented duty;
//     a refused write leaves at most a temp file, which the io adapter
//     removes on failure.
//   - symlink escape guard: before any write the io adapter is asked for
//     realpath(root); it must equal the configured root. The target must
//     NOT exist (a symlink at the target reads as existing), and the flat
//     pre-existing root means no intermediate component is ever created.
//   - audit: on success one entry { actor 'agent', action 'file.write',
//     tool 'file_write', decision 'allowed', detail { name, bytes } }.
//     Content is NEVER audited. An append failure is the approved failure
//     mode: the step fails (audit_append_failed) while the written file
//     remains user-visible and removable; the run's own step events still
//     record the failed attempt. Detail keys follow the audit schema's
//     lowercase rule.
//   - io failures pass through as io_refusal; every io call is guarded so
//     a throwing adapter can never crash a run.
//
// NOTHING IS REGISTERED: the production registry keeps carrying exactly
// the one scheduling-gate tool. Registering this definition into a live
// registry, the io adapter and the root wiring are the separately-approved
// enable step.
//
// Pure module: no requires, no I/O of its own, no clock of its own.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CompanionAgentToolFileOutput = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MAX_BYTES = 65536; // 64 KiB
  var NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,126}$/;
  var ALLOWED_EXTENSIONS = ['.ics', '.txt', '.md'];

  var FILE_OUTPUT_TOOL_DEFINITION = {
    name: 'file_write',
    description: "write one text file into the user's configured folder",
    capability: 'sensitive',
    critical: false,
    schema: {
      properties: {
        name: { type: 'string', required: true, maxLength: 128 },
        // No maxLength here: the registry's global string cap (500 chars)
        // applies at validation time. The approved 64 KiB BYTE cap is the
        // adapter's own authoritative check below (bytes, not chars), so
        // adapter-level use honours the design limit exactly.
        content: { type: 'string', required: true },
      },
    },
  };

  function isPlainObject(v) {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
    var proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
  }

  function hasLoneSurrogate(s) {
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c >= 0xD800 && c <= 0xDBFF) {
        if (i + 1 >= s.length) return true;
        var n = s.charCodeAt(i + 1);
        if (!(n >= 0xDC00 && n <= 0xDFFF)) return true;
        i++;
      } else if (c >= 0xDC00 && c <= 0xDFFF) {
        return true;
      }
    }
    return false;
  }

  function utf8ByteLength(s) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s).length;
    var bytes = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.codePointAt(i);
      if (c > 0xFFFF) i++;
      if (c <= 0x7F) bytes += 1;
      else if (c <= 0x7FF) bytes += 2;
      else if (c <= 0xFFFF) bytes += 3;
      else bytes += 4;
    }
    return bytes;
  }

  function endsWithAllowedExtension(name) {
    for (var i = 0; i < ALLOWED_EXTENSIONS.length; i++) {
      var ext = ALLOWED_EXTENSIONS[i];
      if (name.length >= ext.length && name.slice(-ext.length) === ext) return true;
    }
    return false;
  }

  function createFileOutputTool(opts) {
    var io = opts && opts.io;
    var clock = (opts && opts.clock) || function () { return Date.now(); };
    var audit = opts && opts.audit; // optional injected audit log
    var root = opts ? opts.root : undefined;
    if (!io || typeof io.exists !== 'function' || typeof io.realpath !== 'function' ||
        typeof io.writeFileAtomic !== 'function') {
      throw new Error('file-output tool requires an io adapter (exists, realpath, writeFileAtomic)');
    }

    function execute(args) {
      if (!isPlainObject(args)) return { ok: false, reason: 'args_invalid' };
      if (typeof args.name !== 'string' || !NAME_RE.test(args.name)) {
        return { ok: false, reason: 'name_invalid' };
      }
      if (!endsWithAllowedExtension(args.name)) return { ok: false, reason: 'ext_not_allowed' };
      if (typeof args.content !== 'string') return { ok: false, reason: 'content_not_text' };
      if (hasLoneSurrogate(args.content)) return { ok: false, reason: 'content_not_text' };
      var bytes = utf8ByteLength(args.content);
      if (bytes > MAX_BYTES) return { ok: false, reason: 'content_too_large' };

      // Least privilege: an unset root fails closed for EVERY call.
      if (!root || typeof root !== 'string') {
        return { ok: false, reason: 'file_output_root_unconfigured' };
      }

      // Symlink escape guard: the configured root must resolve to itself.
      var real;
      try {
        real = io.realpath(root);
      } catch (err) {
        return { ok: false, reason: 'io_refusal' };
      }
      if (real === null || real === undefined) return { ok: false, reason: 'root_missing' };
      if (real !== root) return { ok: false, reason: 'root_realpath_mismatch' };

      var fullPath = root + '/' + args.name;
      var exists;
      try {
        exists = io.exists(fullPath);
      } catch (err) {
        return { ok: false, reason: 'io_refusal' };
      }
      if (exists) return { ok: false, reason: 'file_exists' };

      try {
        io.writeFileAtomic(fullPath, args.content);
      } catch (err) {
        return { ok: false, reason: 'io_refusal' };
      }

      if (audit) {
        var entry = audit.append({
          actor: 'agent',
          action: 'file.write',
          tool: FILE_OUTPUT_TOOL_DEFINITION.name,
          decision: 'allowed',
          detail: { name: args.name, bytes: bytes },
        });
        if (!entry || entry.ok !== true) {
          // Approved failure mode: the step fails; the written file remains
          // user-visible and removable on the product surface.
          return { ok: false, reason: 'audit_append_failed' };
        }
      }

      return { ok: true, file: { name: args.name, bytes: bytes } };
    }

    return { definition: FILE_OUTPUT_TOOL_DEFINITION, execute: execute };
  }

  return {
    createFileOutputTool: createFileOutputTool,
    FILE_OUTPUT_TOOL_DEFINITION: FILE_OUTPUT_TOOL_DEFINITION,
    MAX_BYTES: MAX_BYTES,
  };
});
