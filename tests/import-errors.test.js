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
