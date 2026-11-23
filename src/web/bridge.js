'use strict';

/* Web/mobile bridge for CompanionDesk.
 * Exposes the same window.companiondesk API the Electron preload exposes, so
 * the renderer modules run unchanged. Everything the local database and the
 * local model can serve works here; Electron-only features (overlay, voice,
 * screen) answer with the clean desktop_only error the UI shows as a hint.
 * Storage is IndexedDB via the pluggable LocalDb saver; PDF parsing is
 * pdfjs-dist in the browser; the model is local Ollama when reachable, with
 * the user's opt-in Gemini key as the fallback (free-first: the app boots,
 * stores data, and shows today's list with zero network). The markdown vault
 * export is desktop-only in this milestone (MOBILE.md). */

(function () {
  if (typeof Promise.withResolvers !== 'function') {
    Promise.withResolvers = function () {
      let resolve, reject;
      const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    };
  }
  // General-purpose default voice; the student framing is appended only when
  // student data exists. Mirrors src/skills.js (the web build does not bundle
  // the desktop skill registry yet; see docs/SKILLS.md).
  const GENERAL_VOICE = [
    'You are CompanionDesk, a general-purpose local AI companion and desktop assistant.',
    'Short, direct, lead with the answer.',
    'Dates are always explicit (e.g. "Wed Nov 5"), never vague ("next week").',
    'If the context does not contain the answer, say so plainly.',
  ].join(' ');
  const STUDENT_VOICE = [
    'When student context is present, act as a chief of staff for it.',
    'NEVER invent a deadline or a course.',
  ].join(' ');
  function composeVoice() {
    let student = false;
    try { student = Boolean(db && db.listCourses && db.listCourses().length); } catch { student = false; }
    return student ? GENERAL_VOICE + ' ' + STUDENT_VOICE : GENERAL_VOICE;
  }

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
        pdfjs.GlobalWorkerOptions.workerSrc = new URL('vendor/pdf.worker.min.mjs', location.href).href;
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
    const lines = [`Context pack (today: ${today}). This is everything the app knows; do not go beyond it.`];
    let student = false;
    try { student = Boolean(db.listCourses && db.listCourses().length); } catch { student = false; }
    if (student) {
      const due = db.listDue(today, addDaysIso(today, 7));
      const courses = db.listCourses();
      lines.push(`Courses: ${courses.map((c) => `${c.name}${c.code ? ` (${c.code})` : ''}`).join('; ')}`);
      lines.push(due.length ? 'Due in the next 7 days:' : 'Nothing dated due in the next 7 days.');
      due.forEach((a) => lines.push(`- ${a.due_date} ${a.title} (${a.course_name}${a.date_confidence !== 'extracted' ? ', date flagged' : ''})`));
    }
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
      student: (() => {
        const s = CompanionSettings.normalizeSettings(db.allSettings());
        return { enabled: CompanionSkills.studentEnabled(s), active: CompanionSkills.studentActive(db, s) };
      })(),
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

  // In-flight asks, keyed by request id, for cancel (M1 slice 2). The abort
  // reaches the fetch and the streaming reader; no retry follows.
  const askControllers = new Map();
  async function ai_ask(payload) {
    await readyPromise;
    const prompt = payload && typeof payload.prompt === 'string' ? payload.prompt.trim() : '';
    if (!prompt) return { ok: false, error: 'empty_prompt' };
    const requestId = payload && typeof payload.request_id === 'string' ? payload.request_id : `web_${Date.now()}`;
    const controller = new AbortController();
    askControllers.set(requestId, controller);
    try {
      const settings = CompanionSettings.normalizeSettings(db.allSettings());
      const installed = await ai.listModels();
      const chat = installed
        ? CompanionModelSelection.resolveChatModel({ configured: settings.ai_model_local, fallback: ai.localModel, installed: installed.map((m) => m.name) })
        : { model: ai.localModel };
      // Conversation history is local-only; the cloud fallback never sees it
      // (the routed path sends history to the local model only).
      const conversationId = payload && Number.isInteger(payload.conversation_id) ? payload.conversation_id : null;
      let history;
      if (conversationId) {
        const got = CompanionChatHistory.getMessages(db, conversationId);
        if (got.ok) history = CompanionChatHistory.contextTurns(got.messages);
        else return { ok: false, error: 'not_found' };
      }
      // Routed ask (M1 slice 2). Fail-closed by construction: the web build
      // holds no key, so the cloud can never arm here, and consent is never
      // granted from the bridge. If the router ever offers a cloud
      // confirmation, the bridge reports the local failure instead of
      // pretending a send is possible.
      const answer = await ai.completeRouted({
        system: composeVoice(),
        prompt: buildContextPack() + '\n\nQuestion: ' + prompt,
        model: chat.model,
        history: history && history.length ? history : undefined,
        task: 'chat',
        privacyMode: 'standard',
        cloudEnabled: settings.cloud_enabled === true,
        cloudConsent: false,
        signal: controller.signal,
      });
      if (answer && answer.needsCloudConsent) {
        return { ok: false, error: 'local_ask_failed', detail: answer.localError };
      }
      if (conversationId) {
        const now = localNowIso();
        CompanionChatHistory.addMessage(db, conversationId, 'user', prompt, now);
        CompanionChatHistory.addMessage(db, conversationId, 'assistant', answer, now);
      }
      return conversationId ? { ok: true, answer, conversation_id: conversationId } : { ok: true, answer };
    } catch (err) {
      if (err && (err.name === 'AbortError' || err.name === 'TimeoutError' || err.code === 'ABORT_ERR')) {
        return { ok: false, error: 'canceled' };
      }
      return { ok: false, error: String((err && err.message) || err) };
    } finally {
      askControllers.delete(requestId);
    }
  }
  function ai_cancel(payload) {
    const id = payload && payload.request_id;
    const controller = id ? askControllers.get(id) : null;
    if (controller) controller.abort();
    return { ok: true, canceled: Boolean(controller) };
  }

  // Conversation history handlers, local storage only (the same sql.js
  // database the web build persists in IndexedDB).
  function chat_new() { return CompanionChatHistory.createConversation(db, { now: localNowIso() }); }
  function chat_list() { return CompanionChatHistory.listConversations(db); }
  function chat_messages(payload) { return CompanionChatHistory.getMessages(db, payload && payload.id); }
  function chat_rename(payload) { return CompanionChatHistory.renameConversation(db, payload && payload.id, payload && payload.title); }
  function chat_delete(payload) { return CompanionChatHistory.deleteConversation(db, payload && payload.id); }

  // Which installed model answers; mirrors the desktop ai:models handler.
  // Shared selection used by both ai_models and provider_status: the
  // profile-aware fallbacks live in one place.
  async function webModelSelection() {
    await readyPromise;
    const settings = CompanionSettings.normalizeSettings(db.allSettings());
    const profile = CompanionHardware.resolveProfile(
      settings.hardware_profile,
      CompanionHardware.classifyWebHardware(CompanionHardware.detectWebHardware())
    );
    const res = await CompanionModelSelection.resolveModelSelection({
      settings, ai,
      chatFallback: CompanionModelSelection.chatFallbackForProfile(profile),
      visionFallback: CompanionModelSelection.DEFAULT_VISION_MODEL,
    });
    return { settings, profile, res };
  }

  async function ai_models() {
    const { profile, res } = await webModelSelection();
    return { ok: true, ...res, defaults: { chat: CompanionModelSelection.chatFallbackForProfile(profile), vision: CompanionModelSelection.DEFAULT_VISION_MODEL } };
  }

  // Provider status for Settings, web edition: local Ollama facts and the
  // browser's (absent) secure vault only. The browser never holds key
  // material and no cloud health probe exists here: Gemini is contacted only
  // when the user acts, never by a status read.
  async function provider_status() {
    const { settings, res } = await webModelSelection();
    return {
      ok: true,
      ...CompanionProviderStatus.buildProviderStatus({
        ollamaUp: res.ollama,
        installed: res.installed,
        chat: res.chat,
        vision: res.vision,
        secureStore: { supported: false },
        cloudEnabled: settings.cloud_enabled === true,
      }),
    };
  }

  function localNowIso() {
    return new Date().toISOString();
  }

  // Features that live in the Electron main process (the overlay, voice
  // transcription, screen questions, the desktop docs reader and the
  // file-based about-me memory) answer with this clean error; the renderer
  // shows the shared desktop_only wording from errors.js. Nothing is faked.
  const DESKTOP_ONLY = 'This feature needs the CompanionDesk desktop app. Everything else works here.';
  function desktopOnly() {
    return { ok: false, error: 'desktop_only', message: DESKTOP_ONLY };
  }

  // Ollama detection works for real in the web build: the page may talk to
  // 127.0.0.1:11434 (the CSP allowlists it). Everything that installs or
  // downloads stays desktop-only, so the web build can never do either.
  async function ollama_detect() {
    try {
      const res = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(1500) });
      if (!res.ok) return { ok: true, running: false, version: null, models: [] };
      const data = await res.json();
      return {
        ok: true,
        running: true,
        version: null,
        models: (data.models || []).map((m) => String((m && m.name) || '')).filter(Boolean),
      };
    } catch {
      return { ok: true, running: false, version: null, models: [] };
    }
  }

  // ---- settings (mirrors personal.getSettings/saveSettings) -----------------

  function settings_get() {
    return { ok: true, settings: CompanionSettings.normalizeSettings(db.allSettings()) };
  }

  function settings_save(payload) {
    const r = CompanionSettings.validatePatch(payload);
    if (!r.ok) return { ok: false, error: 'invalid_settings', details: r.errors };
    for (const [key, value] of Object.entries(r.clean)) db.setSetting(key, value);
    return { ok: true, settings: CompanionSettings.normalizeSettings(db.allSettings()) };
  }

  // Hardware facts, web edition: the browser's coarse hints only, always
  // labelled approximate (deviceMemory is a rounded-down bucket, never an
  // exact reading). Same sanitized shape as the desktop hardware:report; no
  // recommendation is invented without an installed-models list.
  function hardware_report() {
    const raw = CompanionHardware.detectWebHardware();
    const settings = CompanionSettings.normalizeSettings(db.allSettings());
    const profile = CompanionHardware.resolveProfile(
      settings.hardware_profile,
      CompanionHardware.classifyWebHardware(raw)
    );
    return { ok: true, ...CompanionHardware.sanitizeHardware(raw), profile, recommendation: null };
  }

  // ---- today: the brief and done-marking (mirrors services.js) --------------

  function brief_today() {
    return CompanionServices.getBrief(db, todayIso());
  }

  function assignment_setDone(payload) {
    return CompanionServices.setDone(db, payload, localNowIso());
  }

  // ---- grades (mirrors gradebook.js) -----------------------------------------

  function grades_get() {
    return CompanionGradebook.getGrades(db);
  }

  function grades_setScore(payload) {
    return CompanionGradebook.setScore(db, payload, localNowIso());
  }

  function grades_setTarget(payload) {
    return CompanionGradebook.setTarget(db, payload);
  }

  // ---- activity patterns (mirrors personal.getPatterns/clearActivity) --------

  function patterns_get() {
    const p = CompanionPatterns.computePatterns(db.listEvents('assignment_done'));
    return {
      ok: true,
      learning: CompanionSettings.normalizeSettings(db.allSettings()).learn_from_activity,
      ...p,
      summary: CompanionPatterns.describePatterns(p),
    };
  }

  function activity_clear() {
    db.clearEvents();
    return { ok: true };
  }

  // ---- deadlines the user types in (mirrors personal.addDeadline) -------------

  function deadline_add(payload) {
    if (!payload || typeof payload.title !== 'string' || typeof payload.date !== 'string') return { ok: false, error: 'bad_request' };
    if (payload.isExam !== undefined && typeof payload.isExam !== 'boolean') return { ok: false, error: 'bad_request' };
    const title = CompanionSettings.cleanLine(payload.title, 120);
    if (!title) return { ok: false, error: 'empty_title' };
    if (!CompanionCore.validIsoDate(payload.date)) return { ok: false, error: 'invalid_date' };
    if (payload.date < todayIso()) return { ok: false, error: 'date_in_past' };
    const same = db.all(
      "SELECT id FROM assignments WHERE date_confidence = 'manual' AND due_date = ? AND lower(title) = lower(?)",
      [payload.date, title]
    );
    if (same.length) return { ok: false, error: 'duplicate' };
    const course = db.upsertCourse({ name: CompanionSkills.PERSONAL_COURSE });
    const id = db.addAssignment(course, {
      title, due_date: payload.date, category: payload.isExam ? 'Exam' : null, date_confidence: 'manual',
    });
    return { ok: true, id };
  }

  function deadline_remove(payload) {
    if (!payload || !Number.isInteger(payload.id)) return { ok: false, error: 'bad_request' };
    return db.removeManualAssignment(payload.id) ? { ok: true } : { ok: false, error: 'not_found' };
  }

  // ---- calendars (mirrors calendar.js; the .ics file comes from the browser) --

  function pickIcsFile() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.ics,text/calendar';
      input.style.display = 'none';
      document.body.appendChild(input);
      input.addEventListener('change', () => {
        const files = Array.from(input.files || []);
        input.remove();
        resolve(files[0] || null);
      });
      input.click();
    });
  }

  async function calendar_import() {
    await readyPromise;
    const file = await pickIcsFile();
    if (!file) return { ok: false, canceled: true };
    const text = await file.text();
    return CompanionCalendar.importCalendar(db, { name: file.name, text }, localNowIso());
  }

  function calendar_upcoming(payload) {
    return CompanionCalendar.upcoming(db, payload, todayIso());
  }

  function calendar_remove(payload) {
    return CompanionCalendar.removeCalendar(db, payload);
  }

  // ---- the setup check, web edition -------------------------------------------
  // Same shape the About view renders (ready + items), with the desktop-only
  // features listed as one optional item instead of fake facts.

  async function health_check() {
    await readyPromise;
    const status = await ai.status();
    const items = [];
    items.push(status.ollama
      ? { id: 'ollama', label: 'Ollama', status: 'ok', detail: 'Running.', fix: null }
      : { id: 'ollama', label: 'Ollama', status: 'needed', detail: 'Not detected, so there is no local model to answer with.', fix: { text: 'Install Ollama from ollama.com and open it. It runs in the background.' } });
    if (!status.ollama) {
      items.push({ id: 'model', label: `Model ${status.model}`, status: 'needed', detail: 'Waiting for Ollama.', fix: null });
    } else if (status.modelLoaded) {
      items.push({ id: 'model', label: `Model ${status.model}`, status: 'ok', detail: 'Installed.', fix: null });
    } else {
      items.push({ id: 'model', label: `Model ${status.model}`, status: 'needed', detail: 'Ollama is running but this model is not downloaded yet.', fix: { text: 'Download it once (a few GB):', command: `ollama pull ${status.model}` } });
    }
    items.push({
      id: 'storage',
      label: 'Local storage',
      status: 'ok',
      detail: 'Your database lives in this browser (IndexedDB); nothing leaves this device.',
      fix: null,
    });
    items.push({
      id: 'desktop',
      label: 'Overlay, voice and screen questions',
      status: 'optional',
      detail: 'Desktop-app features; the web build answers with a hint instead.',
      fix: null,
    });
    return { ok: true, ready: items.every((i) => i.status !== 'needed'), items };
  }

  async function init() {
    db = await CompanionDb.open({ storage: idbStorage('sqlite') });
    // No cloud key on the web build: there is no secure platform vault
    // behind localStorage, so the key path stays desktop-only rather than
    // falling back to insecure storage. The cloud fallback is therefore off.
    ai = CompanionAi.createAi({});
    readyResolve();
  }

  window.companiondesk = {
    bridgeMode: 'web',
    state_get, syllabus_import, ai_ask, ai_cancel, ai_models,
    chat_new, chat_list, chat_messages, chat_rename, chat_delete,
    // Optional cloud key setup needs an OS credential vault. The web build
    // has none, so status reports unsupported and every change is refused;
    // nothing is stored and no network call is made.
    cloud_status: () => ({ ok: true, supported: false }),
    cloud_setKey: () => ({ ok: false, error: 'unsupported' }),
    cloud_testKey: () => ({ ok: false, error: 'unsupported' }),
    cloud_removeKey: () => ({ ok: true, supported: false, configured: false }),
    brief_today, assignment_setDone,
    settings_get, settings_save, hardware_report, provider_status,
    grades_get, grades_setScore, grades_setTarget,
    patterns_get, activity_clear,
    deadline_add, deadline_remove,
    calendar_import, calendar_upcoming, calendar_remove,
    health_check,
    onboarding_get: desktopOnly, onboarding_answer: desktopOnly, onboarding_complete: desktopOnly,
    memory_list: desktopOnly, memory_add: desktopOnly, memory_forget: desktopOnly,
    memory_suggest: desktopOnly, memory_decide: desktopOnly,
    ollama_detect,
    ollama_setupPlan: desktopOnly, ollama_openInstall: desktopOnly,
    ollama_diskCheck: desktopOnly, ollama_pullStart: desktopOnly, ollama_pullCancel: desktopOnly,
    app_docs: desktopOnly,
    overlay_status: desktopOnly, overlay_show: desktopOnly, overlay_hide: desktopOnly,
    overlay_setHotkey: desktopOnly, overlay_ask: desktopOnly,
    voice_status: desktopOnly, voice_transcribe: desktopOnly,
    screen_status: desktopOnly, screen_windows: desktopOnly, screen_ask: desktopOnly,
    // Main may push overlay events to the desktop window; the web build has no
    // push channel, so listening is a no-op that returns its own unlistener.
    on: () => () => {},
  };
  init().catch((err) => readyReject(err));
})();
