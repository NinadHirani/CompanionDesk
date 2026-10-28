'use strict';

// Minimal skill/extension contract for CompanionDesk.
//
// A skill is a plain object:
//   id           unique string
//   name         human label
//   description  one line, shown in docs/settings
//   systemPrompt array of extra system-prompt lines (may be empty)
//   enabled(db)  whether the skill is active for the current database
//   context(db, helpers)  array of context-pack lines (may be empty)
//
// Skills only contribute prompt lines and context lines. They never change
// storage, network, or permission behavior. The general skill is always on;
// the student module activates only when student data exists (fresh installs
// work as a general assistant with no syllabus imported). See docs/SKILLS.md.

const GENERAL_SKILL = {
  id: 'general',
  name: 'General companion',
  description: 'The default general-purpose assistant. Always on.',
  systemPrompt: [
    'You are CompanionDesk, a general-purpose local AI companion and desktop assistant.',
    'Short, direct, lead with the answer.',
    'Dates are always explicit (e.g. "Wed Nov 5"), never vague ("next week").',
    'If the context does not contain the answer, say so plainly.',
  ],
  enabled: () => true,
  context: () => [],
};

const STUDENT_SKILL = {
  id: 'student',
  name: 'Student module',
  description: 'Optional: courses, deadlines and syllabus import. Active only when student data exists.',
  systemPrompt: [
    'When student context is present, act as a chief of staff for it.',
    'NEVER invent a deadline or a course.',
  ],
  enabled: (db) => {
    try { return Boolean(db && db.listCourses && db.listCourses().length); } catch { return false; }
  },
  context: (db, helpers) => {
    if (!db || !helpers) return [];
    const lines = [];
    const courses = db.listCourses();
    lines.push(`Courses: ${courses.length ? courses.map((c) => `${c.name}${c.code ? ` (${c.code})` : ''}`).join('; ') : 'none imported yet.'}`);
    const today = helpers.todayIso();
    const due = db.listDue(today, helpers.addDaysIso(today, 7));
    lines.push(due.length ? 'Due in the next 7 days:' : 'Nothing dated due in the next 7 days.');
    due.forEach((a) => lines.push(`- ${a.due_date} ${a.title} (${a.course_name}${a.date_confidence !== 'extracted' ? ', date flagged' : ''})`));
    return lines;
  },
};

function createSkills(extra) {
  const skills = [GENERAL_SKILL, STUDENT_SKILL, ...(extra || [])];
  return {
    list: () => skills,
    active(db) {
      return skills.filter((s) => {
        try { return Boolean(s.enabled(db)); } catch { return false; }
      });
    },
    system(db) {
      return this.active(db).flatMap((s) => s.systemPrompt || []).join(' ');
    },
    context(db, helpers) {
      return this.active(db).flatMap((s) => (s.context ? s.context(db, helpers) || [] : []));
    },
  };
}

module.exports = { createSkills, GENERAL_SKILL, STUDENT_SKILL };
