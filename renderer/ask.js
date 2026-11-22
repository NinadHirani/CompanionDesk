'use strict';

// Ask view: a question, a personal answer, and, afterwards, any "remember
// this?" suggestions for the student to accept or ignore.
(function () {
  const { api, el } = UI;
  const input = document.getElementById('ask-input');
  const btn = document.getElementById('ask-btn');
  const log = document.getElementById('ask-log');

  async function submit() {
    const question = input.value.trim();
    if (!question) { input.focus(); return; }
    btn.disabled = true;

    const entry = el('section', null, 'card qa');
    entry.appendChild(el('p', question, 'q'));
    const pending = el('p', 'Thinking', 'hint');
    entry.appendChild(pending);
    log.prepend(entry);
    input.value = '';

    const res = await api.ai_ask({ prompt: question });
    pending.remove();
    if (res.ok) {
      entry.appendChild(el('p', res.answer, 'answer'));
    } else {
      entry.appendChild(el('p', UI.friendlyError(res.error), 'error'));
    }
    btn.disabled = false;

    if (res.ok) {
      // Runs after the answer is on screen; a slow model never delays it.
      const s = await api.memory_suggest({ message: question });
      if (s.ok) UI.about.renderProposals(s.proposals);
    }
  }

  btn.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
  });
  UI.onShow('ask', () => { input.focus(); UI.about.refreshProposals(); });
})();
