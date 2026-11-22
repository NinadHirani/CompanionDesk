'use strict';

// Date labels for the renderer. Pure and dual-mode: a plain <script> tag in
// the page (window.CompanionFormat) and require() in tests. Works on ISO
// YYYY-MM-DD strings in UTC, so the label never shifts with the time zone.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CompanionFormat = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // "2026-11-04" -> "Wed Nov 4". Returns null for anything that is not a real date.
  function fmtDay(iso) {
    if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
    const d = new Date(iso + 'T00:00:00Z');
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) return null;
    return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  }

  // 0 -> "today", 1 -> "tomorrow", 5 -> "in 5 days".
  function relDays(n) {
    if (!Number.isInteger(n) || n < 0) return null;
    if (n === 0) return 'today';
    if (n === 1) return 'tomorrow';
    return `in ${n} days`;
  }

  return { fmtDay, relDays };
});
