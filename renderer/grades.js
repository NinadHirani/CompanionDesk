'use strict';

// Grades: enter scores, set a target, see what the rest of the course needs.
// Nothing is guessed. If the syllabus weights do not add up to 100, the page
// says so and does not project.
(function () {
  const { api, el, plural } = UI;
  const { fmtDay } = window.CompanionFormat;
  const body = document.getElementById('grades-body');

  function pct(n) {
    return `${Number.isInteger(n) ? n : n.toFixed(2).replace(/0$/, '')}%`;
  }

  function projectionText(course) {
    const p = course.projection;
    if (!p) return { text: 'Set a target to see what the rest of the course needs.', cls: 'hint' };
    if (p.status === 'secured') return { text: `A ${pct(course.target)} is already secured, whatever the rest brings.`, cls: 'ok-line' };
    if (p.status === 'nothing_left') return { text: 'Everything is graded. There is nothing left to project.', cls: 'hint' };
    if (p.status === 'needed' && p.reachable) {
      return { text: `To finish on ${pct(course.target)}, the remaining ${pct(course.standing.remainingWeight)} of the grade needs to average ${pct(p.needed)}.`, cls: '' };
    }
    if (p.status === 'needed') {
      return { text: `A ${pct(course.target)} is out of reach: it would need ${pct(p.needed)} on the remaining ${pct(course.standing.remainingWeight)}.`, cls: 'error' };
    }
    if (p.reason === 'weights_incomplete') {
      return { text: `Cannot project: the grading weights add up to ${pct(course.standing.totalWeight)}, not 100%. A category may be missing from the syllabus.`, cls: 'error' };
    }
    return { text: 'That target does not look right.', cls: 'error' };
  }

  function numberInput(label, value, onCommit) {
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0';
    input.max = '100';
    input.step = 'any';
    input.setAttribute('aria-label', label);
    if (value !== null && value !== undefined) input.value = String(value);
    input.addEventListener('change', () => onCommit(input.value.trim() === '' ? null : Number(input.value), input));
    return input;
  }

  function renderCourse(course) {
    const card = el('section', null, 'card');
    card.appendChild(el('h2', `${course.name}${course.code ? ' (' + course.code + ')' : ''}`));

    const st = course.standing;
    if (st.currentPct === null) card.appendChild(el('p', 'No scores yet. Enter one below.', 'hint'));
    else card.appendChild(el('p', `Current: ${pct(st.currentPct)} on the ${pct(st.gradedWeight)} of the grade graded so far.`));

    if (course.weights.length) {
      card.appendChild(el('p', 'Weights: ' + course.weights.map((w) => `${w.category} ${pct(w.weight_pct)}`).join(', '), 'meta'));
    } else {
      card.appendChild(el('p', 'This syllabus has no grading weights, so nothing can be projected.', 'hint error'));
    }

    const msg = el('p', null, 'hint');
    msg.setAttribute('role', 'status');
    const targetRow = el('div', null, 'field inline');
    targetRow.appendChild(el('label', 'My target (%)'));
    targetRow.appendChild(numberInput('Target percent', course.target, async (v, input) => {
      const res = await api.grades_setTarget({ courseId: course.id, target: v });
      if (!res.ok) { msg.textContent = UI.friendlyError(res.error); msg.className = 'hint error'; input.focus(); return; }
      await refresh();
    }));
    card.appendChild(targetRow);

    const proj = projectionText(course);
    card.appendChild(el('p', proj.text, proj.cls));
    card.appendChild(msg);

    if (st.unweighted.length) {
      card.appendChild(el('p', `Not counted, no matching grading category: ${st.unweighted.join(', ')}.`, 'hint'));
    }

    const list = el('ul', null, 'rows plain-rows');
    for (const a of course.assignments) {
      const li = document.createElement('li');
      const what = el('div', null, 'what');
      what.appendChild(el('div', a.title, 'title'));
      what.appendChild(el('div', [a.category, a.due_date ? fmtDay(a.due_date) : 'no confirmed date'].filter(Boolean).join(', '), 'meta'));
      li.appendChild(what);
      li.appendChild(numberInput(`Score for ${a.title}, percent`, a.score, async (v, input) => {
        const res = await api.grades_setScore({ id: a.id, score: v });
        if (!res.ok) { msg.textContent = UI.friendlyError(res.error); msg.className = 'hint error'; input.focus(); return; }
        await refresh();
      }));
      list.appendChild(li);
    }
    card.appendChild(list);
    card.appendChild(el('p', st.assumption + ' Each score is a percent from 0 to 100.', 'hint'));
    return card;
  }

  async function refresh() {
    const res = await api.grades_get();
    body.replaceChildren();
    if (!res.ok || !res.courses.length) {
      body.appendChild(el('section', null, 'card')).appendChild(el('p', 'No courses yet. Import a syllabus first.', 'empty'));
      return;
    }
    for (const c of res.courses) body.appendChild(renderCourse(c));
  }

  UI.grades = { refresh };
  UI.onShow('grades', () => { refresh(); });
})();
