'use strict';

const api = window.companiondesk;

function el(tag, text, cls) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (cls) node.className = cls;
  return node;
}

async function refresh() {
  const state = await api.state_get();
  const chip = document.getElementById('ai-status');
  if (state.ai.ollama) {
    chip.textContent = state.ai.modelLoaded
      ? `Local model ready: ${state.ai.model} (Ollama)`
      : `Ollama running; model ${state.ai.model} not pulled yet`;
    chip.className = 'status ok';
  } else {
    chip.textContent = 'Ollama not detected; app works without AI, cloud fallback only if you add a key';
    chip.className = 'status warn';
  }

  const due = document.getElementById('due-list');
  due.replaceChildren();
  if (!state.due.length) due.appendChild(el('li', 'Nothing dated due in the next 7 days.'));
  for (const a of state.due) {
    const flag = a.date_confidence === 'extracted' ? '' : ' (date flagged, verify in LMS)';
    due.appendChild(el('li', `${a.due_date}  ${a.title}  — ${a.course_name}${flag}`));
  }

  const courses = document.getElementById('course-list');
  courses.replaceChildren();
  if (!state.courses.length) courses.appendChild(el('li', 'No courses imported yet. Drop in a syllabus PDF.'));
  for (const c of state.courses) {
    courses.appendChild(el('li', `${c.name}${c.code ? ' (' + c.code + ')' : ''}${c.term ? ' · ' + c.term : ''}`));
  }
}

document.getElementById('import-btn').addEventListener('click', async () => {
  const box = document.getElementById('import-result');
  box.replaceChildren();
  box.appendChild(el('p', 'Importing...'));
  const res = await api.syllabus_import();
  box.replaceChildren();
  if (!res.ok) { box.appendChild(el('p', 'Import cancelled.')); return; }
  for (const s of res.summaries) {
    if (s.ok) {
      box.appendChild(el('p', `${s.file}: ${s.course} — ${s.assignments} assignments, ${s.flagged} flagged for verification.`));
    } else {
      box.appendChild(el('p', `${s.file}: ${s.message || s.error}`, 'error'));
    }
  }
  await refresh();
});

refresh();
