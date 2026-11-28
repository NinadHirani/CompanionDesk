'use strict';

// Update banner. The main process decides everything (policy lives in
// src/update-policy.js) and pushes a ready-to-render snapshot over
// update:state; this file only renders text and buttons and asks for the
// exact action the snapshot names. In the web bundle there is no updater, so
// the module leaves quietly.

(function () {
  const api = window.companiondesk;
  if (!api || typeof api.update_status !== 'function') return;

  const bar = document.getElementById('update-bar');
  const text = document.getElementById('update-text');
  // Pushed state changes (update available, progress, errors) must reach
  // screen readers without focus: role="status" gives the text implicit
  // polite-live semantics, so a text change is announced where focus sits.
  text.setAttribute('role', 'status');
  const actions = document.getElementById('update-actions');
  let hideTimer = null;

  function button(action) {
    const b = document.createElement('button');
    b.textContent = action.label;
    b.addEventListener('click', () => run(action.kind));
    return b;
  }

  function dismiss() {
    bar.hidden = true;
  }

  function run(kind) {
    const map = {
      install: api.update_install,
      download: api.update_download,
      'open-download-page': api.update_openReleases,
      check: api.update_check,
    };
    const call = map[kind];
    if (!call) return;
    // A bridge or transport crash on a click must not be a silent no-op:
    // the main process reports its own failures as error states, but a
    // crashed renderer-side call never reaches it. The banner reports the
    // failure in place, the same rule as every other ask path.
    Promise.resolve().then(call.bind(api)).catch(() => {
      if (window.friendlyError) text.textContent = window.friendlyError('bad_request');
      else text.textContent = 'That did not go through. Try again.';
      bar.hidden = false;
      bar.className = 'update-bar error';
      // The failed action stays offered as a retry: reporting the crash
      // without a way to try again would strand the banner.
      actions.replaceChildren(button({ kind, label: 'Try again' }));
    });
  }

  function render(state) {
    if (!state || state.mode === 'disabled') return;
    if (state.phase === 'idle') {
      bar.hidden = true;
      return;
    }
    // Transient states (checking, none, downloading) calm down on their own;
    // actions and errors stay until the user does something.
    bar.hidden = false;
    bar.className = `update-bar ${state.phase === 'error' ? 'error' : ''}`;
    text.textContent = state.text || '';
    actions.replaceChildren();
    if (state.action) actions.appendChild(button(state.action));
    if (state.phase === 'none') {
      const ok = document.createElement('button');
      ok.textContent = 'Close';
      ok.addEventListener('click', dismiss);
      actions.appendChild(ok);
      clearTimeout(hideTimer);
      hideTimer = setTimeout(dismiss, 6000);
    } else {
      clearTimeout(hideTimer);
    }
  }

  api.on('update:state', render);
  api.update_status().then(render).catch(() => {});
})();
