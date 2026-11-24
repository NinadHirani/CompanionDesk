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
    hwprofile: document.getElementById('s-hwprofile'),
    hwnote: document.getElementById('hw-note'),
    proactive: document.getElementById('s-proactive'),
    proactiveRem: document.getElementById('s-proactive-rem'),
    proactiveDeadline: document.getElementById('s-proactive-deadline'),
    proactiveQuiet: document.getElementById('s-proactive-quiet'),
    quietStart: document.getElementById('s-quiet-start'),
    quietEnd: document.getElementById('s-quiet-end'),
    voice: document.getElementById('s-voice'),
    voiceOutput: document.getElementById('s-voice-output'),
    wake: document.getElementById('s-wake'),
    wakeThreshold: document.getElementById('s-wake-threshold'),
    wakeStart: document.getElementById('wake-start'),
    wakePause: document.getElementById('wake-pause'),
    wakeResume: document.getElementById('wake-resume'),
    wakeStop: document.getElementById('wake-stop'),
    wakeStatus: document.getElementById('wake-status'),
    screenMode: document.getElementById('s-screen-mode'),
    screenConsent: document.getElementById('s-screen-consent'),
    screenNote: document.getElementById('screen-mode-note'),
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
    if (F.hwprofile) F.hwprofile.value = s.hardware_profile;
    if (F.proactive) F.proactive.checked = s.proactive_enabled === true;
    if (F.proactiveRem) F.proactiveRem.checked = s.proactive_scope_reminder === true;
    if (F.proactiveDeadline) F.proactiveDeadline.checked = s.proactive_scope_deadline === true;
    if (F.proactiveQuiet) F.proactiveQuiet.checked = s.proactive_quiet_enabled !== false;
    if (F.quietStart) F.quietStart.value = s.proactive_quiet_start || '22:00';
    if (F.quietEnd) F.quietEnd.value = s.proactive_quiet_end || '08:00';
    if (F.voice) F.voice.checked = s.voice_enabled === true;
    if (F.voiceOutput) F.voiceOutput.checked = s.voice_output_enabled === true;
    if (F.wake) F.wake.checked = s.wake_enabled === true;
    if (F.wakeThreshold) F.wakeThreshold.value = String(s.wake_threshold);
    if (F.screenMode) F.screenMode.value = s.screen_mode || 'manual';
    if (F.screenConsent) F.screenConsent.checked = s.screen_background_consent === true;
    syncScreenMode();
  }

  // Background assist needs its own consent box ticked; the picker makes
  // that visible instead of failing silently at save time.
  function syncScreenMode() {
    if (!F.screenMode || !F.screenConsent || !F.screenNote) return;
    const wantsConsent = F.screenMode.value === 'background';
    F.screenConsent.parentElement.style.display = wantsConsent ? '' : 'none';
    F.screenNote.textContent = wantsConsent
      ? 'Background assist is laptop/desktop only. It will not run until you explicitly start it, and it never runs on Android.'
      : '';
  }
  if (F.screenMode) F.screenMode.addEventListener('change', syncScreenMode);

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

  // Hardware facts come from the main process already sanitized: coarse
  // memory buckets only, never an exact reading. The profile steers only
  // the DEFAULT models; anything picked explicitly always wins.
  async function fillHardware() {
    const note = F.hwnote;
    if (!note) return;
    let res = null;
    try { res = await api.hardware_report(); } catch { res = null; }
    if (!res || !res.ok) { note.textContent = ''; return; }
    const bits = [];
    if (res.memoryLabel && res.memoryLabel !== 'unknown') bits.push(`${res.memoryLabel} memory`);
    if (res.coresTier === 'low') bits.push('a light CPU');
    else if (res.coresTier === 'medium') bits.push('a mid-range CPU');
    else if (res.coresTier === 'high') bits.push('a multicore CPU');
    const rec = res.recommendation || {};
    const recBits = [];
    if (rec.chat) recBits.push(`chat: ${rec.chat}`);
    if (rec.vision) recBits.push(`vision: ${rec.vision}`);
    note.textContent = `This computer: ${bits.join(', ') || 'details unknown'}. Profile: ${res.profile}. `
      + `Suggested defaults for it: ${recBits.join(', ') || 'keep the current ones'}. A model you pick yourself always wins.`;
  }

  document.getElementById('settings-save').addEventListener('click', async () => {
    const msg = document.getElementById('settings-msg');
    const payload = {
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
    };
    if (F.hwprofile) payload.hardware_profile = F.hwprofile.value;
    if (F.proactive) payload.proactive_enabled = F.proactive.checked;
    if (F.proactiveRem) payload.proactive_scope_reminder = F.proactiveRem.checked;
    if (F.proactiveDeadline) payload.proactive_scope_deadline = F.proactiveDeadline.checked;
    if (F.proactiveQuiet) payload.proactive_quiet_enabled = F.proactiveQuiet.checked;
    if (F.quietStart) payload.proactive_quiet_start = F.quietStart.value;
    if (F.quietEnd) payload.proactive_quiet_end = F.quietEnd.value;
    if (F.voice) payload.voice_enabled = F.voice.checked;
    if (F.voiceOutput) payload.voice_output_enabled = F.voiceOutput.checked;
    if (F.wake) {
      payload.wake_enabled = F.wake.checked;
      payload.wake_threshold = Number(F.wakeThreshold.value);
    }
    if (F.screenMode) {
      payload.screen_mode = F.screenMode.value;
      payload.screen_background_consent = F.screenMode.value === 'background' && F.screenConsent.checked;
    }
    const res = await api.settings_save(payload);
    if (res.ok) { fillSettings(res.settings); msg.textContent = 'Saved.'; msg.className = 'hint'; UI.today.refresh(); }
    else { msg.textContent = UI.friendlyError(res.error); msg.className = 'hint error'; }

  // M6 slice 4: wake word session controls. The settings checkbox saves the
  // gate; Start/Pause/Resume/Stop drive the session itself and every action
  // reports the honest status back, including exactly which gate is
  // missing. Nothing here starts anything on its own: Start is the explicit
  // user action the engine requires.
  async function refreshWakeStatus() {
    const el = F.wakeStatus;
    if (!el) return;
    // The web/Android shell has no wake IPC: say so plainly instead of a
    // dead "unavailable", and hide the session buttons entirely.
    if (api.bridgeMode === 'web') {
      el.textContent = 'Wake listening runs in the CompanionDesk desktop app only; this web or Android build cannot host it.';
      for (const b of [F.wakeStart, F.wakePause, F.wakeResume, F.wakeStop]) if (b) b.hidden = true;
      if (F.wakeThreshold) F.wakeThreshold.disabled = true;
      return;
    }
    let res = null;
    try { res = await api.wake_status(); } catch { res = null; }
    if (!res || !res.ok) { el.textContent = 'Wake status unavailable.'; return; }
    const parts = [];
    parts.push(res.enabled ? 'Wake listening is enabled' : 'Wake listening is disabled');
    parts.push(res.phrase ? `phrase "${res.phrase}"` : 'no companion name is set');
    if (res.modelReady) parts.push('model ready');
    else parts.push(window.friendlyError(res.modelReason || 'wake_model_missing'));
    // The mic state is the part a listener must be able to see at a glance.
    if (res.running === 'listening') parts.push(res.micOpen ? 'LISTENING NOW, microphone open' : 'listening, microphone closed');
    else if (res.running === 'paused') parts.push('paused, microphone closed');
    else if (res.running && res.running !== 'off') parts.push(`currently ${res.running}`);
    el.textContent = parts.join('; ') + '.';
    if (F.wakeStart) F.wakeStart.disabled = !(res.enabled && res.modelReady && res.running === 'off');
    if (F.wakePause) F.wakePause.disabled = res.running !== 'listening';
    if (F.wakeResume) F.wakeResume.disabled = res.running !== 'paused';
    if (F.wakeStop) F.wakeStop.disabled = res.running === 'off';
  }
  const wakeActions = [
    ['wake-start', 'wake_start'], ['wake-pause', 'wake_pause'],
    ['wake-resume', 'wake_resume'], ['wake-stop', 'wake_stop'],
  ];
  for (const [id, channel] of wakeActions) {
    const btn = document.getElementById(id);
    if (!btn) continue;
    btn.addEventListener('click', async () => {
      let res = null;
      try { res = await api[channel](); } catch { res = null; }
      const el = F.wakeStatus;
      if (!res || !res.ok) {
        if (el) {
          const reason = res ? (res.reason || res.error) : 'unavailable';
          el.textContent = reason ? window.friendlyError(reason) : el.textContent;
        }
      }
      await refreshWakeStatus();
    });
  }
  if (F.wakeStatus) refreshWakeStatus();
  });

  // ---- provider status (read on demand; no polling, no cloud probing) ----
  const PS = {
    list: document.getElementById('provider-list'),
    refresh: document.getElementById('provider-refresh'),
    msg: document.getElementById('provider-msg'),
  };
  const CLOUD_LABELS = {
    off: 'Off (no key saved)',
    configured_disabled: 'Key saved, fallback disabled',
    enabled_no_key: 'Enabled in settings, but no key saved',
    armed: 'Armed: enabled with a key saved',
    no_secure_storage: 'Enabled, but no secure storage for the key',
  };
  function providerRow(label, value) {
    const li = document.createElement('li');
    li.textContent = `${label}: ${value}`;
    return li;
  }
  // Typed fault text (slice 6). The shared module provides the wording; a
  // missing module degrades to no suffix, never an error.
  function faultText(f) {
    const F = (typeof self !== 'undefined' && self.CompanionProviderFaults) || null;
    if (!F || !f) return '';
    return F.describeFault(f) || '';
  }
  function withFault(value, fault) {
    const t = faultText(fault);
    return t ? `${value} (${t})` : value;
  }
  async function fillProviderStatus() {
    if (!PS.list || !PS.refresh || !PS.msg) return;
    PS.refresh.disabled = true;
    PS.msg.textContent = 'Checking local providers...';
    PS.msg.className = 'hint';
    PS.list.textContent = '';
    let res = null;
    try { res = await api.provider_status(); } catch { res = null; }
    PS.refresh.disabled = false;
    if (!res || !res.ok) {
      PS.msg.textContent = 'Could not read the provider status. Try Refresh.';
      PS.msg.className = 'hint error';
      return;
    }
    PS.msg.textContent = '';
    PS.list.appendChild(providerRow('Local model server (Ollama)',
      withFault(res.ollama.reachable === true ? 'Reachable' : res.ollama.reachable === false ? 'Not running' : 'Unknown',
        res.ollama.reachable === false ? res.ollama.fault : null)));
    PS.list.appendChild(providerRow('Chat model',
      withFault(res.chat.installed === true ? `${res.chat.model} (installed)`
        : res.chat.installed === false ? `${res.chat.model} (missing)`
        : `${res.chat.model || 'default'} (unknown, server not reachable)`,
        res.chat.fault)));
    PS.list.appendChild(providerRow('Vision model',
      withFault(`${res.vision.model || 'default'} (${res.vision.capability === 'verified' ? 'vision verified'
        : res.vision.capability === 'unsuitable' ? 'not a vision model'
        : res.vision.capability === 'unreachable' ? 'unreachable' : 'capability unknown'})`,
        res.vision.capability === 'unknown' ? res.vision.fault : null)));
    PS.list.appendChild(providerRow('Cloud fallback (Gemini)', CLOUD_LABELS[res.cloud.state] || 'Unknown'));
    PS.list.appendChild(providerRow('Credential storage',
      res.credentialStorage.available === true ? 'OS-encrypted vault'
        : res.credentialStorage.available === false ? 'Unavailable on this platform' : 'Unknown'));
  }
  if (PS.refresh) PS.refresh.addEventListener('click', fillProviderStatus);

  // ---- optional cloud key (desktop: OS-encrypted; web: unsupported) --------------
  const CK = {
    input: document.getElementById('cloud-key'),
    save: document.getElementById('cloud-save'),
    test: document.getElementById('cloud-test'),
    remove: document.getElementById('cloud-remove'),
    msg: document.getElementById('cloud-status'),
  };
  function showCloud(text, bad) {
    if (!CK.msg) return;
    CK.msg.textContent = text;
    CK.msg.className = bad ? 'hint error' : 'hint';
  }
  async function fillCloud() {
    if (!CK.input) return;
    let res;
    try { res = await api.cloud_status(); } catch { res = { supported: false }; }
    if (!res.supported) {
      // No secure vault on this platform: the whole section stays out of the
      // way and nothing is stored.
      CK.input.closest('.field').hidden = true;
      return;
    }
    CK.input.closest('.field').hidden = false;
    CK.save.hidden = false;
    CK.test.hidden = false;
    CK.remove.hidden = false;
    if (!res.encryptionAvailable) {
      showCloud('This computer cannot encrypt the key (no OS credential vault), so nothing is saved and the cloud stays off.', true);
      CK.input.disabled = true;
      CK.save.disabled = true;
      return;
    }
    CK.input.disabled = false;
    CK.save.disabled = false;
    showCloud(res.configured ? 'A key is saved on this computer.' : 'No key saved. The cloud fallback stays off.');
  }
  if (CK.save) CK.save.addEventListener('click', async () => {
    const res = await api.cloud_setKey({ key: CK.input.value });
    CK.input.value = '';
    if (res.ok) { await fillCloud(); showCloud('Key saved and encrypted on this computer.'); }
    else showCloud(window.friendlyError(res.error), true);
  });
  if (CK.test) CK.test.addEventListener('click', async () => {
    showCloud('Checking with Google...');
    const res = await api.cloud_testKey(CK.input.value ? { key: CK.input.value } : {});
    if (res.ok) showCloud('The key works.');
    else showCloud(window.friendlyError(res.reason), true);
  });
  if (CK.remove) CK.remove.addEventListener('click', async () => {
    const res = await api.cloud_removeKey();
    await fillCloud();
    showCloud(res.ok ? 'Key removed. The cloud fallback is off.' : window.friendlyError(res.error), !res.ok);
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
    if (set.ok) { fillSettings(set.settings); fillModels(set.settings); fillHardware(); }
    fillProviderStatus();
    await fillCloud();
  }

  UI.about = { renderProposals, refreshProposals, refresh };
  UI.onShow('about', () => { refresh(); });
})();
