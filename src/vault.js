'use strict';

// Markdown vault export: every structured fact the database holds also lives
// in plain, user-owned markdown files (the Nūs philosophy: open every file,
// delete the folder and it is gone).

const fs = require('fs');
const path = require('path');
const { isConfirmedDate } = require('./extraction-core');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function slugify(name) {
  return String(name || 'class').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'class';
}

function fmtDate(iso) {
  if (!iso) return null;
  const d = new Date(iso + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return null;
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

function writeClassFile(vaultDir, { course, grade_weights, assignments, warnings }) {
  fs.mkdirSync(vaultDir, { recursive: true });
  const file = path.join(vaultDir, `${slugify(course.name)}.md`);
  const lines = [];
  lines.push(`# ${course.name}`);
  if (course.code) lines.push(`Code: ${course.code}`);
  if (course.term) lines.push(`Term: ${course.term}`);
  if (course.credit_hours !== null && course.credit_hours !== undefined) lines.push(`Credits: ${course.credit_hours}`);
  lines.push('');
  if (grade_weights.length) {
    lines.push('## Grading');
    for (const w of grade_weights) lines.push(`- ${w.category}: ${w.weight_pct}%`);
    lines.push('');
  }
  lines.push('## Deadlines');
  lines.push('| Due | Title | Category | Confidence |');
  lines.push('|---|---|---|---|');
  const sorted = [...assignments].sort((a, b) => {
    if (!a.due_date) return 1;
    if (!b.due_date) return -1;
    return a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : 0;
  });
  for (const a of sorted) {
    const conf = a.date_confidence === 'manual' ? 'ok (added by you)' : isConfirmedDate(a.date_confidence) ? 'ok' : `flagged (${a.date_confidence}; verify in LMS)`;
    lines.push(`| ${fmtDate(a.due_date) || 'TBA'} | ${a.title} | ${a.category || ''} | ${conf} |`);
  }
  if (warnings && warnings.length) {
    lines.push('', '## Flags', ...warnings.map((w) => `- ${w}`));
  }
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

function writeSemesterOverview(vaultDir, courses) {
  fs.mkdirSync(vaultDir, { recursive: true });
  const file = path.join(vaultDir, 'semester-overview.md');
  const lines = ['# Semester overview', '', '| Class | Code | Term | Source |', '|---|---|---|---|'];
  for (const c of courses) lines.push(`| ${c.name} | ${c.code || ''} | ${c.term || ''} | ${c.source_file || ''} |`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

module.exports = { slugify, fmtDate, writeClassFile, writeSemesterOverview };
