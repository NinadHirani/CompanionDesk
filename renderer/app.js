'use strict';

// Today view: the brief, the upcoming list, hand-added deadlines.
(function () {
  const { api, el, plural } = UI;
  const { fmtDay, relDays } = window.CompanionFormat;

  const REASONS = {
    'no-date': 'no date in the syllabus',
    'invalid-date': 'the date could not be read',
    flagged: 'the date needs checking',
  };

  const view = { windowDays: 7, course: 'all', sort: 'date' };
  let latest = { state: null, brief: null };
  let undoTimer = null;

  function renderStatus(ai) {
    const chip = document.getElementById('ai-status');
    if (ai.ollama) {
      chip.textContent = ai.modelLoaded
        ? `Local model ready: ${ai.model}`
        : `Ollama is running, ${ai.model} is not pulled yet`;
      chip.className = 'status ok';
    } else {
      chip.textContent = 'Ollama not detected. Everything except AI answers still works.';
      chip.className = 'status warn';
    }
  }

  // The status chip is a shortcut to the setup check.
  const chip = document.getElementById('ai-status');
  chip.title = 'Open the setup check';
  chip.addEventListener('click', () => UI.show('about'));

  async function markDone(item) {
    const res = await api.assignment_setDone({ id: item.id, done: true });
    if (!res.ok) return;
    showUndo(item);
    await refresh();
  }

  function showUndo(item) {
    const bar = document.getElementById('undo-bar');
    document.getElementById('undo-text').textContent = `Marked done: ${item.title}`;
    bar.hidden = false;
    document.getElementById('undo-btn').onclick = async () => {
      await api.assignment_setDone({ id: item.id, done: false });
      bar.hidden = true;
      await refresh();
    };
    clearTimeout(undoTimer);
    undoTimer = setTimeout(() => { bar.hidden = true; }, 8000);
  }

  function actionButtons(item) {
    const box = el('div', null, 'actions');
    const done = el('button', 'Done');
    done.setAttribute('aria-label', `Mark ${item.title} done`);
    done.addEventListener('click', () => markDone(item));
    box.appendChild(done);
    if (item.manual) {
      const rm = el('button', 'Remove');
      rm.setAttribute('aria-label', `Remove ${item.title}`);
      rm.addEventListener('click', async () => {
        await api.deadline_remove({ id: item.id });
        await refresh();
      });
      box.appendChild(rm);
    }
    return box;
  }

  function itemRow(item) {
    const li = document.createElement('li');
    const when = el('div', null, 'when');
    when.appendChild(el('b', fmtDay(item.due_date)));
    when.appendChild(el('span', relDays(item.daysUntil)));
    const what = el('div', null, 'what');
    const title = el('div', item.title, 'title');
    if (item.kind === 'exam') title.appendChild(el('span', 'Exam', 'tag'));
    if (item.manual) title.appendChild(el('span', 'Added by you', 'tag'));
    what.appendChild(title);
    const meta = [item.course, item.weight_pct !== null && item.weight_pct !== undefined ? `worth ${item.weight_pct}% of the course` : null].filter(Boolean).join(', ');
    if (meta) what.appendChild(el('div', meta, 'meta'));
    li.append(when, what, actionButtons(item));
    return li;
  }

  // Student tools are one optional skill: Grades and Courses show only once
  // there is course data, and Import disappears if the user switched them off.
  function applyStudentVisibility(student) {
    document.querySelector('#tabs [data-view="grades"]').hidden = !student.active;
    document.getElementById('courses-card').hidden = !student.active;
    document.getElementById('import-btn').hidden = !student.enabled;
  }

  function renderBrief(brief, student) {
    const body = document.getElementById('brief-body');
    body.replaceChildren();

    if (!brief.top.length) {
      body.appendChild(el('p', student.active
        ? 'No confirmed deadlines ahead.'
        : `Nothing coming up. Add a deadline on the right${student.enabled ? ', or import a syllabus' : ''}.`, 'empty'));
    } else {
      const list = el('ul', null, 'rows');
      for (const item of brief.top) list.appendChild(itemRow(item));
      body.appendChild(list);
    }

    for (const c of brief.crunch) {
      const box = el('div', null, 'crunch');
      box.setAttribute('role', 'note');
      box.appendChild(el('strong', `Heavy stretch: ${fmtDay(c.start)} to ${fmtDay(c.end)}`));
      box.appendChild(el('span', `${plural(c.deliverables, 'deliverable')} and ${plural(c.exams, 'exam')} within one week.`));
      const ul = document.createElement('ul');
      for (const it of c.items) ul.appendChild(el('li', `${fmtDay(it.due_date)}  ${it.title}${it.course ? ' (' + it.course + ')' : ''}`));
      box.appendChild(ul);
      body.appendChild(box);
    }

    if (brief.unconfirmed.length) {
      const d = el('details', null, 'unconfirmed');
      d.appendChild(el('summary', `${plural(brief.unconfirmed.length, 'item')} without a confirmed date`));
      d.appendChild(el('p', 'These are not counted above. Check them in your LMS.', 'empty'));
      const ul = document.createElement('ul');
      for (const u of brief.unconfirmed) {
        ul.appendChild(el('li', `${u.title}${u.course ? ' (' + u.course + ')' : ''}: ${REASONS[u.reason] || 'date unconfirmed'}`));
      }
      d.appendChild(ul);
      body.appendChild(d);
    }
  }

  function filteredUpcoming(brief) {
    let items = brief.upcoming;
    if (view.windowDays > 0) items = items.filter((i) => i.daysUntil <= view.windowDays);
    if (view.course !== 'all') items = items.filter((i) => i.course === view.course);
    if (view.sort === 'worth') {
      // Heaviest first; items with no known weight go last, in date order.
      items = [...items].sort((a, b) => (b.weight_pct ?? -1) - (a.weight_pct ?? -1) || a.due_date.localeCompare(b.due_date));
    } else if (view.sort === 'course') {
      items = [...items].sort((a, b) => String(a.course).localeCompare(String(b.course)) || a.due_date.localeCompare(b.due_date));
    }
    return items;
  }

  function renderCourseFilter(brief) {
    const sel = document.getElementById('f-course');
    const names = [...new Set(brief.upcoming.map((i) => i.course).filter(Boolean))].sort();
    if (view.course !== 'all' && !names.includes(view.course)) view.course = 'all';
    sel.replaceChildren(new Option('all courses', 'all'));
    for (const n of names) sel.appendChild(new Option(n, n));
    sel.value = view.course;
  }

  function renderDue(brief) {
    const list = document.getElementById('due-list');
    list.replaceChildren();
    const items = filteredUpcoming(brief);
    if (!items.length) {
      list.appendChild(el('li', 'Nothing matches these filters.', 'empty'));
      return;
    }
    for (const item of items) list.appendChild(itemRow(item));
  }

  function renderCourses(courses) {
    const ul = document.getElementById('course-list');
    ul.replaceChildren();
    if (!courses.length) ul.appendChild(el('li', 'None yet.', 'empty'));
    for (const c of courses) {
      ul.appendChild(el('li', `${c.name}${c.code ? ' (' + c.code + ')' : ''}${c.term ? ', ' + c.term : ''}`));
    }
  }

  // ---- calendar ---------------------------------------------------------------
  function renderCalendar(res) {
    const body = document.getElementById('cal-body');
    body.replaceChildren();
    if (!res.ok || !res.calendars.length) {
      body.appendChild(el('p', 'No calendar imported. Export one from your calendar app as .ics and import it here. It stays on this computer.', 'hint'));
      return;
    }
    if (!res.occurrences.length) body.appendChild(el('p', 'Nothing on your calendar this week.', 'empty'));
    let lastDate = null;
    for (const o of res.occurrences) {
      if (o.date !== lastDate) { body.appendChild(el('h3', fmtDay(o.date))); lastDate = o.date; }
      const when = o.allDay ? 'All day' : `${o.time}${o.endTime ? ' to ' + o.endTime : ''}`;
      body.appendChild(el('p', `${when}  ${o.title}${o.location ? ' (' + o.location + ')' : ''}`, 'cal-line'));
    }
    if (res.unsupportedCount) {
      body.appendChild(el('p', `${plural(res.unsupportedCount, 'repeating event')} use a repeat rule I cannot expand, so each shows once.`, 'hint'));
    }
    for (const name of res.calendars) {
      const b = el('button', `Remove ${name}`);
      b.addEventListener('click', async () => { await api.calendar_remove({ name }); await refresh(); });
      body.appendChild(b);
    }
  }

  document.getElementById('cal-import').addEventListener('click', async () => {
    const msg = document.getElementById('cal-msg');
    const res = await api.calendar_import();
    if (res.canceled) return;
    if (!res.ok) { msg.textContent = UI.friendlyError(res.error); msg.className = 'hint error'; return; }
    msg.textContent = `Imported ${plural(res.events, 'event')} from ${res.name}.`;
    msg.className = 'hint';
    await refresh();
  });

  async function refresh() {
    const [state, brief, cal] = await Promise.all([api.state_get(), api.brief_today(), api.calendar_upcoming({ days: 7 })]);
    latest = { state, brief };
    renderCalendar(cal);
    renderStatus(state.ai);
    applyStudentVisibility(state.student);
    renderBrief(brief, state.student);
    renderCourseFilter(brief);
    renderDue(brief);
    renderCourses(state.courses);
    document.getElementById('dl-date').min = state.today;
    return state;
  }

  for (const [id, key, conv] of [['f-window', 'windowDays', Number], ['f-course', 'course', String], ['f-sort', 'sort', String]]) {
    document.getElementById(id).addEventListener('change', (e) => {
      view[key] = conv(e.target.value);
      if (latest.brief) renderDue(latest.brief);
    });
  }

  document.getElementById('dl-add').addEventListener('click', async () => {
    const title = document.getElementById('dl-title');
    const date = document.getElementById('dl-date');
    const msg = document.getElementById('dl-msg');
    const exam = document.getElementById('dl-exam');
    const res = await api.deadline_add({ title: title.value, date: date.value, isExam: exam.checked });
    if (!res.ok) { msg.textContent = UI.friendlyError(res.error); msg.className = 'hint error'; return; }
    title.value = '';
    date.value = '';
    exam.checked = false;
    msg.textContent = 'Added.';
    msg.className = 'hint';
    await refresh();
  });

  document.getElementById('import-btn').addEventListener('click', async () => {
    const box = document.getElementById('import-result');
    box.replaceChildren();
    box.appendChild(el('p', 'Importing'));
    const res = await api.syllabus_import();
    box.replaceChildren();
    if (!res.ok) { box.appendChild(el('p', 'Import cancelled.')); return; }
    for (const s of res.summaries) {
      if (s.ok) {
        box.appendChild(el('p', `${s.file}: ${s.course}, ${plural(s.assignments, 'assignment')}, ${s.flagged} flagged for checking.`));
      } else {
        box.appendChild(el('p', `${s.file}: ${s.message || s.error}`, 'error'));
      }
    }
    await refresh();
  });

  // Re-read just the model status (cheap). Runs after the setup check and
  // whenever the window regains focus, e.g. after installing Ollama.
  async function refreshStatus() {
    const state = await api.state_get();
    renderStatus(state.ai);
  }
  window.addEventListener('focus', refreshStatus);

  UI.today = { refresh, refreshStatus };
  UI.onShow('today', () => { refresh(); });
})();
