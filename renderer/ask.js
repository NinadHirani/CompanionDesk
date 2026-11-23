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

    const res = await api.ai_ask({ prompt: question, conversation_id: currentId });
    pending.remove();
    if (res.ok) {
      entry.appendChild(el('p', res.answer, 'answer'));
      if (res.conversation_id) {
        currentId = res.conversation_id;
        await refreshList(currentId);
      }
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
