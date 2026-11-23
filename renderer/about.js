'use strict';

// About me: what the assistant knows (a plain markdown file the student can
// edit), suggestions waiting for a yes or no, habits, and settings.
(function () {
  const { api, el, plural } = UI;

  const secSelect = document.getElementById('mem-section');

  // ---- suggestions waiting for a decision (shown on Ask and About me) ----------
  function renderProposals(proposals) {
    for (const id of ['ask-proposals', 'about-proposals']) {
      const box = document.getElementById(id);
      box.replaceChildren();
      for (const p of proposals) {
        const card = el('section', null, 'card proposal');
        card.appendChild(el('p', 'Want me to remember this?', 'hint'));
        card.appendChild(el('p', `${p.text}`));
        card.appendChild(el('p', p.section, 'meta'));
        const actions = el('div', null, 'actions');
        const yes = el('button', 'Yes, remember it', 'primary');
        const no = el('button', 'No');
        yes.addEventListener('click', () => decide(p.id, true));
        no.addEventListener('click', () => decide(p.id, false));
        actions.append(yes, no);
        card.appendChild(actions);
        box.appendChild(card);
      }
    }
  }

  async function refreshProposals() {
    const res = await api.memory_list();
    if (res.ok) renderProposals(res.proposals);
  }

  async function decide(id, approve) {
    const res = await api.memory_decide({ id, approve });
    if (res.ok) renderProposals(res.proposals);
    if (!document.getElementById('view-about').hidden) await refresh();
  }

  // ---- what I know ----------------------------------------------------------------
  function renderItems(res) {
    document.getElementById('about-file').textContent = `Stored in a plain file you can open and edit: ${res.file}`;
    const box = document.getElementById('about-items');
    box.replaceChildren();

    const sections = [...res.sections];
    for (const it of res.items) if (!sections.includes(it.section)) sections.push(it.section);

    let any = false;
    for (const section of sections) {
      const items = res.items.filter((i) => i.section === section);
      if (!items.length) continue;
      any = true;
      box.appendChild(el('h3', section));
      const ul = el('ul', null, 'rows plain-rows');
      for (const it of items) {
        const li = document.createElement('li');
        li.appendChild(el('span', it.text));
        const forget = el('button', 'Forget');
        forget.setAttribute('aria-label', `Forget: ${it.text}`);
        forget.addEventListener('click', async () => {
          await api.memory_forget({ section: it.section, text: it.text });
          await refresh();
        });
        li.appendChild(forget);
        ul.appendChild(li);
      }
      box.appendChild(ul);
    }
    if (!any) box.appendChild(el('p', 'Nothing yet. Add something below, or just ask me a question and mention yourself.', 'empty'));

    if (!secSelect.options.length) for (const s of res.sections) secSelect.appendChild(new Option(s, s));
  }

  document.getElementById('mem-add').addEventListener('click', async () => {
    const text = document.getElementById('mem-text');
    const msg = document.getElementById('mem-msg');
    const res = await api.memory_add({ section: secSelect.value, text: text.value });
    if (!res.ok) { msg.textContent = UI.friendlyError(res.error); msg.className = 'hint error'; return; }
    text.value = '';
    msg.textContent = 'Saved.';
    msg.className = 'hint';
    await refresh();
  });

  // ---- habits ---------------------------------------------------------------------
  function renderPatterns(p) {
    const t = document.getElementById('patterns-text');
    if (!p.learning) t.textContent = 'Learning from your activity is switched off.';
    else if (p.summary) t.textContent = p.summary;
    else t.textContent = `Not enough yet. ${plural(p.samples, 'finished item')} so far, and I need three before I say anything.`;
  }

  document.getElementById('activity-clear').addEventListener('click', async () => {
    await api.activity_clear();
    await refresh();
  });

  // ---- settings -------------------------------------------------------------------
  const F = {
    user: document.getElementById('s-user'),
    assistant: document.getElementById('s-assistant'),
    student: document.getElementById('s-student'),
    tone: document.getElementById('s-tone'),
    brevity: document.getElementById('s-brevity'),
    language: document.getElementById('s-language'),
    learn: document.getElementById('s-learn'),
    suggest: document.getElementById('s-suggest'),
    cloud: document.getElementById('s-cloud'),
    aimodel: document.getElementById('s-aimodel'),
    visionmodel: document.getElementById('s-visionmodel'),
  };

  function fillSettings(s) {
    F.user.value = s.user_name;
    F.assistant.value = s.assistant_name;
    F.student.value = s.student_module;
    F.tone.value = s.tone;
    F.brevity.value = s.brevity;
    F.language.value = s.language;
    F.learn.checked = s.learn_from_activity;
    F.suggest.checked = s.suggest_memories;
    F.cloud.checked = s.cloud_personal;
    F.aimodel.value = s.ai_model_local || '';
    F.visionmodel.value = s.ai_model_vision || '';
  }

  // Model choices come only from what Ollama already has installed; nothing
  // is pulled from here. A saved model that has disappeared resets to Default.
  async function fillModels(s) {
    const res = await api.ai_models();
    const note = document.getElementById('models-note');
    if (!res.ok || !res.ollama) {
      F.aimodel.innerHTML = '<option value="">Default</option>';
      F.visionmodel.innerHTML = '<option value="">Default</option>';
      if (note) note.textContent = res.ok ? 'Ollama is not running right now; the default models are used.' : '';
      return;
    }
    const addDefault = (sel, label) => {
      sel.innerHTML = '';
      const o = document.createElement('option');
      o.value = '';
      o.textContent = `Default (${label})`;
      sel.appendChild(o);
    };
    addDefault(F.aimodel, res.defaults.chat);
    for (const name of res.installed || []) {
      const o = document.createElement('option');
      o.value = name;
      o.textContent = name;
      F.aimodel.appendChild(o);
    }
    F.aimodel.value = s.ai_model_local || '';
    if (F.aimodel.selectedIndex === -1) F.aimodel.value = '';
    addDefault(F.visionmodel, res.defaults.vision);
    for (const name of res.installed || []) {
      const o = document.createElement('option');
      o.value = name;
      const st = res.caps && res.caps[name];
      o.textContent = name + (Array.isArray(st) ? (st.includes('vision') ? '' : ' (not a vision model)') : ' (vision unverified)');
      F.visionmodel.appendChild(o);
    }
    F.visionmodel.value = s.ai_model_vision || '';
    if (F.visionmodel.selectedIndex === -1) F.visionmodel.value = '';
    if (note) note.textContent = '';
  }

  document.getElementById('settings-save').addEventListener('click', async () => {
    const msg = document.getElementById('settings-msg');
    const res = await api.settings_save({
      user_name: F.user.value,
      assistant_name: F.assistant.value,
      student_module: F.student.value,
      tone: F.tone.value,
      brevity: F.brevity.value,
      language: F.language.value,
      learn_from_activity: F.learn.checked,
      suggest_memories: F.suggest.checked,
      cloud_personal: F.cloud.checked,
      ai_model_local: F.aimodel.value,
      ai_model_vision: F.visionmodel.value,
    });
    if (res.ok) { fillSettings(res.settings); msg.textContent = 'Saved.'; msg.className = 'hint'; UI.today.refresh(); }
    else { msg.textContent = UI.friendlyError(res.error); msg.className = 'hint error'; }
  });

  // ---- overlay shortcut ----------------------------------------------------------
  const ovInput = document.getElementById('ov-hotkey');
  const ovMsg = document.getElementById('ov-msg');
  document.getElementById('ov-save').addEventListener('click', async () => {
    const res = await api.overlay_setHotkey({ accelerator: ovInput.value });
    if (res.ok) { ovInput.value = res.hotkey; ovMsg.textContent = `Saved. Press ${res.hotkey} to open the overlay.`; ovMsg.className = 'hint'; }
    else { ovMsg.textContent = UI.friendlyError(res.error); ovMsg.className = 'hint error'; }
  });
  document.getElementById('ov-open').addEventListener('click', () => api.overlay_show());

  // ---- setup check ---------------------------------------------------------------
  const STATUS_TEXT = { ok: 'Ready', needed: 'Needed', optional: 'Optional' };

  async function loadHealth() {
    const res = await api.health_check();
    const body = document.getElementById('health-body');
    const summary = document.getElementById('health-summary');
    body.replaceChildren();
    UI.today.refreshStatus(); // keep the top-bar chip in step with this check
    if (!res.ok) { summary.textContent = 'The setup check could not run.'; return; }
    summary.textContent = res.ready
      ? 'Ready. Everything needed to answer questions is set up. Optional features are listed below.'
      : 'Not ready yet. Fix the items marked Needed.';
    summary.className = res.ready ? '' : 'error';
    for (const it of res.items) {
      const row = el('div', null, `health-row health-${it.status}`);
      const head = el('div', null, 'health-head');
      head.appendChild(el('span', STATUS_TEXT[it.status], `badge badge-${it.status}`));
      head.appendChild(el('strong', it.label));
      row.appendChild(head);
      row.appendChild(el('p', it.detail, 'hint'));
      if (it.fix) {
        if (it.fix.text) row.appendChild(el('p', it.fix.text));
        if (it.fix.command) {
          const line = el('div', null, 'cmd');
          line.appendChild(el('code', it.fix.command));
          const copy = el('button', 'Copy');
          copy.setAttribute('aria-label', `Copy: ${it.fix.command}`);
          copy.addEventListener('click', async () => {
            try { await navigator.clipboard.writeText(it.fix.command); copy.textContent = 'Copied'; } catch { copy.textContent = 'Select and copy it'; }
          });
          line.appendChild(copy);
          row.appendChild(line);
        }
      }
      body.appendChild(row);
    }
  }
  document.getElementById('health-refresh').addEventListener('click', loadHealth);

  // ---- privacy policy and terms, shipped with the app ------------------------------
  let docsLoaded = false;
  async function loadDocs() {
    if (docsLoaded) return;
    const d = await api.app_docs();
    document.getElementById('app-version').textContent = d.version ? `CompanionDesk ${d.version}. Free, local, no accounts.` : 'CompanionDesk. Free, local, no accounts.';
    document.getElementById('doc-privacy').textContent = d.privacy || 'The privacy policy file is missing from this install.';
    document.getElementById('doc-terms').textContent = d.terms || 'The terms file is missing from this install.';
    docsLoaded = true;
  }

  // Version + manual update check, only when an updater exists (desktop).
  async function refreshVersion() {
    if (typeof api.update_status !== 'function') return;
    const st = await api.update_status().catch(() => null);
    if (!st) return;
    const line = document.getElementById('about-version');
    if (!line) return;
    line.textContent = `CompanionDesk ${st.appVersion} · ${st.channel} channel`;
  }

  async function refresh() {
    refreshVersion();
    loadHealth();
    loadDocs();
    api.overlay_status().then((s) => {
      if (!s.ok) return;
      ovInput.value = s.hotkey;
      if (!s.registered) { ovMsg.textContent = `Another app is using ${s.hotkey}, so the shortcut is off. Pick a different one.`; ovMsg.className = 'hint error'; }
    });
    const [mem, pat, set] = await Promise.all([api.memory_list(), api.patterns_get(), api.settings_get()]);
    if (mem.ok) { renderItems(mem); renderProposals(mem.proposals); }
    if (pat.ok) renderPatterns(pat);
    if (set.ok) { fillSettings(set.settings); fillModels(set.settings); }
  }

  UI.about = { renderProposals, refreshProposals, refresh };
  UI.onShow('about', () => { refresh(); });
})();
