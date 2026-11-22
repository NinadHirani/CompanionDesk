'use strict';

// Pure extraction logic shared by the Electron main process and the web/mobile
// build: no fs, no path, no Electron. Dual-mode so both require() and a plain
// <script> tag can load it. The hard rule inherited from Nus lives here: the
// model NEVER invents a deadline; anything ambiguous is flagged, not guessed.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CompanionCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

  function fail(code, detail) {
    const e = new Error(code);
    e.code = code;
    if (detail) e.detail = detail;
    return e;
  }

  function validIsoDate(s) {
    if (typeof s !== 'string' || !ISO_DATE.test(s)) return false;
    const d = new Date(s + 'T00:00:00Z');
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }

  function parseModelJson(raw) {
    let text = String(raw || '').trim();
    if (!text) throw fail('extraction_empty_response');
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) text = fence[1].trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      throw fail('extraction_unparseable', 'No JSON object found in the response.');
    }
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch (parseErr) {
      const snippet = text.slice(start, start + 160).replace(/\s+/g, ' ');
      throw fail('extraction_unparseable', 'JSON.parse said: ' + String(parseErr && parseErr.message) + '. Response began: ' + snippet);
    }
  }

  // Turn raw model JSON into a validated, never-guessing shape.
  function validateExtraction(data, { fallbackCourseName } = {}) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw fail('extraction_unparseable', 'The model returned valid JSON but not a course object.');
    }
    const rawCourse = data.course || {};
    const course = {
      name: String(rawCourse.name || fallbackCourseName || '').trim(),
      code: rawCourse.code || null,
      credit_hours: typeof rawCourse.credit_hours === 'number' ? rawCourse.credit_hours : null,
      term: rawCourse.term || null,
    };
    if (!course.name) throw fail('extraction_missing_course_name');

    const grade_weights = (Array.isArray(data.grade_weights) ? data.grade_weights : [])
      .filter((w) => w && typeof w.weight_pct === 'number' && w.category)
      .map((w) => ({ category: String(w.category), weight_pct: w.weight_pct }));

    const assignments = [];
    const warnings = [];
    for (const a of Array.isArray(data.assignments) ? data.assignments : []) {
      const title = a && a.title ? String(a.title).trim() : '';
      if (!title) { warnings.push('Dropped one listed item with no title.'); continue; }
      let due = null;
      let confidence = 'missing';
      if (a.due_date !== null && a.due_date !== undefined && a.due_date !== '') {
        if (validIsoDate(a.due_date)) {
          due = a.due_date;
          confidence = 'extracted';
        } else {
          confidence = 'ambiguous';
          warnings.push(`"${title}": the model returned a date in an unusable form ("${a.due_date}"); set to null, verify in the LMS.`);
        }
      } else {
        warnings.push(`"${title}": no confirmed date in the syllabus; verify in the LMS.`);
      }
      assignments.push({
        title,
        due_date: due,
        category: a.category ? String(a.category) : null,
        date_confidence: confidence,
      });
    }
    if (!assignments.length) warnings.push('No assignments were extracted; check the source document.');
    return { course, grade_weights, assignments, warnings };
  }

  // A date is trustworthy when it was read cleanly from a syllabus ('extracted')
  // or typed in by the user ('manual'). Everything else needs checking.
  function isConfirmedDate(confidence) {
    return confidence === 'extracted' || confidence === 'manual';
  }

  return { fail, validIsoDate, parseModelJson, validateExtraction, isConfirmedDate };
});
