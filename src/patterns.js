'use strict';

// Habits learned from what the user actually does, computed locally with plain
// arithmetic. No model is involved and nothing here is guessed: with fewer
// than MIN_SAMPLES finished items it reports no style at all.
//
// Input rows come from the events table: { due_date: 'YYYY-MM-DD', at } where
// `at` is the LOCAL date-time the item was marked done ('YYYY-MM-DDTHH:MM:SS'),
// so its first ten characters are the user's own calendar day.

const MIN_SAMPLES = 3;
const MS_PER_DAY = 86400000;

function dayNumber(iso) {
  const ms = Date.parse(iso + 'T00:00:00Z');
  return Number.isNaN(ms) ? null : Math.round(ms / MS_PER_DAY);
}

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// -> { samples, medianLeadDays, lateCount, style }
//   leadDays = days between finishing and the due date (negative = finished late)
//   style    'early' (median >= 3), 'steady' (>= 1), 'last-minute' (< 1), or null
function computePatterns(doneEvents) {
  const leads = [];
  for (const e of doneEvents || []) {
    const due = typeof e.due_date === 'string' ? dayNumber(e.due_date) : null;
    const doneDay = typeof e.at === 'string' ? dayNumber(e.at.slice(0, 10)) : null;
    if (due === null || doneDay === null) continue;
    leads.push(due - doneDay);
  }
  const samples = leads.length;
  const out = { samples, medianLeadDays: null, lateCount: leads.filter((d) => d < 0).length, style: null };
  if (samples < MIN_SAMPLES) return out;
  out.medianLeadDays = median(leads);
  out.style = out.medianLeadDays >= 3 ? 'early' : out.medianLeadDays >= 1 ? 'steady' : 'last-minute';
  return out;
}

// One plain sentence for the prompt, or null when there is nothing solid to say.
function describePatterns(p) {
  if (!p || !p.style) return null;
  const days = Math.max(0, Math.round(p.medianLeadDays));
  if (p.style === 'last-minute') return `Usually finishes work on the day it is due (from ${p.samples} items marked done).`;
  return `Usually finishes work about ${days} day${days === 1 ? '' : 's'} before it is due (from ${p.samples} items marked done).`;
}

module.exports = { MIN_SAMPLES, computePatterns, describePatterns };
