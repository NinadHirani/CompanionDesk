'use strict';

// Builds the prompt for one user. The fixed rules never change; everything
// else (tone, length, language, what the student has told us, habits we have
// measured) comes from that user's own settings, memory file and activity.
// Pure: no fs, no database, no network, no clock.
//
// Two prompts come out: the full one for the local model, and, unless the
// user allowed it, a minimal one for the cloud fallback with no name, no
// memory lines and no habits in it.

const retrieval = require('./memory-retrieval');
const { cleanLine } = require('./settings');
const { describePatterns } = require('./patterns');
const { isConfirmedDate } = require('./extraction-core');

const TONE_LINE = {
  direct: 'Be plain and brisk. No small talk.',
  warm: 'Be friendly and encouraging, without gushing.',
  formal: 'Be polite and professional.',
};
const BREVITY_LINE = {
  short: 'Keep answers to a few sentences.',
  normal: 'Keep answers focused. Use a short list only when it helps.',
  detailed: 'Explain your reasoning and include the relevant dates and details.',
};

function rules(assistantName, { student = false } = {}) {
  const who = student ? 'a study assistant that runs on the student\'s own computer' : 'a personal assistant that runs on the user\'s own computer';
  const about = student ? 'About the student' : 'About the user';
  return [
    `You are ${assistantName}, ${who}.`,
    'Answer from the context below and nothing else about their schedule. Give the answer first.',
    'Write dates in full, with the weekday and the year, like Wed Nov 4, 2026.',
    `If the context does not say, say you do not know. Never make up a deadline, ${student ? 'a grade weight, ' : ''}a date or a fact.`,
    `Notes under "${about}" are what they told you: use them to fit your advice to them,`,
    'do not recite them back, and do not claim to remember anything that is not listed there.',
  ].join(' ');
}

function styleLines(settings) {
  return [TONE_LINE[settings.tone], BREVITY_LINE[settings.brevity], `Reply in ${cleanLine(settings.language, 30) || 'English'}.`]
    .filter(Boolean).join(' ');
}

// Same text the app has always sent: this is what the model may rely on.
function renderContextPack({ today, courses, due, student = true }) {
  const lines = [
    `Context pack (today: ${today}). This is everything the app knows; do not go beyond it.`,
    ...(student ? [`Courses: ${courses.length ? courses.map((c) => `${c.name}${c.code ? ` (${c.code})` : ''}`).join('; ') : 'none imported yet.'}`] : []),
    due.length ? 'Due in the next 7 days:' : 'Nothing dated due in the next 7 days.',
    ...due.map((a) => `- ${a.due_date} ${a.title} (${a.course_name}${!isConfirmedDate(a.date_confidence) ? ', date flagged' : ''})`),
  ];
  return lines.join('\n');
}

// One line per event, soonest first, capped. Local prompt only: calendar
// entries are personal, so the cloud fallback never receives them.
function renderCalendarBlock(occurrences, { max = 20 } = {}) {
  if (!occurrences || !occurrences.length) return '';
  const shown = occurrences.slice(0, max).map((o) => {
    const when = o.allDay ? `${o.date} all day` : `${o.date} ${o.time}${o.endTime ? '-' + o.endTime : ''}`;
    return `- ${when} ${cleanLine(o.title, 80)}${o.location ? ` (${cleanLine(o.location, 60)})` : ''}`;
  });
  const more = occurrences.length > max ? [`- and ${occurrences.length - max} more`] : [];
  return ['Calendar for the next 7 days:', ...shown, ...more].join('\n');
}

// ---- choosing which memories to show ---------------------------------------
//
// M4 memory v2 (wired 24 Nov 2026): selection runs on the MEASURED ranker
// (src/memory-retrieval.js: BM25 + section boost + bigram phrase bonus +
// the FROZEN seeded synonym map) instead of the old token-overlap scorer,
// with the DECIDED per-task budgets (chat 12, screen 6, goal 8, vision 0).
// Vision and any screen-derived ask retrieve ZERO memory by default: the
// budget gate fires before anything else, so even always-on sections are
// withheld there. Sensitive bullets are never stored (src/memory-store.js
// gate), and are filtered defensively here too. Raising a budget is a
// reviewed change, never a convenience.

const STOPWORDS = new Set(('the and for are but not you your with this that have what when where which will from about into over '
  + 'than then them they there their how can could should would any all out has had was were been being its our his her she him '
  + 'who why too very just more most some such only own same few other another each both here these those once do does did').split(' '));

function tokens(text) {
  return new Set(String(text).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOPWORDS.has(w)));
}

const ALWAYS_ON = { Preferences: 4, Constraints: 4, Goals: 3 }; // sections always shown, with a cap each

// memories: [{ section, text }]. Preferences, constraints and goals always
// apply; facts and routines only when they relate to the question (the
// measured ranker decides relevance). Capped by the TASK BUDGET so a small
// local model is never buried.
function selectMemories(memories, question, { task = 'chat', maxChars = 1100 } = {}) {
  const budget = retrieval.BUDGETS[task] == null ? retrieval.BUDGETS.default : retrieval.BUDGETS[task];
  if (budget === 0) return []; // vision / screen-derived: zero memory, always-on included
  const visible = (memories || []).filter((m) => !m.sensitive);
  const q = tokens(question);
  const picked = [];
  const used = {};
  for (const m of visible) {
    const cap = ALWAYS_ON[m.section];
    if (!cap) continue;
    used[m.section] = (used[m.section] || 0) + 1;
    if (used[m.section] <= cap) picked.push({ ...m, score: Infinity });
  }
  // Facts and routines compete for the remaining budget slots on measured
  // relevance. The ranker only returns bullets it matched, so score > 0 is
  // structural; the frozen synonym map is part of that match.
  const candidates = visible
    .filter((m) => !ALWAYS_ON[m.section])
    .map((m, i) => ({ id: `s${i}`, section: m.section, text: m.text }));
  const scored = retrieval.search(retrieval.buildIndex(candidates), question, { k: budget })
    .map((r) => ({ section: r.section, text: r.text, score: r.score }));
  const out = [];
  let chars = 0;
  for (const m of [...picked, ...scored]) {
    if (out.length >= budget) break;
    const line = cleanLine(m.text, 200);
    if (!line || chars + line.length > maxChars) continue;
    chars += line.length;
    out.push({ section: m.section, text: line });
  }
  return out;
}

// ---- the prompts --------------------------------------------------------------

// -> { system, prompt, cloud }
//   cloud is null when the user allowed personal context in cloud calls (the
//   cloud then sees the same prompt), otherwise a minimal { system, prompt }.
function buildPersona({ settings, memories = [], patterns = null, contextPack, calendarBlock = '', skills = [], question, task = 'chat' }) {
  const student = skills.includes('student');
  const assistant = cleanLine(settings.assistant_name, 40) || 'CompanionDesk';
  const q = cleanLine(question, 2000);

  const about = [];
  const name = cleanLine(settings.user_name, 40);
  if (name) about.push(`- Name: ${name}`);
  for (const m of selectMemories(memories, q, { task })) about.push(`- ${m.text}`);
  if (settings.learn_from_activity) {
    const habit = describePatterns(patterns);
    if (habit) about.push(`- ${habit}`);
  }

  const system = `${rules(assistant, { student })} ${styleLines(settings)}`;
  const aboutBlock = about.length ? `${student ? 'About the student' : 'About the user'}:\n${about.join('\n')}\n\n` : '';
  const calendarPart = calendarBlock ? `${calendarBlock}\n\n` : '';
  const prompt = `${contextPack}\n\n${calendarPart}${aboutBlock}Question: ${q}`;

  const cloud = settings.cloud_personal
    ? null
    : { system: `${rules('CompanionDesk', { student })} ${styleLines(settings)}`, prompt: `${contextPack}\n\nQuestion: ${q}` };

  return { system, prompt, cloud };
}

module.exports = { rules, renderContextPack, renderCalendarBlock, selectMemories, buildPersona, tokens };
