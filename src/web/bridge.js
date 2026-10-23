'use strict';

/* Web/mobile bridge for CompanionDesk.
 * Exposes the exact window.companiondesk API the Electron preload exposes
 * (state_get, syllabus_import, ai_ask), so renderer/app.js runs unchanged.
 * Storage is IndexedDB via the pluggable LocalDb saver; PDF parsing is
 * pdfjs-dist in the browser; the model is local Ollama when reachable, with
 * the user's opt-in Gemini key as the fallback (free-first: the app boots,
 * stores data, and shows today's list with zero network). The markdown vault
 * export is desktop-only in this milestone (MOBILE.md). */

(function () {
  const GEMINI_KEY_STORAGE = 'companiondesk.geminiKey';
  const SYSTEM_VOICE = [
    "You are CompanionDesk, a student's chief of staff. Short, direct, lead with the answer.",
    'Dates are always explicit (e.g. "Wed Nov 5"), never vague ("next week").',
    'If the context does not contain the answer, say so. NEVER invent a deadline.',
  ].join(' ');

  let readyResolve = null;
  let readyReject = null;
  const readyPromise = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  let db = null;
  let ai = null;

  function todayIso() {
    const d = new Date();
    return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
  }

  function addDaysIso(iso, days) {
    const d = new Date(iso + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  function idbStorage(key) {
    function openDb() {
      return new Promise((resolve, reject) => {
        const req = indexedDB.open('companiondesk', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('kv');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return {
      async load() {
        const conn = await openDb();
        try {
          return await new Promise((resolve, reject) => {
            const tx = conn.transaction('kv', 'readonly');
            const get = tx.objectStore('kv').get(key);
            get.onsuccess = () => resolve(get.result || null);
            get.onerror = () => reject(get.error);
          });
        } finally { conn.close(); }
      },
      async save(bytes) {
        const conn = await openDb();
        try {
          await new Promise((resolve, reject) => {
            const tx = conn.transaction('kv', 'readwrite');
            tx.objectStore('kv').put(bytes, key);
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
          });
        } finally { conn.close(); }
      },
    };
  }

  let pdfModulePromise = null;
  function loadPdfjs() {
    if (!pdfModulePromise) {
      pdfModulePromise = import('./vendor/pdf.min.mjs').then((pdfjs) => {
        pdfjs.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.mjs';
        return pdfjs;
      });
    }
    return pdfModulePromise;
  }

  async function pdfToText(bytes) {
    const pdfjs = await loadPdfjs();
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(bytes),
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
      try { await loadingTask.destroy(); } catch { /* already torn down */ }
    }
    return parts.join('\n\n');
  }

  async function fileToText(file) {
    const lower = String(file.name || '').toLowerCase();
    const bytes = await file.arrayBuffer();
    if (lower.endsWith('.pdf')) return { text: await pdfToText(bytes), kind: 'pdf' };
    if (lower.endsWith('.txt') || lower.endsWith('.md')) {
      return { text: new TextDecoder().decode(bytes), kind: 'text' };
    }
    throw CompanionCore.fail('unsupported_file_type', 'Only PDF, TXT and MD files can be imported.');
  }

  function buildContextPack() {
    const today = todayIso();
    const due = db.listDue(today, addDaysIso(today, 7));
    const courses = db.listCourses();
    const lines = [
      `Context pack (today: ${today}). This is everything the app knows; do not go beyond it.`,
      `Courses: ${courses.length ? courses.map((c) => `${c.name}${c.code ? ` (${c.code})` : ''}`).join('; ') : 'none imported yet.'}`,
      due.length ? 'Due in the next 7 days:' : 'Nothing dated due in the next 7 days.',
      ...due.map((a) => `- ${a.due_date} ${a.title} (${a.course_name}${a.date_confidence !== 'extracted' ? ', date flagged' : ''})`),
    ];
    return lines.join('\n');
  }

  async function state_get() {
    await readyPromise;
    const today = todayIso();
    return {
      today,
      courses: db.listCourses(),
      due: db.listDue(today, addDaysIso(today, 7)),
      counts: db.counts(),
      ai: await ai.status(),
    };
  }

  async function pickFiles() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.accept = '.pdf,.txt,.md';
      input.style.display = 'none';
      document.body.appendChild(input);
      input.addEventListener('change', () => {
        const files = Array.from(input.files || []);
        input.remove();
        resolve(files);
      });
      input.click();
    });
  }

  async function syllabus_import() {
    await readyPromise;
    const files = await pickFiles();
    if (!files.length) return { ok: false, canceled: true };
    const summaries = [];
    for (const file of files) {
      try {
        const { text } = await fileToText(file);
        if (!text.trim()) throw CompanionCore.fail('empty_document');
        const fallback = String(file.name || '').replace(/\.[^.]+$/, '');
        const raw = await ai.complete({
          system: null,
          prompt: (await fetch('./prompts/syllabus-extract.md').then((r) => r.text())) + '\n===SYLLABUS===\n' + text,
          temperature: 0,
        });
        const extracted = CompanionCore.validateExtraction(CompanionCore.parseModelJson(raw), { fallbackCourseName: fallback });
        const courseId = db.upsertCourse({ ...extracted.course, source_file: file.name });
        db.setGradeWeights(courseId, extracted.grade_weights);
        db.clearAssignments(courseId);
        for (const a of extracted.assignments) db.addAssignment(courseId, a);
        summaries.push({
          ok: true,
          file: file.name,
          course: extracted.course.name,
          assignments: extracted.assignments.length,
          flagged: extracted.assignments.filter((x) => x.date_confidence !== 'extracted').length,
          warnings: extracted.warnings,
        });
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        if (!e.code) e.code = String(e.message || 'import_failed').split(':')[0].trim();
        summaries.push({ ok: false, file: file.name, error: e.code, message: CompanionImportErrors.humanizeImportError(e) });
      }
    }
    return { ok: true, summaries };
  }

  async function ai_ask(payload) {
    await readyPromise;
    const prompt = payload && typeof payload.prompt === 'string' ? payload.prompt.trim() : '';
    if (!prompt) return { ok: false, error: 'empty_prompt' };
    try {
      const answer = await ai.complete({ system: SYSTEM_VOICE, prompt: buildContextPack() + '\n\nQuestion: ' + prompt });
      return { ok: true, answer };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  }

  async function init() {
    db = await CompanionDb.open({ storage: idbStorage('sqlite') });
    const key = (typeof localStorage !== 'undefined' && localStorage.getItem(GEMINI_KEY_STORAGE)) || null;
    ai = CompanionAi.createAi({ geminiKey: key });
    readyResolve();
  }

  window.companiondesk = { state_get, syllabus_import, ai_ask };
  init().catch((err) => readyReject(err));
})();
