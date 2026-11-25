'use strict';

// Ask view: a question, a personal answer, and, afterwards, any "remember
// this?" suggestions for the student to accept or ignore. Conversations are
// local to this device: pick one from the list, start a new one, rename or
// delete it. Nothing here is uploaded anywhere.
(function () {
  const { api, el } = UI;
  const input = document.getElementById('ask-input');
  const btn = document.getElementById('ask-btn');
  const log = document.getElementById('ask-log');
  const convSel = document.getElementById('ask-conv');
  // Set once the first show of the view has finished, so the boot-time
  // reopen below runs exactly once.
  let restoredOnBoot = false;
  const renameBtn = document.getElementById('ask-rename');
  const deleteBtn = document.getElementById('ask-delete');
  let currentId = null;
  const titles = new Map();

  // Chat order: messages append oldest-first so the thread reads like a
  // conversation, and the view scrolls to the newest one. The user's part
  // renders as their bubble; the companion answers underneath its name,
  // taken from the assistant_name setting (set by app.js applyIdentity).
  function companionName() {
    return String(document.body.dataset.companionName || '').trim() || 'CompanionDesk';
  }

  function addCard(text, cls) {
    const entry = el('section', null, 'card qa');
    if (cls === 'answer') entry.appendChild(el('p', companionName(), 'who'));
    entry.appendChild(el('p', text, cls));
    log.appendChild(entry);
    return entry;
  }

  function scrollToLatest() {
    const last = log.lastElementChild;
    if (last) last.scrollIntoView({ block: 'nearest' });
  }

  async function refreshList(keepId) {
    const res = await api.chat_list();
    if (!res.ok) return;
    const wanted = keepId !== undefined ? keepId : currentId;
    titles.clear();
    convSel.innerHTML = '<option value="">New chat</option>';
    for (const c of res.conversations) {
      const o = document.createElement('option');
      o.value = String(c.id);
      o.textContent = c.title || `Chat ${c.id}`;
      titles.set(String(c.id), o.textContent);
      convSel.appendChild(o);
    }
    const keep = wanted && titles.has(String(wanted)) ? String(wanted) : '';
    convSel.value = keep;
    currentId = keep ? Number(keep) : null;
    updateSub(keep ? titles.get(String(keep)) : null);
    if (!keep) log.innerHTML = '';
  }

  // Companion-first: the open thread's title is visible in the header.
  function updateSub(title) {
    const sub = document.getElementById('ask-sub');
    if (!sub) return;
    if (title) { sub.textContent = title; sub.hidden = false; }
    else { sub.textContent = ''; sub.hidden = true; }
  }

  async function loadSelected() {
    currentId = convSel.value ? Number(convSel.value) : null;
    log.innerHTML = '';
    if (!currentId) return;
    const res = await api.chat_messages({ id: currentId });
    if (!res.ok) { currentId = null; convSel.value = ''; updateSub(null); return; }
    updateSub(titles.get(String(currentId)) || `Chat ${currentId}`);
    for (const m of res.messages) addCard(m.content, m.role === 'user' ? 'q' : 'answer');
    scrollToLatest();
  }

  async function submit() {
    const question = input.value.trim();
    if (!question) { input.focus(); return; }
    btn.disabled = true;

    // A fresh ask opts into persistence: it starts its own thread before
    // the model call, so the question and the answer are saved together.
    // The overlay stays single-shot; only the ask view creates threads.
    let createdId = null;
    if (!currentId) {
      const made = await api.chat_new();
      if (made && made.ok && made.conversation && made.conversation.id) {
        createdId = made.conversation.id;
        currentId = createdId;
        await refreshList(currentId);
      }
    }

    const entry = el('section', null, 'card qa');
    entry.appendChild(el('p', question, 'q'));
    const pending = el('p', `${companionName()} is thinking`, 'hint');
    entry.appendChild(pending);
    log.appendChild(entry);
    scrollToLatest();
    input.value = '';

    const requestId = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : `ask_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    // A cancel aborts the network call and the streaming reader; nothing
    // retries afterwards.
    const cancelBtn = el('button', 'Cancel', 'link');
    cancelBtn.type = 'button';
    cancelBtn.addEventListener('click', () => api.ai_cancel({ request_id: requestId }));
    pending.appendChild(document.createTextNode(' '));
    pending.appendChild(cancelBtn);

    const res = await api.ai_ask({ prompt: question, conversation_id: currentId, request_id: requestId });
    pending.remove();
    if (res.ok) {
      entry.appendChild(el('p', res.answer, 'answer'));
      scrollToLatest();
      if (res.conversation_id) {
        currentId = res.conversation_id;
        await refreshList(currentId);
      }
      btn.disabled = false;
    } else if (res.needs_cloud_consent) {
      // Per-request cloud gate: the LOCAL model could not answer, and the
      // router says the cloud may serve this one. Nothing has been sent
      // anywhere yet. The user decides, per ask; a decline means the
      // question is never sent, and nothing retries on its own.
      btn.disabled = false;
      entry.appendChild(el('p', `The local model could not answer this one (${res.local_error || 'local failure'}). Send it to Google ${res.cloud && res.cloud.provider === 'gemini' ? 'Gemini' : 'Gemini'}?`, 'hint'));
      // The disclosure must match the actual payload for THIS ask
      // (minimized vs full personal context, per the app's settings).
      const c = res.cloud || {};
      const receives = Array.isArray(c.receives) && c.receives.length
        ? c.receives
        : ['the current prompt and system context'];
      const never = Array.isArray(c.never_sent) && c.never_sent.length
        ? c.never_sent
        : ['conversation history', 'screenshots or images'];
      const note = c.note ? c.note.charAt(0).toUpperCase() + c.note.slice(1) + '.' : 'Rate limits and possible charges may apply.';
      entry.appendChild(el('p', `Google would receive (may include): ${receives.join('; ')}. Never sent: ${never.join(', ')}. ${note}`, 'hint'));
      const row = el('div', null, 'row');
      const sendBtn = el('button', 'Send to Google', 'primary');
      const stayBtn = el('button', 'No, stay local', '');
      sendBtn.type = 'button';
      stayBtn.type = 'button';
      row.appendChild(sendBtn);
      row.appendChild(stayBtn);
      entry.appendChild(row);
      sendBtn.addEventListener('click', async () => {
        sendBtn.disabled = true;
        stayBtn.disabled = true;
        row.remove();
        const waiting = el('p', `${companionName()} is thinking`, 'hint');
        entry.appendChild(waiting);
        const consentId = (typeof crypto !== 'undefined' && crypto.randomUUID)
          ? crypto.randomUUID()
          : `ask_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const cancel2 = el('button', 'Cancel', 'link');
        cancel2.type = 'button';
        cancel2.addEventListener('click', () => api.ai_cancel({ request_id: consentId }));
        waiting.appendChild(document.createTextNode(' '));
        waiting.appendChild(cancel2);
        const res2 = await api.ai_ask({ prompt: question, conversation_id: currentId, cloud_consent: true, request_id: consentId });
        waiting.remove();
        if (res2.ok) {
          entry.appendChild(el('p', res2.answer, 'answer'));
          scrollToLatest();
          if (res2.conversation_id) {
            currentId = res2.conversation_id;
            await refreshList(currentId);
          }
        } else if (res2.needs_cloud_consent) {
          // Should not happen after consent; treat as the local failure it is.
          entry.appendChild(el('p', UI.friendlyError(res2.local_error || res2.error), 'error'));
        } else {
          entry.appendChild(el('p', UI.friendlyError(res2.error), 'error'));
        }
      });
      stayBtn.addEventListener('click', async () => {
        // Decline: the question stays on this device and the local failure
        // is what gets reported. No cloud request is ever made for it.
        row.remove();
        entry.appendChild(el('p', UI.friendlyError(res.local_error || 'local_model_failed'), 'error'));
        // A thread created for this declined ask is still empty (nothing
        // was saved), so it goes away instead of littering the list.
        if (createdId) {
          const emptyId = createdId;
          createdId = null;
          const del = await api.chat_delete({ id: emptyId });
          if (del.ok && currentId === emptyId) { currentId = null; await refreshList(null); }
          input.value = question;
        }
      });
    } else {
      entry.appendChild(el('p', UI.friendlyError(res.error), 'error'));
      btn.disabled = false;
    }

    if (res.ok) {
      // Runs after the answer is on screen; a slow model never delays it.
      const s = await api.memory_suggest({ message: question });
      if (s.ok) UI.about.renderProposals(s.proposals);
    }
  }

  renameBtn.addEventListener('click', async () => {
    if (!currentId) { convSel.focus(); return; }
    const name = prompt('Rename this conversation', titles.get(String(currentId)) || '');
    if (name === null) return;
    const res = await api.chat_rename({ id: currentId, title: name });
    titles.set(String(currentId), name);
    updateSub(name);
    if (!res.ok) { alert(res.error === 'invalid_title' ? 'A name needs at least one character.' : 'Rename failed.'); return; }
    await refreshList(currentId);
  });

  deleteBtn.addEventListener('click', async () => {
    if (!currentId) { convSel.focus(); return; }
    const name = titles.get(String(currentId)) || 'this conversation';
    // Explicit confirmation: deleting removes the messages from this device
    // for good.
    if (!confirm(`Delete "${name}"? Its messages are removed from this computer and cannot be recovered.`)) return;
    const res = await api.chat_delete({ id: currentId });
    if (!res.ok) { alert('Delete failed.'); return; }
    currentId = null;
    log.innerHTML = '';
    await refreshList(null);
  });

  convSel.addEventListener('change', loadSelected);
  btn.addEventListener('click', submit);
  // Enter sends, like a chat; Shift+Enter makes a new line.
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    e.preventDefault();
    submit();
  });
  UI.onShow('ask', async () => {
    input.focus();
    UI.about.refreshProposals();
    await refreshList();
    // Companion-first: on the boot landing, reopen the most recent thread so
    // a returning user lands back inside their conversation. The list is
    // ordered most-recent first, and only this first show auto-selects:
    // afterwards the picker's explicit choice, New chat included, wins.
    const firstShow = !restoredOnBoot;
    restoredOnBoot = true;
    if (firstShow && !currentId && convSel.options.length > 1) {
      convSel.value = convSel.options[1].value;
      await loadSelected();
    }
  });
})();
