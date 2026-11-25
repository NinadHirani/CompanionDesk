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

  const views = ['today', 'ask', 'grades', 'about', 'onboarding'];
  const hooks = {};

  function show(name) {
    for (const v of views) document.getElementById(`view-${v}`).hidden = v !== name;
    for (const b of document.querySelectorAll('#tabs button')) {
      b.classList.toggle('active', b.dataset.view === name);
      // The section tabs are buttons, not a tablist: the open section is
      // signalled with aria-current so screen readers announce it.
      if (b.dataset.view === name) b.setAttribute('aria-current', 'true');
      else b.removeAttribute('aria-current');
    }
    document.getElementById('tabs').hidden = name === 'onboarding';
    if (hooks[name]) hooks[name]();
  }

  window.UI = { api, el, plural, friendlyError: window.friendlyError, show, onShow: (name, fn) => { hooks[name] = fn; } };
})();
