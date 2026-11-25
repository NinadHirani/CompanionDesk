'use strict';

// Dual-mode: require() in Node/Electron, window.CompanionImportErrors in the
// web/mobile build (the bridge calls CompanionImportErrors.humanizeImportError).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CompanionImportErrors = factory();
})(typeof self !== 'undefined' ? self : this, function () {

// Maps ingestion failure codes to short, actionable messages for the person
// importing. The rule underneath every message: a failed import writes
// NOTHING to the database or vault, so nothing ever needs undoing.

// Import size ceiling, shared by the desktop ingest and the web/mobile
// bridge: 5 MB of file bytes, same ceiling the calendar import enforces.
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
function isImportTooLarge(size) {
  return typeof size === 'number' && Number.isFinite(size) && size > MAX_IMPORT_BYTES;
}

const MESSAGES = {
  empty_document:
    'No readable text came out of this file (it may be a scan or image-only PDF). ' +
    'Nothing was saved. Try a text-based PDF, or paste the text into a .txt file and import that.',
  unsupported_file_type:
    'Only PDF, TXT and MD files can be imported. Nothing was saved.',
  file_too_large:
    'That file is too large (5 MB is the limit). Nothing was saved. ' +
    'Try a smaller file, or a text (.txt) export of it.',
  extraction_missing_course_name:
    'The document was read, but no course name was found in it, so it may not be a syllabus. ' +
    'Nothing was saved. Check the file and try again.',
  extraction_empty_response:
    'The model returned an empty answer, which usually means Ollama is not running or the model is not pulled. ' +
    'Nothing was saved. Start Ollama and try importing again.',
  extraction_unparseable:
    'The syllabus text was read, but the model\'s structured answer could not be parsed. ' +
    'Nothing was saved. Try importing again; if it fails twice in a row, try a cleaner PDF or add the free Gemini fallback key.',
};

function humanizeImportError(err) {
  const code = err && err.code;
  const raw = String((err && err.message) || err || '');
  if (code === 'ollama_unreachable' || /ECONNREFUSED|ENOTFOUND|fetch failed|ollama_http/i.test(raw)) {
    return 'Ollama is not reachable, so nothing could be extracted. Nothing was saved. ' +
      'Start Ollama (or check the OLLAMA_URL setting) and try importing again.';
  }
  if (code && MESSAGES[code]) return MESSAGES[code];
  return 'Import failed: ' + (raw || 'unknown error') + ' Nothing was saved.';
}
  return { humanizeImportError, MAX_IMPORT_BYTES, isImportTooLarge };
});
