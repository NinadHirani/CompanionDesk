'use strict';

// Syllabus ingestion: PDF/txt -> text -> structured JSON via the AI layer,
// with the hard rule inherited from Nūs: the model NEVER invents a deadline.
// Anything ambiguous comes back flagged, not guessed. The model's JSON is
// validated locally before anything touches the database.

const fs = require('fs');
const path = require('path');
const { MAX_IMPORT_BYTES, isImportTooLarge } = require('./import-errors');
const vault = require('./vault');
const { parseModelJson, validateExtraction, validIsoDate } = require('./extraction-core');
// pdf.js calls Uint8Array.prototype.toHex on some paths; make sure it exists
// on Node versions without the ES2025 method.
require('./uint8-hex');
// Modern pdf.js, pure JS (no native canvas needed for text extraction).
// Loaded via dynamic import because the legacy build ships as ESM while this
// codebase stays CommonJS.
let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

async function pdfToText(buffer) {
  const pdfjs = await loadPdfjs();
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
  });
  const doc = await loadingTask.promise;
  const parts = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let pageText = '';
      for (const item of content.items) {
        pageText += item.str + (item.hasEOL ? '\n' : ' ');
      }
      parts.push(pageText.trim());
    }
  } finally {
    // In pdfjs-dist v6 teardown lives on the loading task, not the document.
    try { await loadingTask.destroy(); } catch { /* already torn down */ }
  }
  return parts.join('\n\n');
}

const PROMPT_PATH = path.join(__dirname, '..', 'prompts', 'syllabus-extract.md');
const SYLLABUS_MARKER = '\n===SYLLABUS===\n';

function loadPrompt() {
  return fs.readFileSync(PROMPT_PATH, 'utf8');
}

async function parseDocument(file) {
  if (isImportTooLarge(fs.statSync(file).size)) throw new Error('file_too_large');
  const ext = path.extname(file).toLowerCase();
  if (ext === '.pdf') {
    return { text: await pdfToText(fs.readFileSync(file)), kind: 'pdf' };
  }
  if (ext === '.txt' || ext === '.md') {
    return { text: fs.readFileSync(file, 'utf8'), kind: 'text' };
  }
  throw new Error(`unsupported_file_type${ext || ''}`);
}


async function extractSyllabus({ text, ai, fallbackCourseName }) {
  const prompt = loadPrompt() + SYLLABUS_MARKER + text;
  const raw = await ai.complete({ system: null, prompt, temperature: 0 });
  const data = parseModelJson(raw);
  return validateExtraction(data, { fallbackCourseName });
}

// Full path: document file -> extraction -> database rows -> markdown vault.
async function ingestSyllabus({ file, ai, db, vaultDir }) {
  const { text } = await parseDocument(file);
  if (!text.trim()) throw new Error('empty_document');
  const base = path.basename(file);
  const extracted = await extractSyllabus({ text, ai, fallbackCourseName: base.replace(/\.[^.]+$/, '') });
  const courseId = db.upsertCourse({ ...extracted.course, source_file: base });
  db.setGradeWeights(courseId, extracted.grade_weights);
  db.clearAssignments(courseId);
  for (const a of extracted.assignments) db.addAssignment(courseId, a);
  const classFile = vault.writeClassFile(vaultDir, extracted);
  const overviewFile = vault.writeSemesterOverview(vaultDir, db.listCourses());
  return {
    course: extracted.course.name,
    assignments: extracted.assignments.length,
    flagged: extracted.assignments.filter((x) => x.date_confidence !== 'extracted').length,
    warnings: extracted.warnings,
    classFile,
    overviewFile,
  };
}

module.exports = { parseDocument, parseModelJson, validateExtraction, extractSyllabus, ingestSyllabus, validIsoDate };
