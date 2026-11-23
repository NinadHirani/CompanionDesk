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
  const renameBtn = document.getElementById('ask-rename');
  const deleteBtn = document.getElementById('ask-delete');
  let currentId = null;
  const titles = new Map();

  // Newest at the top, matching the log's existing prepend order.
  function addCard(text, cls) {
    const entry = el('section', null, 'card qa');
    entry.appendChild(el('p', text, cls));
    log.prepend(entry);
    return entry;
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
    if (!keep) log.innerHTML = '';
  }

  async function loadSelected() {
    currentId = convSel.value ? Number(convSel.value) : null;
    log.innerHTML = '';
    if (!currentId) return;
    const res = await api.chat_messages({ id: currentId });
    if (!res.ok) { currentId = null; convSel.value = ''; return; }
    for (const m of [...res.messages].reverse()) addCard(m.content, m.role === 'user' ? 'q' : 'answer');
  }

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
      entry.appendChild(el('p', 'Google receives the question and the assistant instructions only. Your conversation history and any screenshots are never sent. Rate limits and possible charges may apply.', 'hint'));
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
        const waiting = el('p', 'Thinking', 'hint');
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
      stayBtn.addEventListener('click', () => {
        // Decline: the question stays on this device and the local failure
        // is what gets reported. No cloud request is ever made for it.
        row.remove();
        entry.appendChild(el('p', UI.friendlyError(res.local_error || 'local_model_failed'), 'error'));
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
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
  });
  UI.onShow('ask', async () => {
    input.focus();
    UI.about.refreshProposals();
    await refreshList();
  });
})();
