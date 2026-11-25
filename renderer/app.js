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

  // Editing a deadline you added by hand. The row turns into a small form
  // instead of a modal, so the date and what is due stay in view. Only
  // hand-added rows get the button: a syllabus owns the rest, and the database
  // refuses the edit either way.
  // After a row editor closes, the list re-renders and the browser drops
  // focus to the page. Put it back on the row the user was working in; when
  // that row no longer exists (a successful removal, or the edit filtered the
  // row out), land on the first control of the same list instead.
  function refocusRow(id, listId) {
    const list = document.getElementById(listId);
    if (!list) return;
    const li = Array.from(list.children).find((n) => n.dataset && n.dataset.id === String(id));
    const btn = (li && li.querySelector('button')) || list.querySelector('li button');
    if (btn) btn.focus();
  }

  function editRow(li, item) {
    const form = el('div', null, 'edit-form');
    const title = document.createElement('input');
    title.type = 'text';
    title.maxLength = 120;
    title.value = item.title;
    title.setAttribute('aria-label', 'Deadline description');
    const date = document.createElement('input');
    date.type = 'date';
    date.value = item.due_date || '';
    date.setAttribute('aria-label', 'Deadline date');
    const examLabel = el('label', null, 'check');
    const exam = document.createElement('input');
    exam.type = 'checkbox';
    exam.checked = item.kind === 'exam';
    examLabel.append(exam, document.createTextNode(' This is an exam'));
    const msg = el('p', null, 'hint');
    msg.setAttribute('role', 'status');
    const actions = el('div', null, 'actions');
    const save = el('button', 'Save', 'primary');
    save.addEventListener('click', async () => {
      const res = await api.deadline_edit({ id: item.id, title: title.value, date: date.value, isExam: exam.checked });
      if (!res.ok) {
        msg.textContent = UI.friendlyError(res.error);
        msg.className = 'hint error';
        return;
      }
      await refresh();
      refocusRow(item.id, 'due-list');
    });
    const cancel = el('button', 'Cancel');
    cancel.addEventListener('click', async () => { await refresh(); refocusRow(item.id, 'due-list'); });
    actions.append(save, cancel);
    form.append(title, date, examLabel, actions, msg);
    li.replaceChildren(form);
    title.focus();
  }

  function actionButtons(item, li) {
    const box = el('div', null, 'actions');
    const done = el('button', 'Done');
    done.setAttribute('aria-label', `Mark ${item.title} done`);
    done.addEventListener('click', () => markDone(item));
    box.appendChild(done);
    if (item.manual) {
      const edit = el('button', 'Edit');
      edit.setAttribute('aria-label', `Edit ${item.title}`);
      edit.addEventListener('click', () => editRow(li, item));
      box.appendChild(edit);
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
    li.dataset.id = item.id;
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
    li.append(when, what, actionButtons(item, li));
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
    // Companion-first: the brief opens in the companion's voice.
    const cname = document.body.dataset.companionName || 'CompanionDesk';
    body.appendChild(el('p', `${cname} here.`, 'companion-lead'));

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

  // Course management, by hand: add a course you have no syllabus for, fix a
  // name or code, or remove one you dropped. Removing deletes the course's
  // assignments, scores and grades with it, so the row asks before it does.
  function courseForm(c) {
    const form = el('div', null, 'course-form');
    const name = document.createElement('input');
    name.type = 'text';
    name.maxLength = 120;
    name.value = c ? c.name : '';
    name.placeholder = 'Course name';
    name.setAttribute('aria-label', 'Course name');
    const code = document.createElement('input');
    code.type = 'text';
    code.maxLength = 40;
    code.value = c && c.code ? c.code : '';
    code.placeholder = 'Code (optional)';
    code.setAttribute('aria-label', 'Course code');
    const term = document.createElement('input');
    term.type = 'text';
    term.maxLength = 60;
    term.value = c && c.term ? c.term : '';
    term.placeholder = 'Term (optional)';
    term.setAttribute('aria-label', 'Course term');
    form.append(name, code, term);
    return { form, name, code, term };
  }

  function editCourse(li, c) {
    const { form, name, code, term } = courseForm(c);
    const msg = el('p', null, 'hint');
    msg.setAttribute('role', 'status');
    const actions = el('div', null, 'actions');
    const save = el('button', 'Save', 'primary');
    save.addEventListener('click', async () => {
      const res = await api.course_rename({ id: c.id, name: name.value, code: code.value, term: term.value });
      if (!res.ok) { msg.textContent = UI.friendlyError(res.error); msg.className = 'hint error'; return; }
      await refresh();
      refocusRow(c.id, 'course-list');
    });
    const cancel = el('button', 'Cancel');
    cancel.addEventListener('click', async () => { await refresh(); refocusRow(c.id, 'course-list'); });
    actions.append(save, cancel);
    form.append(actions, msg);
    li.replaceChildren(form);
    name.focus();
  }

  function confirmRemoveCourse(li, c) {
    const box = el('div', null, 'course-confirm');
    box.appendChild(el('p', `Remove ${c.name}? Its assignments, scores and grades go too. This cannot be undone.`));
    const msg = el('p', null, 'hint');
    msg.setAttribute('role', 'status');
    const actions = el('div', null, 'actions');
    const yes = el('button', 'Remove', 'primary');
    yes.addEventListener('click', async () => {
      const res = await api.course_remove({ id: c.id });
      if (!res.ok) { msg.textContent = UI.friendlyError(res.error); msg.className = 'hint error'; return; }
      await refresh();
      refocusRow(c.id, 'course-list');
    });
    const no = el('button', 'Cancel');
    no.addEventListener('click', async () => { await refresh(); refocusRow(c.id, 'course-list'); });
    actions.append(yes, no);
    box.append(actions, msg);
    li.replaceChildren(box);
  }

  function renderCourses(courses) {
    const ul = document.getElementById('course-list');
    ul.replaceChildren();
    if (!courses.length) ul.appendChild(el('li', 'None yet.', 'empty'));
    for (const c of courses) {
      const li = el('li', null, 'course-row');
      li.dataset.id = c.id;
      const what = el('div', null, 'what');
      what.appendChild(el('b', `${c.name}${c.code ? ' (' + c.code + ')' : ''}${c.term ? ', ' + c.term : ''}`));
      li.appendChild(what);
      const actions = el('div', null, 'actions');
      const edit = el('button', 'Edit');
      edit.setAttribute('aria-label', `Edit ${c.name}`);
      edit.addEventListener('click', () => editCourse(li, c));
      actions.appendChild(edit);
      const rm = el('button', 'Remove');
      rm.setAttribute('aria-label', `Remove ${c.name}`);
      rm.addEventListener('click', () => confirmRemoveCourse(li, c));
      actions.appendChild(rm);
      li.appendChild(actions);
      ul.appendChild(li);
    }
  }

  document.getElementById('course-add-btn').addEventListener('click', async () => {
    const name = document.getElementById('course-name');
    const code = document.getElementById('course-code');
    const msg = document.getElementById('course-msg');
    const res = await api.course_add({ name: name.value, code: code.value });
    if (!res.ok) { msg.textContent = UI.friendlyError(res.error); msg.className = 'hint error'; return; }
    name.value = '';
    code.value = '';
    msg.textContent = 'Added.';
    msg.className = 'hint';
    await refresh();
  });

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

  // Companion identity (assistant_name): the window title, the header and
  // the Ask greeting follow the name set in About. refresh() re-applies it,
  // so a settings save updates the identity immediately (About calls
  // UI.today.refresh() after saving).
  function applyIdentity(state) {
    const id = state.identity || {};
    const name = id.name || 'CompanionDesk';
    document.title = name;
    const title = document.getElementById('app-title');
    if (title) title.textContent = name;
    const greet = document.getElementById('ask-greet');
    if (greet) greet.textContent = id.greeting || '';
    document.body.dataset.companionName = name;
    const tab = document.querySelector('#tabs button[data-view="ask"]');
    if (tab) tab.textContent = name === 'CompanionDesk' ? 'Ask' : name;
    const heading = document.getElementById('ask-heading');
    if (heading) heading.textContent = name === 'CompanionDesk' ? 'Ask' : name;
  }

  async function refresh() {
    const [state, brief, cal] = await Promise.all([api.state_get(), api.brief_today(), api.calendar_upcoming({ days: 7 })]);
    latest = { state, brief };
    applyIdentity(state);
    renderCalendar(cal);
    renderStatus(state.ai);
    applyStudentVisibility(state.student);
    renderBrief(brief, state.student);
    renderCourseFilter(brief);
    renderDue(brief);
    renderCourses(state.courses);
    document.getElementById('dl-date').min = state.today;
    renderOllamaSetup(state.ai);
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
        const counts = s.refresh && s.refresh.existed
          ? `, ${s.refresh.added} added, ${s.refresh.updated} refreshed, ${s.refresh.removed} removed`
          : '';
        box.appendChild(el('p', `${s.file}: ${s.course}, ${plural(s.assignments, 'assignment')}${counts}, ${s.flagged} flagged for checking.`));
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
    renderOllamaSetup(state.ai);
  }
  window.addEventListener('focus', refreshStatus);

  // ---- Ollama one-click setup card --------------------------------------
  // Every step needs a click: nothing is installed or downloaded silently.
  const OSU = window.CompanionOllamaSetup || null;
  const isWebBuild = api && api.bridgeMode === 'web';
  let pullRunning = false;

  function fmtBytes(b) {
    const gb = b / (1024 * 1024 * 1024);
    if (gb >= 1) return `${gb.toFixed(1)} GB`;
    return `${Math.round(b / (1024 * 1024))} MB`;
  }

  function renderPullProgress(rec) {
    const bar = document.getElementById('oll-progress');
    const label = document.getElementById('oll-progress-label');
    if (!bar || !label) return;
    bar.hidden = false;
    if (rec && rec.pct !== null && rec.pct !== undefined) {
      bar.firstElementChild.style.width = `${rec.pct}%`;
      label.textContent = `${rec.pct}%`;
    } else if (rec && rec.status) {
      label.textContent = rec.status;
    }
  }

  function openInstallButton(btnLabel) {
    const btn = el('button', btnLabel, 'primary');
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try { await api.ollama_openInstall(); } catch { /* the page stays reachable */ }
      btn.disabled = false;
    });
    return btn;
  }

  function stepList(steps) {
    const list = el('ul', null);
    for (const step of steps || []) list.appendChild(el('li', step));
    return list;
  }

  async function renderOllamaSetup(aiState) {
    const card = document.getElementById('oll-setup');
    const body = document.getElementById('oll-body');
    if (!card || !body) return;
    if (!OSU) { card.hidden = true; return; }

    const ollamaRunning = Boolean(aiState && aiState.ollama);
    const modelPresent = Boolean(aiState && aiState.modelLoaded);
    const model = (aiState && aiState.model) || OSU.RECOMMENDED_MODEL;

    if (ollamaRunning && modelPresent) { card.hidden = true; return; }

    // Web/Android build: the page cannot install software or download models
    // on its own. Say what works and what the honest routes are.
    if (isWebBuild) {
      card.hidden = false;
      body.textContent = '';
      body.appendChild(el('p', ollamaRunning
        ? `Ollama is reachable, but ${model} is not downloaded yet. Pull it in a terminal on the machine running Ollama:`
        : 'This web or Android build cannot install software for you, so a local model is not set up here.'));
      if (ollamaRunning) {
        body.appendChild(el('code', `ollama pull ${model}`, 'oll-cmd'));
        body.appendChild(el('p', 'Reload or come back to this view after the download finishes.', 'setup-note'));
      } else {
        body.appendChild(el('p', 'For a fully local model use the CompanionDesk desktop app: it walks you through Ollama in one click, and nothing is installed or downloaded without your click. If Ollama is already running on this machine at port 11434, reload this page and it will be found.'));
        body.appendChild(el('p', 'AI answers in this build come only from the opt-in cloud fallback: if you add your own Gemini key, requests go to Google; otherwise nothing leaves this device. Everything except AI answers works fully here.', 'setup-note'));
      }
      return;
    }

    // Desktop build: guided setup through the official Ollama channels.
    let plan = null;
    try {
      const planRes = await api.ollama_setupPlan();
      if (planRes && planRes.ok) plan = planRes.plan;
    } catch { plan = null; }

    if (!ollamaRunning) {
      card.hidden = false;
      body.textContent = '';
      body.appendChild(el('p', 'CompanionDesk answers with a model that runs entirely on this computer. It needs Ollama installed once.'));
      body.appendChild(el('p', 'CompanionDesk never installs software itself and never downloads a model without your click. The button opens the official Ollama download page; you install and open it, and this card finishes on its own.', 'setup-note'));
      if (plan && plan.kind === 'guided') {
        body.appendChild(openInstallButton('Open the official Ollama installer'));
        const list = stepList(plan.steps);
        if (list.firstChild) body.appendChild(list);
      } else if (plan && plan.kind === 'command') {
        body.appendChild(el('p', 'Official install command. Review the script at ollama.com/download/linux, then run it yourself in a terminal:'));
        body.appendChild(el('code', plan.command, 'oll-cmd'));
        body.appendChild(openInstallButton('Open the official download page'));
        const list = stepList(plan.steps);
        if (list.firstChild) body.appendChild(list);
      } else {
        body.appendChild(el('p', 'Download Ollama from ollama.com/download and open it.'));
      }
      return;
    }

    // Ollama runs; the model needs downloading.
    const st = OSU.setupState({ ollamaRunning: true, modelPresent, model });
    if (st.stage !== 'pull') { card.hidden = true; return; }
    card.hidden = false;
    body.textContent = '';
    body.appendChild(el('p', `One download left: ${st.model} (${st.size.label}). It stays on this machine; nothing is sent anywhere.`));
    let enough = true;
    if (st.size.bytes) {
      try {
        const disk = await api.ollama_diskCheck({ neededBytes: st.size.bytes });
        if (disk && disk.ok) {
          enough = Boolean(disk.enough);
          body.appendChild(el('p', enough
            ? `Free space on disk: ${fmtBytes(disk.freeBytes)}. Enough for the download plus headroom.`
            : `Free space on disk: ${fmtBytes(disk.freeBytes)}, but the download needs about ${fmtBytes(disk.neededBytes)} with headroom. Free some space first.`, 'setup-note'));
        }
      } catch { /* disk check is best-effort */ }
    }
    const bar = el('div', null, 'setup-progress');
    bar.id = 'oll-progress';
    bar.hidden = true;
    bar.appendChild(el('div'));
    const label = el('span', null);
    label.id = 'oll-progress-label';
    const btn = el('button', `Download ${st.model} (${st.size.label})`, 'primary');
    btn.disabled = pullRunning || !enough;
    const cancel = el('button', 'Cancel');
    cancel.hidden = !pullRunning;
    btn.addEventListener('click', async () => {
      if (pullRunning) return;
      pullRunning = true;
      btn.hidden = true;
      cancel.hidden = false;
      label.textContent = 'Starting download...';
      try {
        const res = await api.ollama_pullStart({ model: st.model });
        if (res && res.ok) {
          label.textContent = 'Downloaded.';
        } else {
          label.textContent = res && res.error === 'cancelled'
            ? 'Download cancelled. Nothing was kept.'
            : `Download failed: ${(res && res.error) || 'unknown error'}. You can retry below.`;
          bar.firstElementChild.style.width = '0%';
          const retry = el('button', 'Retry download', 'primary');
          retry.addEventListener('click', () => { retry.remove(); btn.click(); });
          body.appendChild(retry);
        }
      } catch (err) {
        label.textContent = `Download failed: ${String((err && err.message) || err)}. You can retry below.`;
      } finally {
        pullRunning = false;
        cancel.hidden = true;
        await refreshStatus();
      }
    });
    cancel.addEventListener('click', async () => {
      try { await api.ollama_pullCancel(); } catch { /* the pull resolves on abort */ }
    });
    body.appendChild(btn);
    body.appendChild(cancel);
    body.appendChild(bar);
    body.appendChild(label);
  }

  // Progress is pushed from the main process during a user-started download.
  try { api.on('ollama:pullProgress', renderPullProgress); } catch { /* no push channel here */ }

  UI.today = { refresh, refreshStatus };
  UI.onShow('today', () => { refresh(); });
})();
