'use strict';
// Memory panel (M2/M4 UI slice, 26 Nov 2026). An explicit, accessible
// surface over the memory-session view. Every call goes through
// window.companiondesk's six memory channels; nothing here touches the
// About-me file directly and main stays authoritative. The consent gate is
// a real control: search results hide sensitive entries unless the
// per-search consent box is set for that one search. Sensitive state stays
// session-only by the owner's 26 Nov decision: the "try to save" button
// exists so the fail-closed refusal is VISIBLE, never silent, and nothing
// here chooses a persistence format. Rendering is textContent only; the
// pure shaper (CompanionMemoryView) turns channel responses into bounded
// plain-text lines.
(function () {
  const METHODS = ['memory_items', 'memory_add', 'memory_forget', 'memory_mark', 'memory_persist', 'memory_search'];

  function api() {
    const a = typeof window !== 'undefined' ? window.companiondesk : null;
    if (!a || typeof a !== 'object') return null;
    for (const m of METHODS) {
      if (typeof a[m] !== 'function') return null;
    }
    return a;
  }

  function view() {
    return (typeof window !== 'undefined' && window.CompanionMemoryView) || null;
  }

  function el(tag) {
    return document.createElement(tag);
  }

  function line(text) {
    const d = el('div');
    d.textContent = text;
    return d;
  }

  let statusEl = null;

  function say(text) {
    if (statusEl) statusEl.textContent = text;
  }

  // The shaper's outcome formatter is guarded like every other call: a
  // partial or missing shaper degrades to the plain confirmation, it
  // never crashes a click handler.
  function outcomeText(v, r) {
    return v && typeof v.shapeOutcome === 'function' ? v.shapeOutcome(r) : 'memory: done';
  }

  // Every button guards itself: while its async work is in flight, a
  // second click is a no-op (the bridge call is not re-fired), and the
  // button is re-enabled when the work settles, whatever the outcome. A
  // throw that escapes the handler still lands as a status line, never an
  // unhandled rejection.
  function button(label, ariaLabel, onClick) {
    const b = el('button');
    b.type = 'button';
    b.textContent = label;
    b.setAttribute('aria-label', ariaLabel);
    b.addEventListener('click', () => {
      if (b.disabled) return;
      b.disabled = true;
      Promise.resolve()
        .then(onClick)
        .catch(() => say('memory: unavailable right now'))
        .then(() => { b.disabled = false; });
    });
    return b;
  }

  // One bridge call, always error-safe: a refusal or failure becomes a
  // status line, never an unhandled rejection and never a retry.
  async function attempt(fn) {
    try {
      return await fn();
    } catch (e) {
      say('memory: unavailable right now');
      return null;
    }
  }

  function panelEl() {
    let panel = document.getElementById('memory-panel');
    if (!panel) {
      panel = el('section');
      panel.id = 'memory-panel';
      panel.setAttribute('role', 'region');
      panel.setAttribute('aria-label', 'Memory panel');
      document.body.appendChild(panel);
    }
    return panel;
  }

  function buildStatic(panel) {
    if (panel.dataset.built === 'true') return;
    panel.dataset.built = 'true';
    const h = el('h2');
    h.textContent = 'Memory';
    panel.appendChild(h);
    statusEl = el('p');
    statusEl.id = 'memory-panel-status';
    statusEl.setAttribute('aria-live', 'polite');
    panel.appendChild(statusEl);
    const list = el('div');
    list.id = 'memory-panel-list';
    panel.appendChild(list);
    // Add: a section select, a text input, and an explicit session-only
    // (sensitive) choice that is off by default, so a plain add never
    // becomes sensitive by accident.
    const addBox = el('div');
    addBox.id = 'memory-panel-add';
    const secLabel = el('label');
    secLabel.setAttribute('for', 'memory-add-section');
    secLabel.textContent = 'Section';
    const sec = el('select');
    sec.id = 'memory-add-section';
    const textLabel = el('label');
    textLabel.setAttribute('for', 'memory-add-text');
    textLabel.textContent = 'Text';
    const inp = el('input');
    inp.type = 'text';
    inp.id = 'memory-add-text';
    const keep = el('input');
    keep.type = 'checkbox';
    keep.id = 'memory-add-sensitive';
    const keepLabel = el('label');
    keepLabel.setAttribute('for', 'memory-add-sensitive');
    keepLabel.textContent = 'keep session-only (sensitive, not saved)';
    const addBtn = button('add', 'Add this memory bullet', async () => {
      const a = api();
      if (!a) { say('memory: unavailable right now'); return; }
      const text = inp.value;
      if (!text.trim()) { say('memory: enter some text first'); return; }
      const r = await attempt(() => a.memory_add({ section: sec.value, text, sensitive: keep.checked }));
      if (r !== null) {
        const v = view();
        say(outcomeText(v, r));
        if (r && r.ok) inp.value = '';
      }
      await refresh();
    });
    addBox.appendChild(secLabel);
    addBox.appendChild(sec);
    addBox.appendChild(textLabel);
    addBox.appendChild(inp);
    addBox.appendChild(keep);
    addBox.appendChild(keepLabel);
    addBox.appendChild(addBtn);
    panel.appendChild(addBox);
    // Search: the consent box IS the consent gate, one search at a time,
    // and it starts off: sensitive entries stay hidden by default. The
    // budget and matched-terms lines come from the pure shaper.
    const searchBox = el('div');
    searchBox.id = 'memory-panel-search';
    const qLabel = el('label');
    qLabel.setAttribute('for', 'memory-search-query');
    qLabel.textContent = 'Search';
    const q = el('input');
    q.type = 'search';
    q.id = 'memory-search-query';
    const consent = el('input');
    consent.type = 'checkbox';
    consent.id = 'memory-search-consent';
    const consentLabel = el('label');
    consentLabel.setAttribute('for', 'memory-search-consent');
    consentLabel.textContent = 'include sensitive entries (I consent for this search)';
    const results = el('div');
    results.id = 'memory-panel-results';
    const searchBtn = button('search', 'Search memory with matched terms and budget', async () => {
      const a = api();
      if (!a) return;
      if (!q.value.trim()) { say('memory: enter a search first'); return; }
      const r = await attempt(() => a.memory_search({ query: q.value, includeSensitive: consent.checked }));
      if (r === null) return; // attempt already announced the failure
      const v = view();
      if (!v || typeof v.shapeSearch !== 'function') {
        say('memory: unavailable right now');
        return;
      }
      const shaped = v.shapeSearch(r);
      results.textContent = '';
      if (shaped && shaped.ok === true) {
        results.appendChild(line(shaped.header));
        for (const t of shaped.lines) results.appendChild(line(t));
        if (shaped.hidden > 0) results.appendChild(line('memory: ' + shaped.hidden + ' further results not shown'));
        say('memory: search done');
      } else {
        say('memory: search unavailable');
      }
    });
    searchBox.appendChild(qLabel);
    searchBox.appendChild(q);
    searchBox.appendChild(consent);
    searchBox.appendChild(consentLabel);
    searchBox.appendChild(searchBtn);
    panel.appendChild(searchBox);
    panel.appendChild(results);
  }

  async function refresh() {
    const a = api();
    if (!a) return;
    const panel = panelEl();
    buildStatic(panel);
    const list = document.getElementById('memory-panel-list');
    const v = view();
    if (!v || typeof v.shapeItems !== 'function') {
      // A missing or partial shaper must degrade to an honest unavailable
      // state at mount, never an unhandled rejection.
      list.textContent = '';
      list.appendChild(line('memory: unavailable'));
      say('memory: unavailable right now');
      return;
    }
    const res = await attempt(() => a.memory_items({}));
    if (!res || res.ok !== true) {
      list.textContent = '';
      list.appendChild(line('memory: unavailable'));
      return;
    }
    const shaped = v.shapeItems(res.items);
    list.textContent = '';
    const sec = document.getElementById('memory-add-section');
    if (sec) {
      sec.textContent = '';
      for (const s of res.sections || []) {
        const opt = el('option');
        opt.value = s;
        opt.textContent = s;
        sec.appendChild(opt);
      }
    }
    for (const t of shaped.lines) list.appendChild(line(t));
    if (shaped.hidden > 0) list.appendChild(line('memory: ' + shaped.hidden + ' older entries not shown'));
    if (shaped.skipped > 0) list.appendChild(line('memory: ' + shaped.skipped + ' malformed entries not shown'));
    const byId = new Map((Array.isArray(res.items) ? res.items : []).map((it) => [it.id, it]));
    for (const act of shaped.actions) {
      const it = byId.get(act.id);
      if (!it) continue;
      if (act.kind === 'mark') {
        list.appendChild(button('mark', 'Mark ' + act.id + ' sensitive', async () => {
          const r = await attempt(() => a.memory_mark({ id: act.id, value: true }));
          if (r !== null) say(outcomeText(v, r));
          await refresh();
        }));
      } else if (act.kind === 'unmark') {
        list.appendChild(button('unmark', 'Remove the sensitive mark from ' + act.id, async () => {
          const r = await attempt(() => a.memory_mark({ id: act.id, value: false }));
          if (r !== null) say(outcomeText(v, r));
          await refresh();
        }));
      } else if (act.kind === 'forget') {
        list.appendChild(button('forget', 'Forget ' + act.id, async () => {
          const r = await attempt(() => a.memory_forget({ section: it.section, text: it.text }));
          if (r !== null) say(outcomeText(v, r));
          await refresh();
        }));
      } else if (act.kind === 'persist') {
        list.appendChild(button('try to save', 'Attempt to save ' + act.id + ', expected to be refused', async () => {
          const r = await attempt(() => a.memory_persist({ id: act.id }));
          if (r !== null) say(outcomeText(v, r));
          await refresh();
        }));
      }
    }
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', refresh);
    else refresh();
  }
})();
