(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CompanionFileOutputConfig = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // File-output root config core (28 Nov 2026, under Ninad's standing
  // authorization): the pure validation/store policy for the file_write
  // gate's root folder setting (file_output_root on the agent-state
  // store). The Workspace panel's explicit control is the only surface
  // that reaches it; the renderer and the model can never set or widen
  // the root on their own. An unset (or cleared) root keeps every
  // file_write call refused (file_output_root_unconfigured), exactly as
  // the file-output enable shipped it.

  var MAX_ROOT_LENGTH = 512;
  // An absolute POSIX path, or a Windows drive-letter path (C:\ or C:/).
  var ABSOLUTE_PATH = /^([A-Za-z]:[\/\\]|\/)/;
  var CONTROL = /[\u0000-\u001f\u007f]/;

  function createFileOutputRootConfig(opts) {
    var getSetting = opts && opts.getSetting;
    var setSetting = opts && opts.setSetting;
    if (typeof getSetting !== 'function' || typeof setSetting !== 'function') {
      throw new Error('file-output root config requires getSetting and setSetting');
    }

    function read() {
      var raw = null;
      try { raw = getSetting('file_output_root', ''); } catch (e) { raw = null; }
      var trimmed = typeof raw === 'string' ? raw.trim() : '';
      return { ok: true, configured: !!trimmed, root: trimmed || null };
    }

    function set(root) {
      // Clear: back to the unset default; every file_write call refuses
      // again until a folder is configured.
      if (root === undefined || root === null || (typeof root === 'string' && root.trim() === '')) {
        try { setSetting('file_output_root', ''); } catch (e) { return { ok: false, reason: 'setting_failed' }; }
        return { ok: true, configured: false, root: null };
      }
      if (typeof root !== 'string') return { ok: false, reason: 'bad_root' };
      var trimmed = root.trim();
      if (!trimmed.length || trimmed.length > MAX_ROOT_LENGTH) return { ok: false, reason: 'bad_root' };
      if (CONTROL.test(trimmed)) return { ok: false, reason: 'bad_root' };
      if (!ABSOLUTE_PATH.test(trimmed)) return { ok: false, reason: 'bad_root' };
      try { setSetting('file_output_root', trimmed); } catch (e) { return { ok: false, reason: 'setting_failed' }; }
      return { ok: true, configured: true, root: trimmed };
    }

    return { get: read, set: set };
  }

  return { createFileOutputRootConfig: createFileOutputRootConfig, MAX_ROOT_LENGTH: MAX_ROOT_LENGTH };
});
