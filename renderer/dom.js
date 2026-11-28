'use strict';

// Shared helpers for every view. DOM is built with textContent only; nothing
// from the database or the model is ever parsed as HTML.
(function () {
  const api = window.companiondesk;

  function el(tag, text, cls) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (cls) node.className = cls;
    return node;
  }

  function plural(n, word) {
    return `${n} ${word}${n === 1 ? '' : 's'}`;
  }

  const views = ['today', 'ask', 'grades', 'about', 'workspace', 'onboarding'];
  const hooks = {};

  function show(name) {
    for (const v of views) { const sec = document.getElementById(`view-${v}`); if (sec) sec.hidden = v !== name; }
    for (const b of document.querySelectorAll('#tabs button')) {
      b.classList.toggle('active', b.dataset.view === name);
      // The section tabs are buttons, not a tablist: the open section is
      // signalled with aria-current so screen readers announce it.
      if (b.dataset.view === name) b.setAttribute('aria-current', 'true');
      else b.removeAttribute('aria-current');
    }
    document.getElementById('tabs').hidden = name === 'onboarding';
      // Focus strand: a switch can hide the section keyboard focus was in
  // (the onboarding handoff is the live path), and a hidden element
  // cannot hold focus. If the focused element was stranded inside a
  // hidden section, land it on the section now shown; otherwise never
  // steal focus (a click on a tab keeps its own focus). Hooks run after
  // and may move focus themselves.
  const shown = document.getElementById(`view-${name}`);
  const active = document.activeElement;
  if (shown && active) {
    let inHidden = false;
    for (const v of views) {
      if (v === name) continue;
      const sec = document.getElementById(`view-${v}`);
      if (sec && sec.hidden && sec.contains(active)) inHidden = true;
    }
    if (inHidden) {
      shown.setAttribute('tabindex', '-1');
      shown.focus();
    }
  }
  if (hooks[name]) hooks[name]();
  }

  window.UI = { api, el, plural, friendlyError: window.friendlyError, show, onShow: (name, fn) => { hooks[name] = fn; } };
})();
