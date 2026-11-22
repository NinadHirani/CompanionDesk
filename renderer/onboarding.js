'use strict';

// First run: six short, skippable questions. Everything the student says
// becomes a plain line in their about-me file or a setting.
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
    prompt.textContent = q.prompt;
    inputBox.replaceChildren();

    if (q.kind === 'choice') {
      nextBtn.hidden = false;
      const group = el('div', null, 'choices');
      group.setAttribute('role', 'radiogroup');
      for (const opt of q.options) {
        const b = el('button', opt);
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-checked', 'false');
        b.addEventListener('click', () => {
          selected = opt;
          for (const other of group.children) {
            other.setAttribute('aria-checked', String(other === b));
            other.classList.toggle('chosen', other === b);
          }
        });
        group.appendChild(b);
      }
      inputBox.appendChild(group);
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
    await api.onboarding_complete();
    await UI.today.refresh();
    UI.show('today');
  }

  async function submit(skip) {
    const q = questions[index];
    if (!skip) {
      const res = await api.onboarding_answer({ id: q.id, answer: currentAnswer() });
      if (!res.ok) { msg.textContent = UI.friendlyError(res.error); return; }
    }
    index += 1;
    if (index >= questions.length) await finish();
    else renderQuestion();
  }

  nextBtn.addEventListener('click', () => submit(false));
  document.getElementById('ob-skip').addEventListener('click', () => submit(true));
  document.getElementById('ob-finish').addEventListener('click', finish);

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
