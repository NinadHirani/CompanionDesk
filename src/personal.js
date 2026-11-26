'use strict';

// Service layer for everything personal: settings, the about-me file, memory
// suggestions, the onboarding interview, activity patterns, hand-added
// deadlines, and the personalized answer itself. main.js exposes these over
// IPC; they take the database, file path and AI as arguments so tests can run
// them with no Electron and no network.

const memory = require('./memory');
const session = require('./memory-session');
const { normalizeSettings, validatePatch, cleanLine } = require('./settings');
const { computePatterns, describePatterns } = require('./patterns');
const { buildPersona, renderContextPack, renderCalendarBlock } = require('./persona');
const calendar = require('./calendar');
const proposals = require('./proposals');
const retrieval = require('./memory-retrieval');
const onboarding = require('./onboarding');
const { addDaysIso } = require('./dates');
const { validIsoDate } = require('./extraction-core');
const { PERSONAL_COURSE, activeSkills } = require('./skills');
const chatHistory = require('./chat-history');


// ---- settings ---------------------------------------------------------------

function getSettings(db) {
  return normalizeSettings(db.allSettings());
}

function saveSettings(db, patch) {
  const r = validatePatch(patch);
  if (!r.ok) return { ok: false, error: 'invalid_settings', details: r.errors };
  for (const [key, value] of Object.entries(r.clean)) db.setSetting(key, value);
  return { ok: true, settings: getSettings(db) };
}

// ---- about-me memory ----------------------------------------------------------

function listMemory({ db, meFile }) {
  return { ok: true, file: meFile, sections: memory.SECTIONS, items: session.get(meFile).list(), proposals: db.listProposals() };
}

function addMemory({ meFile }, payload) {
  if (!payload || typeof payload.section !== 'string' || typeof payload.text !== 'string') return { ok: false, error: 'bad_request' };
  const sensitive = payload.sensitive === true;
  return session.get(meFile).add(payload.section, payload.text, { sensitive });
}

function forgetMemory({ meFile }, payload) {
  if (!payload || typeof payload.section !== 'string' || typeof payload.text !== 'string') return { ok: false, error: 'bad_request' };
  return session.get(meFile).forget(payload.section, payload.text);
}

// M2/M4 memory panel slice (26 Nov 2026): the four panel channels. Full
// view incl. ids, sensitive flags and persistence provenance, for the
// panel's explicit status lines.
function itemsMemory({ meFile }) {
  const s = session.get(meFile);
  const items = s.items().map((it) => ({ ...it, persisted: s.persisted(it.id) === 'file' }));
  return { ok: true, file: meFile, sections: memory.SECTIONS, items };
}

// User-commanded mark/unmark from the panel. A mark is a sensitivity
// CLASSIFICATION, never consent; session-only entries refuse unmark
// (session_only_entry) because an unmarked session-only entry has no home.
function markMemory({ meFile }, payload) {
  if (!payload || typeof payload.id !== 'string') return { ok: false, error: 'bad_request' };
  const value = payload.value !== false;
  return { ...session.get(meFile).markSensitive(payload.id, value), id: payload.id, value };
}

// Explicit save attempt for a sensitive entry. Fail-closed by design: the
// session refuses (sensitive_storage_blocked) and the refusal reaches the
// panel verbatim; nothing is written and nothing is downgraded.
function persistMemory({ meFile }, payload) {
  if (!payload || typeof payload.id !== 'string') return { ok: false, error: 'bad_request' };
  return session.get(meFile).persistSensitive(payload.id);
}

// The measured ranker over the session view with the consent gate and the
// task budget made visible to the caller. includeSensitive defaults false:
// sensitive bullets stay hidden unless this call explicitly consents.
function searchMemory({ meFile }, payload) {
  if (!payload || typeof payload.query !== 'string' || payload.query.length === 0) return { ok: false, error: 'bad_request' };
  const task = typeof payload.task === 'string' && retrieval.BUDGETS[payload.task] !== undefined ? payload.task : 'chat';
  const budget = retrieval.BUDGETS[task];
  const s = session.get(meFile);
  const items = s.items();
  const sensitiveTotal = items.filter((b) => b.sensitive).length;
  const includeSensitive = payload.includeSensitive === true;
  const k = typeof payload.k === 'number' && payload.k >= 0 ? Math.floor(payload.k) : budget;
  return {
    ok: true,
    task,
    budget,
    requested: k,
    candidates: items.length,
    sensitiveTotal,
    sensitiveIncluded: includeSensitive ? sensitiveTotal : 0,
    results: s.search(payload.query, { k, includeSensitive }),
  };
}

// Ask the local model whether the student's message holds anything worth
// remembering. Results wait in the proposals table for a yes or no.
async function suggest({ db, ai, meFile }, payload, nowIso) {
  if (!payload || typeof payload.message !== 'string') return { ok: false, error: 'bad_request' };
  if (!getSettings(db).suggest_memories) return { ok: true, proposals: db.listProposals() };
  const existing = [...session.get(meFile).list().map((m) => m.text), ...db.listProposals().map((p) => p.text)];
  const found = await proposals.suggest({ ai, message: payload.message, existing });
  for (const p of found) db.addProposal({ section: p.section, text: p.text, created_at: nowIso });
  return { ok: true, proposals: db.listProposals() };
}

function decide({ db, meFile }, payload) {
  if (!payload || !Number.isInteger(payload.id) || typeof payload.approve !== 'boolean') return { ok: false, error: 'bad_request' };
  const p = db.getProposal(payload.id);
  if (!p) return { ok: false, error: 'not_found' };
  if (p.status !== 'pending') return { ok: false, error: 'already_decided' };
  if (payload.approve) {
    const r = session.get(meFile).add(p.section, p.text);
    if (!r.ok && r.error !== 'duplicate') return { ok: false, error: r.error };
  }
  db.decideProposal(p.id, payload.approve ? 'approved' : 'rejected');
  return { ok: true, proposals: db.listProposals() };
}

// ---- activity patterns --------------------------------------------------------

function getPatterns(db) {
  const p = computePatterns(db.listEvents('assignment_done'));
  return { ok: true, learning: getSettings(db).learn_from_activity, ...p, summary: describePatterns(p) };
}

function clearActivity(db) {
  db.clearEvents();
  return { ok: true };
}

// ---- onboarding -----------------------------------------------------------------

function getOnboarding(db) {
  return { ok: true, done: getSettings(db).onboarding_done, questions: onboarding.QUESTIONS };
}

function answerOnboarding({ db, meFile }, payload) {
  if (!payload || typeof payload.id !== 'string') return { ok: false, error: 'bad_request' };
  const r = onboarding.interpretAnswer(payload.id, payload.answer);
  if (!r.ok) return r;
  if (r.skipped) return { ok: true, applied: 'skipped' };
  if (r.memory) {
    const m = session.get(meFile).add(r.memory.section, r.memory.text);
    if (!m.ok && m.error !== 'duplicate') return { ok: false, error: m.error };
    return { ok: true, applied: 'memory' };
  }
  const s = saveSettings(db, r.settings);
  return s.ok ? { ok: true, applied: 'settings' } : { ok: false, error: s.error };
}

function completeOnboarding(db) {
  db.setSetting('onboarding_done', 'true');
  return { ok: true };
}

// ---- deadlines the user adds themselves ---------------------------------------------

// payload: { title, date: 'YYYY-MM-DD', isExam?: boolean }. Typed dates are
// marked 'manual'; isExam lets the user say outright that it is an exam.
function addDeadline({ db }, payload, todayIso) {
  if (!payload || typeof payload.title !== 'string' || typeof payload.date !== 'string') return { ok: false, error: 'bad_request' };
  if (payload.isExam !== undefined && typeof payload.isExam !== 'boolean') return { ok: false, error: 'bad_request' };
  const title = cleanLine(payload.title, 120);
  if (!title) return { ok: false, error: 'empty_title' };
  if (!validIsoDate(payload.date)) return { ok: false, error: 'invalid_date' };
  if (payload.date < todayIso) return { ok: false, error: 'date_in_past' };
  const same = db.all(
    "SELECT id FROM assignments WHERE date_confidence = 'manual' AND due_date = ? AND lower(title) = lower(?)",
    [payload.date, title]
  );
  if (same.length) return { ok: false, error: 'duplicate' };
  const course = db.upsertCourse({ name: PERSONAL_COURSE });
  const id = db.addAssignment(course, {
    title, due_date: payload.date, category: payload.isExam ? 'Exam' : null, date_confidence: 'manual',
  });
  return { ok: true, id };
}

function removeDeadline({ db }, payload) {
  if (!payload || !Number.isInteger(payload.id)) return { ok: false, error: 'bad_request' };
  return db.removeManualAssignment(payload.id) ? { ok: true } : { ok: false, error: 'not_found' };
}

// ---- the personalized answer -----------------------------------------------------------

async function ask({ db, ai, meFile }, payload, todayIso, { onToken, model, signal } = {}) {
  const question = payload && typeof payload.prompt === 'string' ? payload.prompt.trim() : '';
  if (!question) return { ok: false, error: 'empty_prompt' };
  // Conversation history is opt-in per call: the desktop ask view passes a
  // conversation id, the overlay stays single-shot. Past turns go to the
  // LOCAL model only; the cloud fallback never receives them.
  const conversationId = payload && Number.isInteger(payload.conversation_id) ? payload.conversation_id : null;
  let history;
  if (conversationId) {
    const got = chatHistory.getMessages(db, conversationId);
    if (got.ok) history = chatHistory.contextTurns(got.messages);
    else return { ok: false, error: 'not_found' };
  }
  const settings = getSettings(db);
  const skills = activeSkills(db, settings);
  const contextPack = renderContextPack({
    today: todayIso,
    courses: db.listCourses(),
    due: db.listDue(todayIso, addDaysIso(todayIso, 7)),
    student: skills.includes('student'),
  });
  const persona = buildPersona({
    settings,
    skills,
    task: 'chat',
    memories: session.get(meFile).list(),
    patterns: computePatterns(db.listEvents('assignment_done')),
    contextPack,
    calendarBlock: renderCalendarBlock(calendar.upcoming(db, { days: 7 }, todayIso).occurrences),
    question,
  });
  // M1 slice 2: the ask flow routes through the task router with live
  // facts. cloudEnabled is read per request (settings can change between
  // asks), and cloudConsent must be true FOR THIS REQUEST: a saved key or
  // the settings flag alone never sends anything anywhere.
  //
  // Accurate per-request disclosure (review fix, 23 Nov 2026): the
  // confirmation must describe what Google would ACTUALLY receive on the
  // exact cloudArgs path this ask would take. With cloud_personal off,
  // persona.cloud minimizes the cloud prompt to the context pack and the
  // question. With cloud_personal on, persona.cloud is null, so the cloud
  // call gets the full personal prompt: calendar, name, selected memories
  // and (when learn_from_activity is on) activity patterns.
  const cloudDisclosure = persona.cloud ? {
    prompt: 'minimized',
    receives: [
      'your current question',
      'the assistant rules and style settings',
      'the course and due-date context pack',
    ],
    never_sent: [
      'conversation history',
      'your calendar entries',
      'your name and saved memories',
      'your activity patterns',
      'screenshots or images',
    ],
  } : {
    prompt: 'full',
    receives: [
      'your current question',
      'the assistant rules and style settings',
      'the course and due-date context pack',
      'your next 7 days of calendar entries',
      'your name and the selected saved memories',
      ...(settings.learn_from_activity ? ['your activity patterns'] : []),
    ],
    never_sent: ['conversation history', 'screenshots or images'],
  };
  const routedArgs = {
    system: persona.system,
    prompt: persona.prompt,
    cloudArgs: persona.cloud || undefined,
    cloudDisclosure,
    onToken, model,
    history: history && history.length ? history : undefined,
    task: 'chat',
    privacyMode: 'standard',
    cloudEnabled: settings.cloud_enabled === true,
    cloudConsent: Boolean(payload && payload.cloud_consent === true),
    signal: signal || null,
  };
  try {
    const answer = await ai.completeRouted(routedArgs);
    if (answer && answer.needsCloudConsent) {
      // Per-request cloud gate. Nothing has been sent anywhere yet; the
      // renderer shows what Google would receive. A decline simply never
      // calls again with consent, so no cloud request can happen by
      // accident and nothing retries on its own.
      return { ok: false, needs_cloud_consent: true, local_error: answer.localError, cloud: answer.cloud };
    }
    if (conversationId) {
      const now = new Date().toISOString();
      const first = chatHistory.addMessage(db, conversationId, 'user', question, now);
      const second = first.ok ? chatHistory.addMessage(db, conversationId, 'assistant', answer, now) : null;
      if (!first.ok || !second || !second.ok) {
        // Same rule as the web bridge: a completed exchange must never be
        // reported as saved when its thread vanished mid-flight. Surface
        // the save failure instead of pretending success.
        return { ok: true, answer, conversation_id: conversationId, saved: false, save_error: first.error || (second && second.error) };
      }
      return { ok: true, answer, conversation_id: conversationId, saved: true };
    }
    return { ok: true, answer };
  } catch (err) {
    if (conversationId) chatHistory.addMessage(db, conversationId, 'user', question, new Date().toISOString());
    if (err && (err.name === 'AbortError' || err.name === 'TimeoutError' || err.code === 'ABORT_ERR')) {
      return { ok: false, error: 'canceled' };
    }
    return { ok: false, error: String((err && err.message) || err) };
  }
}

module.exports = {
  PERSONAL_COURSE,
  getSettings, saveSettings,
  listMemory, addMemory, forgetMemory, suggest, decide,
  itemsMemory, markMemory, persistMemory, searchMemory,
  getPatterns, clearActivity,
  getOnboarding, answerOnboarding, completeOnboarding,
  addDeadline, removeDeadline,
  ask,
};
