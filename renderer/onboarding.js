'use strict';

// First run: seven short, skippable questions. Everything the student says
// becomes a plain line in their about-me file or a setting; the closing
// privacy question only explains the standing defaults and applies nothing.
(function () {
  const { api, el } = UI;
  let questions = [];
  let index = 0;
  let selected = null;

  const prompt = document.getElementById('ob-prompt');
  const inputBox = document.getElementById('ob-input');
  const progress = document.getElementById('ob-progress');
  const msg = document.getElementById('ob-msg');
  const nextBtn = document.getElementById('ob-next');

  function renderQuestion() {
    const q = questions[index];
    selected = null;
    msg.textContent = '';
    progress.textContent = `Question ${index + 1} of ${questions.length}. Every one can be skipped.`;
    prompt.textContent = q.title || q.prompt;
    if (q.title) {
      const body = el('p', q.prompt, 'hint');
      inputBox.replaceChildren(body);
    } else {
      inputBox.replaceChildren();
    }

    if (q.kind === 'choice') {
      nextBtn.hidden = false;
      const group = el('div', null, 'choices');
      group.setAttribute('role', 'radiogroup');
      group.setAttribute('aria-label', q.title || q.prompt);
      const choose = (b) => {
        selected = b.textContent;
        for (const other of group.children) {
          other.setAttribute('aria-checked', String(other === b));
          other.classList.toggle('chosen', other === b);
          other.tabIndex = other === b ? 0 : -1;
        }
        nextBtn.focus();
      };
      let i = 0;
      for (const opt of q.options) {
        const b = el('button', opt);
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-checked', 'false');
        b.tabIndex = i === 0 ? 0 : -1; // roving focus, the radiogroup contract
        b.addEventListener('click', () => choose(b));
        i += 1;
        group.appendChild(b);
      }
      group.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        e.preventDefault();
        const opts = [...group.children];
        const at = opts.indexOf(document.activeElement);
        const next = e.key === 'ArrowDown' ? (at + 1) % opts.length : (at - 1 + opts.length) % opts.length;
        for (const [j, o] of opts.entries()) o.tabIndex = j === next ? 0 : -1;
        choose(opts[next]);
        opts[next].focus();
      });
      inputBox.appendChild(group);
      group.children[0].focus();
    } else {
      nextBtn.hidden = false;
      const field = document.createElement('input');
      field.id = 'ob-field';
      field.setAttribute('aria-label', q.prompt);
      if (q.kind === 'number') { field.type = 'number'; field.min = String(q.min); field.max = String(q.max); }
      else { field.type = 'text'; field.maxLength = 200; }
      field.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(false); } });
      inputBox.appendChild(field);
      field.focus();
    }
  }

  function currentAnswer() {
    const q = questions[index];
    if (q.kind === 'choice') return selected;
    const field = document.getElementById('ob-field');
    return field ? field.value : '';
  }

  async function finish() {
    // A bridge or transport crash must not strand the interview: the
    // failure is reported in place and the view stays until completing
    // actually succeeded. Today's refresh is allowed to fail without
    // blocking the handoff to the companion chat, since the interview is
    // already done at that point.
    try {
      await api.onboarding_complete();
    } catch (e) {
      msg.textContent = UI.friendlyError('bad_request');
      return;
    }
    try {
      await UI.today.refresh();
    } catch (e) { /* the handoff does not depend on it */ }
    UI.show('ask'); // companion-first: setup ends in the companion chat
  }

  // Skipping everything ends the interview for good (it never runs again),
  // so a single accidental click must not do that: the first click asks,
  // the second click confirms.
  let finishArmed = false;
  document.getElementById('ob-finish').addEventListener('click', () => {
    if (!finishArmed) {
      finishArmed = true;
      document.getElementById('ob-finish').textContent = 'Really skip the rest?';
      return;
    }
    finishArmed = false;
    document.getElementById('ob-finish').textContent = 'Skip the rest';
    finish();
  });

  function disarmFinish() {
    if (!finishArmed) return;
    finishArmed = false;
    document.getElementById('ob-finish').textContent = 'Skip the rest';
  }

  async function submit(skip) {
    disarmFinish();
    const q = questions[index];
    // Past the last question the only pending step is the completion
    // itself: a crash there must be retried as a completion, never as a
    // phantom answer to a question that no longer exists.
    if (!q) { await finish(); return; }
    if (!skip) {
      let res;
      try {
        res = await api.onboarding_answer({ id: q.id, answer: currentAnswer() });
      } catch (e) {
        // A bridge or transport crash must not strand the interview: the
        // failure is reported in place, the answer stays in the field and
        // the question stays put for a retry.
        msg.textContent = UI.friendlyError('bad_request');
        return;
      }
      if (!res.ok) { msg.textContent = UI.friendlyError(res.error); return; }
    }
    index += 1;
    if (index >= questions.length) await finish();
    else renderQuestion();
  }

  nextBtn.addEventListener('click', () => submit(false));
  document.getElementById('ob-skip').addEventListener('click', () => submit(true));
  // ob-finish is wired inside the confirm guard above; a second direct
  // listener here would finish on the first click and defeat the guard.

  async function start() {
    const res = await api.onboarding_get();
    if (!res.ok || res.done) return false;
    questions = res.questions;
    index = 0;
    renderQuestion();
    return true;
  }

  UI.onboarding = { start };
})();
