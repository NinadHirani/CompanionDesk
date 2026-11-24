'use strict';

// "Ask about this window": check a vision model exists, take one screenshot of
// the window the user picked, ask the LOCAL model with it, and drop the image.
// The overlay stays visible the whole time, so the user can see what is being
// sent. There is no cloud fallback: a screenshot never leaves the machine, and
// a fallback would answer without seeing the picture.

const memory = require('./memory');
const { computePatterns } = require('./patterns');
const { buildPersona, renderContextPack, renderCalendarBlock } = require('./persona');
const calendar = require('./calendar');
const { addDaysIso } = require('./dates');
const { getSettings } = require('./personal');
const { activeSkills } = require('./skills');
const { SCREEN_NOTE } = require('./screen');
const { cleanLine } = require('./settings');

// deps: { capture(windowId), visionModel, onToken }
async function askAboutScreen({ db, ai, meFile }, payload, todayIso, deps) {
  const question = payload && typeof payload.prompt === 'string' ? payload.prompt.trim() : '';
  if (!question) return { ok: false, error: 'empty_prompt' };
  const windowId = payload && typeof payload.windowId === 'string' ? payload.windowId : '';
  if (!windowId) return { ok: false, error: 'bad_request' };

  // Cheap checks first, so nothing is captured when the answer cannot be
  // given. The ROUTER decides from live facts; the vision task is
  // local-only, so no setting, key or consent can ever change that.
  let visionModel = deps.visionModel;
  if (typeof ai.routeTask === 'function') {
    const { decision } = await ai.routeTask('vision', {
      privacyMode: 'local_only',
      visionModel: deps.visionModel,
      signal: deps.signal || null,
    });
    if (!decision.ok || decision.provider !== 'ollama') {
      return { ok: false, error: 'vision_unavailable', detail: decision.reason || 'vision_unavailable' };
    }
    visionModel = decision.model;
  } else if (!(await ai.hasModel(deps.visionModel))) {
    return { ok: false, error: 'vision_unavailable', detail: deps.visionModel };
  }

  const shot = await deps.capture(windowId);
  if (!shot.ok) return shot;

  const settings = getSettings(db);
  const skills = activeSkills(db, settings);
  // M4 (24 Nov 2026): screen-derived asks retrieve ZERO memory by default.
  // task 'vision' forces the zero budget before any selection runs, so not
  // even always-on sections reach a screen ask. Raising this needs explicit
  // user control; it is never a convenience change.
  const persona = buildPersona({
    settings,
    skills,
    task: 'vision',
    memories: memory.listMemories(meFile),
    patterns: computePatterns(db.listEvents('assignment_done')),
    contextPack: renderContextPack({ today: todayIso, courses: db.listCourses(), due: db.listDue(todayIso, addDaysIso(todayIso, 7)), student: skills.includes('student') }),
    calendarBlock: renderCalendarBlock(calendar.upcoming(db, { days: 7 }, todayIso).occurrences),
    question,
  });
  const title = cleanLine(shot.title, 120);
  try {
    // ai.chat is Ollama only. Never ai.complete, which can fall back to the cloud.
    const answer = await ai.chat({
      system: `${persona.system} ${SCREEN_NOTE} The screenshot shows the window titled "${title}".`,
      prompt: persona.prompt,
      model: visionModel,
      images: [shot.jpegBase64],
      onToken: deps.onToken,
      signal: deps.signal || null,
    });
    return { ok: true, answer, title };
  } catch (err) {
    if (err && (err.name === 'AbortError' || err.name === 'TimeoutError' || err.code === 'ABORT_ERR')) {
      return { ok: false, error: 'canceled' };
    }
    return { ok: false, error: 'vision_failed', detail: String((err && err.message) || err) };
  } finally {
    shot.jpegBase64 = null; // the screenshot is not kept
  }
}

module.exports = { askAboutScreen };
