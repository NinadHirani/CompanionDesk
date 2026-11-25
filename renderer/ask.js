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
  let bootSwept = false;
  const renameBtn = document.getElementById('ask-rename');
  const deleteBtn = document.getElementById('ask-delete');
  const newChatBtn = document.getElementById('ask-newchat');
  const renameInput = document.getElementById('ask-rename-input');
  let currentId = null;
  // Unresolved cloud-consent prompts: each row's card and the ask's
  // own thread, so a switch that detaches a card can clean its thread
  // up. A list, not a single slot: a second ask can render a new
  // consent row while an earlier one is still unanswered, and the
  // earlier one must not lose its cleanup when the newer one lands.
  const pendingConsents = [];
  // The in-flight ask's id and thread, when one is running. Deleting the
  // thread that holds it must cancel the call first, or its only Cancel
  // button (inside the log the delete clears) vanishes and the model call
  // strands with the send button disabled forever.
  let activeAsk = null;
  const titles = new Map();

  // Chat order: messages append oldest-first so the thread reads like a
  // conversation, and the view scrolls to the newest one. The user's part
  // renders as their bubble; the companion answers underneath its name,
  // taken from the assistant_name setting (set by app.js applyIdentity).
  function companionName() {
    return String(document.body.dataset.companionName || '').trim() || 'CompanionDesk';
  }

  // Companion-first: the thinking hint shows how long the ask has been
  // running. One 1 s interval per pending hint; the tick updates only the
  // hint's own text node (the Cancel button beside it is untouched) and
  // clears itself the moment the hint leaves the page (answer, error,
  // cancel, or first streamed token), so no timer survives the turn.
  // A user-initiated cancel is not a failure: the abort surfaces as an
  // AbortError from the desktop bridge or a 'canceled' result from the
  // web bridge. The honest response is a neutral note, not an error card.
  function isAskCancel(failure) {
    if (!failure) return false;
    if (failure.name === 'AbortError' || failure.code === 'ABORT_ERR') return true;
    return /cancel|abort/i.test(String(failure.message || failure.error || failure));
  }

  function startThinkingClock(textNode) {
    const started = Date.now();
    const timer = setInterval(() => {
      if (!textNode.isConnected) { clearInterval(timer); return; }
      textNode.nodeValue = `${companionName()} is thinking (${Math.floor((Date.now() - started) / 1000)}s)`;
    }, 1000);
    return timer;
  }

  function addCard(text, cls) {
    const entry = el('section', null, 'card qa');
    if (cls === 'answer') entry.appendChild(el('p', companionName(), 'who'));
    entry.appendChild(el('p', text, cls));
    log.appendChild(entry);
    return entry;
  }

  function nearBottom() {
    return log.scrollHeight - log.scrollTop - log.clientHeight < 120;
  }

  function scrollToLatest(force) {
    // Growing answers (streaming tokens included) only follow the user when
    // they are already reading the latest message; scrolling up to read
    // history must not be yanked back down. Actions the user took
    // themselves (sending, opening a thread, accepting the cloud offer)
    // always snap to the newest message.
    if (!force && !nearBottom()) return;
    const last = log.lastElementChild;
    if (last) last.scrollIntoView({ block: 'nearest' });
  }

  // Companion-first: the picker shows how recently each thread was active,
  // so the reopened thread is recognizable at a glance. Times are the
  // device's own.
  function relativeStamp(iso) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '';
    const mins = Math.round((Date.now() - t) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days === 1) return 'yesterday';
    if (days < 7) return `${days}d ago`;
    return new Date(t).toLocaleDateString();
  }

  async function refreshList(keepId) {
    const res = await api.chat_list();
    if (!res.ok) return;
    const wanted = keepId !== undefined ? keepId : currentId;
    titles.clear();
    convSel.innerHTML = '<option value="">New chat</option>';
    for (const c of res.conversations) {
      const o = document.createElement('option');
      const title = c.title || `Chat ${c.id}`;
      const stamp = relativeStamp(c.updated_at);
      o.value = String(c.id);
      o.textContent = stamp ? `${title} (${stamp})` : title;
      // The plain title is what rename edits and the header shows; the
      // stamp is picker dressing only.
      titles.set(String(c.id), title);
      convSel.appendChild(o);
    }
    const keep = wanted && titles.has(String(wanted)) ? String(wanted) : '';
    convSel.value = keep;
    currentId = keep ? Number(keep) : null;
    updateSub(keep ? titles.get(String(keep)) : null);
    if (!keep) log.innerHTML = '';
  }

  // Companion-first: threads are only created by asks, and an ask saves its
  // exchange only on completion. An ask interrupted by a reload or a closed
  // window therefore leaves a zero-message thread behind, and the failure
  // paths' cleanup never runs after that. Sweep those once at boot, before
  // the picker first lists them, exactly like the failure cleanup does: a
  // real thread always has messages.
  async function sweepEmptyThreads() {
    const res = await api.chat_list();
    if (!res.ok) return;
    for (const c of res.conversations) {
      const msgs = await api.chat_messages({ id: c.id });
      if (msgs.ok && msgs.messages.length === 0) {
        await api.chat_delete({ id: c.id });
      }
    }
  }

  // Companion-first: a completed answer must never be reported as saved
  // when its thread vanished mid-flight. The ask result says so, and the
  // hint names what happened in place.
  // Companion-first: when the thread for a fresh ask cannot be created,
  // the ask still answers (single-shot fallback), but history has no home
  // for the exchange. Say so in place instead of reporting a normal
  // saved exchange.
  function appendCreateFailedHint(entry) {
    const why = 'Answered, but not saved: the conversation could not be created, so history does not keep it.';
    entry.appendChild(el('p', why, 'hint'));
    if (entry.isConnected) announce(why);
  }

  function appendSaveHint(entry, res) {
    if (!res || res.saved !== false) return;
    const why = res.save_error === 'not_found'
      ? 'Answered, but not saved: the conversation was deleted while the ask ran, so history does not keep it.'
      : 'Answered, but it could not be saved to history.';
    entry.appendChild(el('p', why, 'hint'));
    if (entry.isConnected) announce(why);
  }

  // Companion-first: the open thread's title is visible in the header.
  function updateSub(title) {
    const sub = document.getElementById('ask-sub');
    if (!sub) return;
    // The inline rename editor owns the header while it is open: a list
    // refresh finishing underneath it (an ask completing mid-rename) must
    // not re-show the stale title beside the editor. The editor's own
    // commit and cancel paths call updateSub again after hiding, so the
    // header never stays stale.
    if (renameInput && !renameInput.hidden) return;
    if (title) { sub.textContent = title; sub.hidden = false; }
    else { sub.textContent = ''; sub.hidden = true; }
  }

  // Screen-reader announcement for state changes a node insertion cannot
  // carry: a streamed answer mutates an existing element, and role="log"
  // (like every live region) announces insertions only, so the final
  // answer would stay silent on streaming transports. Cleared first so a
  // repeated identical message re-announces.
  function announce(text) {
    const live = document.getElementById('ask-live');
    if (!live) return;
    live.textContent = '';
    live.textContent = text;
  }

  async function loadSelected() {
    // A switch can outrun the load before it: a slow read must never
    // render a thread the user already left, into a newer selection's
    // log and header. The wanted id is captured up front and checked
    // again after every await.
    const wanted = convSel.value ? Number(convSel.value) : null;
    currentId = wanted;
    log.innerHTML = '';
    // Consent prompts left behind by a switch are dead: clearing the
    // log detaches their cards and they can no longer be answered. The
    // same checked rule as the failed ask applies: only a thread with
    // no messages is removed, and only the ask's own thread.
    for (const dead of [...pendingConsents]) {
      if (dead.entry.isConnected) continue;
      pendingConsents.splice(pendingConsents.indexOf(dead), 1);
      // An abandoned question was never saved: the consent prompt only
      // appears after the local ask failed, so nothing reached history.
      // Hand it back instead of dropping it, without overwriting a
      // question the user already retyped.
      if (dead.question && !input.value.trim()) input.value = dead.question;
      if (!dead.threadId) continue;
      const msgs = await api.chat_messages({ id: dead.threadId });
      if (msgs.ok && Array.isArray(msgs.messages) && msgs.messages.length === 0) {
        const del = await api.chat_delete({ id: dead.threadId });
        if (del.ok) await refreshList(currentId);
      }
    }
    if (!currentId) { updateSub(null); return; }
    const res = await api.chat_messages({ id: currentId });
    if (currentId !== wanted) return; // a newer switch owns the log now
    if (!res.ok) { currentId = null; convSel.value = ''; updateSub(null); return; }
    updateSub(titles.get(String(currentId)) || `Chat ${currentId}`);
    for (const m of res.messages) addCard(m.content, m.role === 'user' ? 'q' : 'answer');
    scrollToLatest(true);
  }

  async function submit() {
    // One ask at a time: the send button is the in-flight guard, and
    // the Enter key respects it too, so a second ask cannot start while
    // the first is still running (the button click cannot fire while
    // disabled, but Enter bypasses the button and goes straight here).
    if (btn.disabled) return;
    const question = input.value.trim();
    if (!question) { input.focus(); return; }
    btn.disabled = true;

    // A fresh ask opts into persistence: it starts its own thread before
    // the model call, so the question and the answer are saved together.
    // The overlay stays single-shot; only the ask view creates threads.
    let createdId = null;
    let createFailed = false;
    if (!currentId) {
      let made = null;
      try {
        made = await api.chat_new();
      } catch (err) {
        // A thrown bridge error falls back to the same path as a failed
        // reply: the ask still runs, just without a persisted thread.
        made = null;
      }
      if (made && made.ok && made.conversation && made.conversation.id) {
        createdId = made.conversation.id;
        currentId = createdId;
        await refreshList(currentId);
      } else {
        // The ask view is never single-shot by intent: reaching the model
        // with no thread here is a storage failure, not a deliberate
        // single-shot ask (that contract belongs to the overlay and is
        // tested at the bridge). The ask still answers, but the exchange
        // has no home, and the completed card must say so.
        createFailed = true;
      }
    }

    const entry = el('section', null, 'card qa');
    entry.appendChild(el('p', question, 'q'));
    const pending = el('p', null, 'hint');
    const pendingText = document.createTextNode(`${companionName()} is thinking`);
    pending.appendChild(pendingText);
    entry.appendChild(pending);
    log.appendChild(entry);
    scrollToLatest(true);
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
    startThinkingClock(pendingText);

    // Streaming: model tokens arrive on the push channel while the ask
    // runs; the answer from the ask's own result stays authoritative and
    // replaces the streamed text. Transports without push events simply
    // never fire this, and the whole answer renders as before.
    let answerEl = null;
    const stopTokens = (typeof api.on === 'function') ? api.on('ai:token', (t) => {
      if (!t || t.request_id !== requestId) return;
      // After the first token the stream lives in answerEl, not the
      // pending row: that row is removed on the very first token, so a
      // pending.isConnected guard here would drop every later piece and
      // freeze the stream at one token. The connected check follows
      // whichever element currently holds the stream, and a mid-ask
      // switch still silences a detached answer.
      const anchor = answerEl || pending;
      if (!anchor.isConnected) return;
      if (!answerEl) { pending.remove(); answerEl = el('p', '', 'answer'); entry.appendChild(answerEl); announce(companionName() + "'s answer is arriving"); }
      answerEl.textContent += String(t.piece || '');
      scrollToLatest();
    }) : null;

    // The ask keeps the thread it was asked in: if the user switches
    // conversations while the model is still thinking, completion must
    // persist to that thread and must not yank the picker or header back.
    const askThreadId = currentId;
    let res;
    activeAsk = { requestId, threadId: currentId };
    try {
      res = await api.ai_ask({ prompt: question, conversation_id: currentId, request_id: requestId });
    } catch (err) {
      // A bridge or transport crash must not strand the thread: the hint
      // and its clock leave, the question returns to the input for a
      // retry, and the send button unlocks again.
      if (stopTokens) stopTokens();
      pending.remove();
      const cancelled = isAskCancel(err);
      entry.appendChild(el('p', cancelled ? 'Ask cancelled.' : UI.friendlyError('ask_failed'), cancelled ? 'hint' : 'error'));
      if (!input.value.trim()) input.value = question;
      btn.disabled = false;
      // The same rule as the declined ask: a thread created for a crashed
      // ask stays empty (nothing was saved), so it goes away instead of
      // littering the list. Checked, not assumed: only a thread with no
      // messages is removed, and the error card stays on screen.
      if (createdId) {
        const emptyId = createdId;
        createdId = null;
        const msgs = await api.chat_messages({ id: emptyId });
        if (msgs.ok && Array.isArray(msgs.messages) && msgs.messages.length === 0) {
          const del = await api.chat_delete({ id: emptyId });
          if (del.ok) {
            // The picker must lose the deleted thread whether or not the
            // user is still on it: a mid-flight switch leaves currentId
            // elsewhere, and the list refresh keeps that selection.
            const wasCurrent = currentId === emptyId;
            if (wasCurrent) currentId = null;
            await refreshList(currentId);
            if (wasCurrent) log.appendChild(entry);
          }
        }
      }
      scrollToLatest(true);
      return;
    } finally { activeAsk = null; }
    if (stopTokens) stopTokens();
    pending.remove();
    if (res.ok) {
      if (!answerEl) { answerEl = el('p', res.answer, 'answer'); entry.appendChild(answerEl); }
      // A streamed answer landed by mutation, which no live region
      // announces: hand the authoritative text to the live region here.
      // A mid-ask switch leaves the entry detached, so nothing is
      // announced for a thread the user is no longer looking at.
      else { answerEl.textContent = res.answer; if (entry.isConnected) announce(res.answer); }
      appendSaveHint(entry, res);
      if (createFailed) appendCreateFailedHint(entry);
      scrollToLatest();
      // Re-select the ask's thread only when the user never left it: a
      // mid-ask switch to another conversation is a browsing choice, and
      // the completed ask must not yank the picker (or header) back.
      if (res.conversation_id && currentId === askThreadId) {
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
      // The prompt survives only while its card is on screen: switching
      // conversations detaches the row with no way back, so the ask's
      // own thread must not linger empty behind it.
      const consentItem = { entry, threadId: askThreadId || null, question };
      pendingConsents.push(consentItem);
      sendBtn.addEventListener('click', async () => {
        const ci = pendingConsents.indexOf(consentItem);
        if (ci >= 0) pendingConsents.splice(ci, 1);
        sendBtn.disabled = true;
        stayBtn.disabled = true;
        row.remove();
        // The consented cloud ask can fail like any ask: the thread it
        // was created for is still empty (nothing was saved), so the
        // same checked rule as the failed ask and the declined ask
        // applies: only a thread with no messages is removed, and only
        // the ask's own.
        const cleanupEmptyAsk = async () => {
          if (!createdId) return;
          const emptyId = createdId;
          createdId = null;
          const msgs = await api.chat_messages({ id: emptyId });
          if (msgs.ok && Array.isArray(msgs.messages) && msgs.messages.length === 0) {
            const del = await api.chat_delete({ id: emptyId });
            if (del.ok) {
              const wasCurrent = currentId === emptyId;
              if (wasCurrent) currentId = null;
              await refreshList(currentId);
              if (wasCurrent) { log.appendChild(entry); scrollToLatest(true); }
            }
          }
        };
        const waiting = el('p', null, 'hint');
        const waitingText = document.createTextNode(`${companionName()} is thinking`);
        waiting.appendChild(waitingText);
        entry.appendChild(waiting);
        const consentId = (typeof crypto !== 'undefined' && crypto.randomUUID)
          ? crypto.randomUUID()
          : `ask_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const cancel2 = el('button', 'Cancel', 'link');
        cancel2.type = 'button';
        cancel2.addEventListener('click', () => api.ai_cancel({ request_id: consentId }));
        waiting.appendChild(document.createTextNode(' '));
        waiting.appendChild(cancel2);
        startThinkingClock(waitingText);
        let res2 = null;
        activeAsk = { requestId: consentId, threadId: askThreadId };
        try {
          res2 = await api.ai_ask({ prompt: question, conversation_id: askThreadId, cloud_consent: true, request_id: consentId });
        } catch (err) {
          // Same rule on the consented cloud path: the waiting hint and
          // its clock leave, and the failure is reported in place.
          waiting.remove();
          const cancelled = isAskCancel(err);
          entry.appendChild(el('p', cancelled ? 'Ask cancelled.' : UI.friendlyError('ask_failed'), cancelled ? 'hint' : 'error'));
          // Every failure path hands the question back for a retry: the
          // consented ask's own outcomes are no exception.
          if (!input.value.trim()) input.value = question;
          scrollToLatest(true);
          await cleanupEmptyAsk();
          return;
        } finally { activeAsk = null; }
        waiting.remove();
        if (res2.ok) {
          entry.appendChild(el('p', res2.answer, 'answer'));
          appendSaveHint(entry, res2);
          if (createFailed) appendCreateFailedHint(entry);
          scrollToLatest(true);
          if (res2.conversation_id && currentId === askThreadId) {
            currentId = res2.conversation_id;
            await refreshList(currentId);
          }
        } else if (res2.needs_cloud_consent) {
          // Should not happen after consent; treat as the local failure it is.
          entry.appendChild(el('p', UI.friendlyError(res2.local_error || res2.error), 'error'));
          if (!input.value.trim()) input.value = question;
          await cleanupEmptyAsk();
        } else {
          const cancelled = isAskCancel(res2.error);
          entry.appendChild(el('p', cancelled ? 'Ask cancelled.' : UI.friendlyError(res2.error), cancelled ? 'hint' : 'error'));
          if (!input.value.trim()) input.value = question;
          await cleanupEmptyAsk();
        }
      });
      stayBtn.addEventListener('click', async () => {
        const ci = pendingConsents.indexOf(consentItem);
        if (ci >= 0) pendingConsents.splice(ci, 1);
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
        }
        // Every failure path hands the question back for a retry: a
        // declined ask must not eat the typed question, whether its
        // thread was newly created or one the user already had.
        if (!input.value.trim()) input.value = question;
      });
    } else {
      const cancelled = isAskCancel(res.error);
      entry.appendChild(el('p', cancelled ? 'Ask cancelled.' : UI.friendlyError(res.error), cancelled ? 'hint' : 'error'));
      // The same rule as the crashed and declined asks: a failed ask must
      // not eat the typed question, cancelled or not.
      if (!input.value.trim()) input.value = question;
      btn.disabled = false;
      // The same rule as the declined ask: a thread created for a failed
      // ask stays empty (nothing was saved), so it goes away instead of
      // littering the list. Checked, not assumed: only a thread with no
      // messages is removed, and the error card stays on screen.
      if (createdId) {
        const emptyId = createdId;
        createdId = null;
        const msgs = await api.chat_messages({ id: emptyId });
        if (msgs.ok && Array.isArray(msgs.messages) && msgs.messages.length === 0) {
          const del = await api.chat_delete({ id: emptyId });
          if (del.ok) {
            // The picker must lose the deleted thread whether or not the
            // user is still on it: a mid-flight switch leaves currentId
            // elsewhere, and the list refresh keeps that selection.
            const wasCurrent = currentId === emptyId;
            if (wasCurrent) currentId = null;
            await refreshList(currentId);
            if (wasCurrent) { log.appendChild(entry); scrollToLatest(true); }
          }
        }
      }
    }

    if (res.ok) {
      // Runs after the answer is on screen; a slow model never delays it.
      const s = await api.memory_suggest({ message: question });
      if (s.ok) UI.about.renderProposals(s.proposals);
    }
  }

  function restoreSubTitle() {
    updateSub(currentId ? titles.get(String(currentId)) || `Chat ${currentId}` : null);
  }

  renameBtn.addEventListener('click', () => {
    if (!currentId) { convSel.focus(); return; }
    // Inline rename: prompt() is unavailable inside Electron, so the title
    // field itself becomes the editor.
    const sub = document.getElementById('ask-sub');
    sub.hidden = true;
    renameInput.value = titles.get(String(currentId)) || '';
    renameInput.hidden = false;
    renameInput.focus();
    renameInput.select();
  });

  renameInput.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') {
      renameInput.hidden = true;
      restoreSubTitle();
      return;
    }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const name = renameInput.value.trim();
    const res = await api.chat_rename({ id: currentId, title: name });
    renameInput.hidden = true;
    if (!res.ok) { alert(res.error === 'invalid_title' ? 'A name needs at least one character.' : 'Rename failed.'); restoreSubTitle(); return; }
    titles.set(String(currentId), name);
    updateSub(name);
    await refreshList(currentId);
  });

  renameInput.addEventListener('blur', () => {
    if (!renameInput.hidden) { renameInput.hidden = true; restoreSubTitle(); }
  });

  deleteBtn.addEventListener('click', async () => {
    if (!currentId) { convSel.focus(); return; }
    const name = titles.get(String(currentId)) || 'this conversation';
    // Explicit confirmation: deleting removes the messages from this device
    // for good.
    if (!confirm(`Delete "${name}"? Its messages are removed from this computer and cannot be recovered.`)) return;
    if (activeAsk && activeAsk.threadId === currentId) {
      // This delete clears the log holding the in-flight ask's Cancel
      // button, so cancel the call here first, like that row's own
      // Cancel does. Otherwise it strands with no way to stop it.
      await api.ai_cancel({ request_id: activeAsk.requestId });
    }
    const res = await api.chat_delete({ id: currentId });
    if (!res.ok) { alert('Delete failed.'); return; }
    currentId = null;
    log.innerHTML = '';
    await refreshList(null);
  });

  convSel.addEventListener('change', loadSelected);
  // A visible fresh-start affordance: it walks the same path as picking
  // the New chat option in the picker, so both stay one behavior.
  newChatBtn.addEventListener('click', () => {
    convSel.value = '';
    convSel.dispatchEvent(new Event('change'));
    input.focus();
  });
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
    // Once at boot: an ask in flight on a later show also owns a
    // zero-message thread until it completes, and must never be swept.
    if (!bootSwept) { bootSwept = true; await sweepEmptyThreads(); }
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
