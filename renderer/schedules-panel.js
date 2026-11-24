'use strict';
// Schedules panel (M5 slice 2). The proactive scheduler's user surface:
// list, create, pause, resume and cancel — every write is an explicit
// user gesture on a button below. Rendering is textContent only; a
// refused or missing channel keeps the panel quiet and retries nothing.
// The scheduler itself stays main-side and agent-free; this panel only
// speaks the five product channels.
(function () {
  const METHODS = ['schedules_list', 'schedules_create', 'schedules_update', 'schedules_pause', 'schedules_resume', 'schedules_cancel'];

  function api() {
    const a = typeof window !== 'undefined' ? window.companiondesk : null;
    if (!a || typeof a !== 'object') return null;
    for (const m of METHODS) {
      if (typeof a[m] !== 'function') return null;
    }
    return a;
  }

  function line(text) {
    const el = document.createElement('div');
    el.textContent = text;
    return el;
  }

  function panelEl() {
    let panel = document.getElementById('schedules-panel');
    if (!panel) {
      panel = document.createElement('section');
      panel.id = 'schedules-panel';
      document.body.appendChild(panel);
    }
    return panel;
  }

  function ensureForm(panel) {
    let form = panel.querySelector('#schedules-form');
    if (form) return form;
    const label = document.createElement('h2');
    label.textContent = 'Schedules';
    panel.appendChild(label);
    form = document.createElement('div');
    form.id = 'schedules-form';
    const title = document.createElement('input');
    title.id = 'schedules-title';
    title.type = 'text';
    title.maxLength = 120;
    title.placeholder = 'What should I remind you about?';
    const scope = document.createElement('select');
    scope.id = 'schedules-scope';
    for (const s of ['reminder', 'deadline']) {
      const o = document.createElement('option');
      o.value = s;
      o.textContent = s;
      scope.appendChild(o);
    }
    const when = document.createElement('input');
    when.id = 'schedules-when';
    when.type = 'datetime-local';
    const create = document.createElement('button');
    create.id = 'schedules-create';
    create.textContent = 'Add schedule';
    const cancelEdit = document.createElement('button');
    cancelEdit.id = 'schedules-cancel-edit';
    cancelEdit.textContent = 'Stop editing';
    cancelEdit.style.display = 'none';
    const msg = document.createElement('span');
    msg.id = 'schedules-msg';
    form.dataset.editing = '';
    form.appendChild(title);
    form.appendChild(scope);
    form.appendChild(when);
    form.appendChild(create);
    form.appendChild(cancelEdit);
    form.appendChild(msg);
    panel.appendChild(form);

    function stopEditing() {
      form.dataset.editing = '';
      title.value = '';
      when.value = '';
      scope.disabled = false;
      create.textContent = 'Add schedule';
      cancelEdit.style.display = 'none';
      msg.textContent = '';
    }
    cancelEdit.addEventListener('click', stopEditing);

    create.addEventListener('click', async () => {
      const a = api();
      if (!a) return;
      msg.textContent = '';
      const t = title.value.trim();
      const ms = when.value ? new Date(when.value).getTime() : NaN;
      if (!t || !Number.isSafeInteger(ms)) { msg.textContent = 'Add a title and a date.'; return; }
      try {
        if (form.dataset.editing) {
          const res = await a.schedules_update({ id: form.dataset.editing, title: t, dueAt: ms });
          if (res && res.ok) { stopEditing(); msg.textContent = 'Saved.'; refresh(); }
          else msg.textContent = 'Refused: ' + ((res && res.reason) || 'unknown');
        } else {
          const res = await a.schedules_create({ title: t, scope: scope.value, dueAt: ms });
          if (res && res.ok) { title.value = ''; when.value = ''; msg.textContent = 'Added.'; refresh(); }
          else msg.textContent = 'Refused: ' + ((res && res.reason) || 'unknown');
        }
      } catch (e) { /* stays quiet */ }
    });
    form.startEditing = function (rec) {
      form.dataset.editing = rec.id;
      title.value = rec.title;
      const d = new Date(rec.dueAt);
      const pad = (n) => String(n).padStart(2, '0');
      when.value = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
      scope.disabled = true; // the scope of an existing schedule does not change
      create.textContent = 'Save changes';
      cancelEdit.style.display = '';
      title.focus();
    };
    return form;
  }

  async function refresh() {
    const a = api();
    if (!a) return;
    try {
      const res = await a.schedules_list({ limit: 20 });
      const panel = panelEl();
      ensureForm(panel);
      const listEl = document.createElement('div');
      listEl.id = 'schedules-list';
      const old = panel.querySelector('#schedules-list');
      if (old) old.replaceWith(listEl);
      const records = res && res.ok && Array.isArray(res.schedules) ? res.schedules : [];
      if (!records.length) listEl.appendChild(line('No schedules yet. Nothing is monitored and nothing fires until you add one.'));
      try {
        const st = await a.settings_get();
        const s = st && st.ok && st.settings ? st.settings : null;
        if (s && !s.proactive_enabled) listEl.appendChild(line('Delivery is off in settings (About > Proactive reminders): schedules are listed but nothing notifies until you turn it on.'));
        else if (s && !s.proactive_scope_reminder && records.some((r) => r.scope === 'reminder')) listEl.appendChild(line('Reminder scope delivery is off in settings.'));
        else if (s && !s.proactive_scope_deadline && records.some((r) => r.scope === 'deadline')) listEl.appendChild(line('Deadline scope delivery is off in settings.'));
      } catch (e) { /* the state line is best-effort only */ }
      const view = (typeof window !== 'undefined' && window.CompanionSchedulesView) || null;
      if (view && typeof view.shape === 'function') {
        const shaped = view.shape(records, { max: 10 });
        for (const text of shaped.lines) listEl.appendChild(line(text));
        if (shaped.hidden > 0) listEl.appendChild(line(shaped.hidden + ' older not shown'));
        if (shaped.skipped > 0) listEl.appendChild(line(shaped.skipped + ' malformed record(s) not shown'));
        for (const act of shaped.actions) {
          const btn = document.createElement('button');
          btn.textContent = act.kind + ' ' + act.id;
          btn.addEventListener('click', async () => {
            const a2 = api();
            if (!a2) return;
            try {
              if (act.kind === 'edit') {
                const rec = records.find((r) => r && r.id === act.id);
                if (rec) ensureForm(panel).startEditing(rec);
                return;
              }
              const fn = act.kind === 'pause' ? a2.schedules_pause : act.kind === 'resume' ? a2.schedules_resume : a2.schedules_cancel;
              await fn({ id: act.id });
              refresh();
            } catch (e) { /* stays quiet */ }
          });
          listEl.appendChild(btn);
        }
      }
    } catch (e) {
      // Refusals and absences keep the panel quiet; nothing retries here.
    }
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', refresh);
    else refresh();
  }
})();
