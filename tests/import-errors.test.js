'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseModelJson, validateExtraction } = require('../src/ingest');
const { humanizeImportError } = require('../src/import-errors');

test('empty model output fails as extraction_empty_response with guidance', () => {
  try { parseModelJson('   '); assert.fail('should have thrown'); }
  catch (e) {
    assert.equal(e.code, 'extraction_empty_response');
    assert.match(humanizeImportError(e), /Ollama is not running/);
  }
});

test('garbage model output fails as extraction_unparseable with a detail, never guesses', () => {
  try { parseModelJson('I could not find any deadlines in this document.'); assert.fail('should have thrown'); }
  catch (e) {
    assert.equal(e.code, 'extraction_unparseable');
    assert.match(e.detail, /No JSON object found/);
    assert.match(humanizeImportError(e), /Nothing was saved/);
  }
});

test('broken JSON reports the parse error and a snippet', () => {
  const raw = '```json\n{"course": {"name": "X",}, broken}\n```';
  try { parseModelJson(raw); assert.fail('should have thrown'); }
  catch (e) {
    assert.equal(e.code, 'extraction_unparseable');
    assert.match(e.detail, /JSON\.parse said:/);
    assert.match(e.detail, /"course"/);
  }
});

test('valid JSON that is not a course object is flagged, not guessed', () => {
  try { validateExtraction([1, 2, 3]); assert.fail('should have thrown'); }
  catch (e) {
    assert.equal(e.code, 'extraction_unparseable');
    assert.match(e.detail, /not a course object/);
  }
});

test('unreachable Ollama surfaces an actionable message', () => {
  const e = new Error('fetch failed');
  assert.match(humanizeImportError(e), /Start Ollama/);
  const e2 = new Error('ollama_http_500');
  assert.match(humanizeImportError(e2), /Start Ollama/);
});

test('the shared 5 MB import ceiling is exposed and bounded', () => {
  const ie = require('../src/import-errors');
  assert.equal(ie.MAX_IMPORT_BYTES, 5 * 1024 * 1024);
  assert.equal(ie.isImportTooLarge(5 * 1024 * 1024), false, 'exactly 5 MB passes');
  assert.equal(ie.isImportTooLarge(5 * 1024 * 1024 + 1), true, 'one byte over refuses');
  assert.equal(ie.isImportTooLarge(undefined), false, 'unknown size never claims too large');
});

test('a too-large import gets an actionable, saving-nothing message', () => {
  const ie = require('../src/import-errors');
  assert.match(ie.humanizeImportError({ code: 'file_too_large' }), /5 MB is the limit/);
  assert.match(ie.humanizeImportError({ code: 'file_too_large' }), /Nothing was saved/);
});

test('both import surfaces enforce the ceiling before reading bytes', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const ingest = fs.readFileSync(path.join(__dirname, '..', 'src', 'ingest.js'), 'utf8');
  assert.match(ingest, /isImportTooLarge\(fs\.statSync\(file\)\.size\)/, 'desktop ingest checks the file size first');
  assert.ok(ingest.indexOf('isImportTooLarge') < ingest.indexOf('readFileSync'), 'guard runs before the read');
  const bridge = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'bridge.js'), 'utf8');
  assert.match(bridge, /isImportTooLarge\(file\.size\)/, 'web bridge checks file.size first');
  assert.ok(bridge.indexOf('isImportTooLarge') < bridge.indexOf('arrayBuffer()'), 'guard runs before the bytes are read');
});
