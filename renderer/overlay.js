'use strict';

// The overlay: one question (typed or spoken), one streaming answer. Escape
// closes it. Voice is recorded here, transcribed locally by the main process.
(function () {
  const api = window.companiondesk;
  const input = document.getElementById('ov-input');
  const answer = document.getElementById('ov-answer');
  const hint = document.getElementById('ov-hint');
  const micBtn = document.getElementById('ov-mic');
  // M6 slice 3: OS-native speech output. The engine is this machine's own
  // voice stack through the standard speechSynthesis interface; nothing is
  // downloaded, nothing leaves the computer, and the setting
  // voice_output_enabled (default off) plus an explicit button press are
  // both required before anything is ever spoken.
  const readBtn = document.getElementById('ov-readout');
  const speechApi = window.CompanionSpeechOutput;
  const speechCap = speechApi.detectSpeech(window);
  let outputEnabled = false;
  const READING_HINT = 'Reading aloud. Press Read aloud or Esc to stop.';
  const speech = speechApi.createSpeechOutput({
    engine: speechCap.available ? speechApi.webSpeechEngine(window) : null,
    enabled: () => outputEnabled,
    onSettled: (st) => {
      readBtn.textContent = 'Read aloud';
      if (st.phase === 'failed') hint.textContent = window.friendlyError(st.failure);
    },
  });
  let busy = false;
  let recording = null; // the active recorder, if any
  let processing = false; // a transcription is in flight in the main process

  const IDLE_HINT = 'Enter to ask. Esc to close.';

  function cancelRecording() {
    if (recording) { recording.cancel(); recording = null; }
    if (processing) { api.voice_cancel(); processing = false; }
    if (speech.isSpeaking()) speech.stop();
    micBtn.textContent = 'Speak';
  }

  function reset() {
    cancelRecording();
    hidePicker();
    hidePreview();
    busy = false;
    input.disabled = false;
    input.value = '';
    if (speech.isSpeaking()) speech.stop();
    readBtn.hidden = true;
    readBtn.textContent = 'Read aloud';
    answer.textContent = '';
    answer.classList.remove('error');
    hint.textContent = IDLE_HINT;
    input.focus();
  }

  function showError(code, detail) {
    answer.textContent = window.friendlyError(code, detail);
    answer.classList.add('error');
    hint.textContent = 'Esc to close.';
  }

  // Run one question through `call` (typed, or with the screen) and show the result.
  async function runAsk(call, thinking) {
    const prompt = input.value.trim();
    if (!prompt || busy) return;
    busy = true;
    input.disabled = true;
    stopSpeaking();
    readBtn.hidden = true;
    answer.textContent = '';
    answer.classList.remove('error');
    hint.textContent = thinking;
    const res = await call(prompt);
    busy = false;
    input.disabled = false;
    // The final text replaces whatever streamed, in case a fallback answered.
    if (res.ok) {
      answer.textContent = res.answer;
      hint.textContent = 'Enter to ask again. Esc to close.';
      // The Read aloud control appears only after the setting and this
      // machine's speech capability have both said yes, this turn.
      try {
        const vs = await api.voice_status();
        outputEnabled = !!(vs && vs.outputEnabled === true);
      } catch (e) { outputEnabled = false; }
      readBtn.hidden = !(outputEnabled && speechCap.available);
      readBtn.textContent = 'Read aloud';
    }
    else showError(res.error, res.detail);
    input.select();
    input.focus();
  }

  const submit = () => runAsk((prompt) => api.overlay_ask({ prompt }), 'Thinking');

  // ---- screen: the user picks ONE window; the overlay shows what is sent -----------
  const picker = document.getElementById('ov-picker');
  const preview = document.getElementById('ov-preview');

  function hidePicker() { picker.hidden = true; picker.replaceChildren(); }
  function hidePreview() { preview.hidden = true; preview.querySelector('img').removeAttribute('src'); }

  function showPreview(win, text) {
    const img = preview.querySelector('img');
    if (win.thumbnail) img.src = win.thumbnail; else img.removeAttribute('src');
    preview.querySelector('span').textContent = text;
    preview.hidden = false;
  }

  function choose(win) {
    hidePicker();
    showPreview(win, `Sending only this window to the local model: ${win.name}. Nothing is saved.`);
    runAsk((prompt) => api.screen_ask({ prompt, windowId: win.id }), 'Looking at that window').then(() => {
      preview.querySelector('span').textContent = `Sent to the local model: ${win.name}. Not saved.`;
    });
  }

  document.getElementById('ov-screen').addEventListener('click', async () => {
    if (!input.value.trim()) { hint.textContent = 'Type your question first, then click Screen.'; input.focus(); return; }
    hidePreview();
    const res = await api.screen_windows();
    if (!res.ok) { showError(res.error); return; }
    picker.replaceChildren();
    const title = document.createElement('p');
    title.className = 'hint';
    title.textContent = res.windows.length ? 'Pick one window. Only that window is captured.' : 'No other windows are open to look at.';
    picker.appendChild(title);
    for (const w of res.windows) {
      const b = document.createElement('button');
      b.className = 'ov-win';
      b.disabled = w.blocked;
      if (w.thumbnail) { const im = document.createElement('img'); im.alt = ''; im.src = w.thumbnail; b.appendChild(im); }
      const label = document.createElement('span');
      label.textContent = w.blocked ? `${w.name} (looks private, not available)` : w.name;
      b.appendChild(label);
      b.addEventListener('click', () => choose(w));
      picker.appendChild(b);
    }
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', hidePicker);
    picker.appendChild(cancel);
    picker.hidden = false;
  });

  // ---- voice -----------------------------------------------------------------------
  async function stopAndTranscribe() {
    const rec = recording;
    recording = null;
    micBtn.textContent = 'Speak';
    micBtn.disabled = true;
    hint.textContent = 'Transcribing';
    const pcm = await rec.stop();
    processing = true;
    const res = await api.voice_transcribe({ pcm });
    processing = false;
    micBtn.disabled = false;
    if (!res.ok) { showError(res.error); return; }
    input.value = res.text;
    submit();
  }

  micBtn.addEventListener('click', async () => {
    if (busy) return;
    if (recording) { await stopAndTranscribe(); return; }
    const status = await api.voice_status();
    if (status.enabled === false) { showError('voice_disabled'); return; }
    if (!status.available) {
      answer.textContent = status.reason === 'no_model'
        ? 'Voice needs a whisper model file. See the README for where to put it.'
        : 'Voice needs whisper.cpp installed. See the README.';
      answer.classList.add('error');
      return;
    }
    try {
      recording = await window.CompanionRecorder.startRecording({ onAutoStop: () => { if (recording) stopAndTranscribe(); } });
    } catch (err) {
      showError(err && err.name === 'NotFoundError' ? 'mic_missing' : 'mic_blocked');
      return;
    }
    answer.textContent = '';
    answer.classList.remove('error');
    micBtn.textContent = 'Stop';
    hint.textContent = 'Listening. Click Stop when you are done.';
  });

  readBtn.addEventListener('click', () => {
    if (speech.isSpeaking()) {
      speech.stop();
      readBtn.textContent = 'Read aloud';
      hint.textContent = 'Enter to ask again. Esc to close.';
      return;
    }
    const r = speech.start(answer.textContent, { userInitiated: true });
    if (r.ok) { readBtn.textContent = 'Stop'; hint.textContent = READING_HINT; }
    else hint.textContent = window.friendlyError(r.reason);
  });

  api.on('overlay:reset', reset);
  api.on('overlay:token', (piece) => { if (busy) answer.textContent += piece; });

  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { cancelRecording(); api.overlay_hide(); } });
  document.getElementById('ov-close').addEventListener('click', () => { cancelRecording(); api.overlay_hide(); });
  reset();
})();
