'use strict';

// Calendar helpers on the user's LOCAL day. The clock is a parameter so tests
// never depend on when they run.

function pad(n) {
  return String(n).padStart(2, '0');
}

// Local calendar day as YYYY-MM-DD.
function todayIso(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// Local date and time as YYYY-MM-DDTHH:MM:SS (no zone suffix), so the first ten
// characters are always the user's own calendar day.
function localNowIso(now = new Date()) {
  return `${todayIso(now)}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

// ISO day arithmetic, done in UTC so DST never shifts the result.
function addDaysIso(iso, days) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

module.exports = { todayIso, localNowIso, addDaysIso };
