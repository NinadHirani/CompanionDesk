'use strict';
// M2/M4 memory panel shaper (26 Nov 2026): pure view-model for the
// renderer's memory panel, in the schedules-view pattern: no DOM, no IPC,
// no storage. It shapes plain objects into bounded, human-readable lines
// and action lists. The status language is deliberate:
//   - [sensitive] marks a sensitivity CLASSIFICATION, never consent;
//   - [saved] means the bullet is the user's own file content;
//   - [session-only, not saved] means it lives only for this session and
//     dies with it (the owner's 26 Nov decision: no on-disk sensitive
//     format exists);
//   - a sensitive mark on a saved bullet is itself session-only and is
//     labelled so, because a restart drops the mark by design.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CompanionMemoryView = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const MAX_ITEMS = 60;
  const MAX_RESULTS = 20;

  function shapeItems(items) {
    const list = Array.isArray(items)
      ? items.filter((it) => it && typeof it.id === 'string' && typeof it.section === 'string' && typeof it.text === 'string')
      : [];
    const skipped = (Array.isArray(items) ? items.length : 0) - list.length;
    const lines = [];
    const actions = [];
    const shown = list.slice(0, MAX_ITEMS);
    for (const it of shown) {
      const saved = it.persisted !== false;
      const status = saved ? '[saved]' : '[session-only, not saved]';
      const sens = it.sensitive ? ' [sensitive]' : '';
      const markNote = it.sensitive && saved ? ' (mark is session-only; a restart drops it)' : '';
      lines.push(it.id + ' ' + status + sens + ' ' + it.section + ': ' + it.text + markNote);
      actions.push({ id: it.id, kind: it.sensitive ? 'unmark' : 'mark' });
      actions.push({ id: it.id, kind: 'forget' });
      if (!saved) actions.push({ id: it.id, kind: 'persist' });
    }
    return { ok: true, lines, actions, hidden: Math.max(0, list.length - shown.length), skipped };
  }

  function shapeSearch(res) {
    if (!res || res.ok !== true) return { ok: false, error: 'unavailable' };
    const results = Array.isArray(res.results) ? res.results.filter((r) => r && typeof r.text === 'string') : [];
    const shown = results.slice(0, MAX_RESULTS);
    const noun = (n) => (n === 1 ? 'sensitive entry' : 'sensitive entries');
    const consent = res.sensitiveIncluded > 0
      ? res.sensitiveIncluded + ' ' + noun(res.sensitiveIncluded) + ' included with consent'
      : (res.sensitiveTotal > 0
        ? res.sensitiveTotal + ' ' + noun(res.sensitiveTotal) + ' hidden (no consent for this search)'
        : 'no sensitive entries');
    const header = 'task budget: ' + res.task + ' keeps ' + res.budget
      + ' \u00b7 shown ' + shown.length + ' of ' + res.candidates + ' \u00b7 ' + consent;
    const lines = shown.map((r) => {
      const score = typeof r.score === 'number' ? r.score.toFixed(2) : '?';
      const terms = Array.isArray(r.matched) && r.matched.length ? ' \u2014 matched: ' + r.matched.join(', ') : '';
      return r.id + ' [' + r.section + '] ' + r.text + ' (score ' + score + terms + ')';
    });
    return { ok: true, header, lines, hidden: Math.max(0, results.length - shown.length) };
  }

  // Plain-text outcomes for the status region. This panel speaks in its own
  // words: it imports no friendlyError module.
  function shapeOutcome(r) {
    if (!r) return 'memory: no response';
    if (r.ok === true) {
      if (r.persisted === false) return 'memory: kept session-only (not saved)';
      return 'memory: done';
    }
    const detail = typeof r.detail === 'string' && r.detail.length ? ': ' + r.detail : '';
    return 'memory: refused (' + (r.error || 'unknown') + ')' + detail;
  }

  return { shapeItems, shapeSearch, shapeOutcome, MAX_ITEMS, MAX_RESULTS };
});
