'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const read = (f) => fs.readFileSync(f, 'utf8');

test('the ask log renders in chat order, newest last, and scrolls to it', () => {
  const s = read('renderer/ask.js');
  assert.ok(!s.includes('log.prepend'), 'no prepending: the thread must stay in chat order');
  assert.ok(s.includes('log.appendChild(entry)'), 'messages append');
  assert.ok(!s.includes('.reverse()'), 'history is rendered oldest-first, no reversal');
  assert.ok(s.includes('scrollToLatest()'), 'the view scrolls to the newest message');
  assert.ok(s.includes("m.role === 'user' ? 'q' : 'answer'"), 'roles map to bubbles');
});

test('answers carry the companion name label from the assistant_name setting', () => {
  const s = read('renderer/ask.js');
  assert.ok(s.includes("document.body.dataset.companionName"), 'label reads the live companion name');
  assert.ok(s.includes("cls === 'answer'"), 'only answers get the label, questions do not');
});

test('Enter sends and Shift+Enter makes a new line', () => {
  const s = read('renderer/ask.js');
  const i = s.indexOf("input.addEventListener('keydown'");
  assert.ok(i > 0);
  const chunk = s.slice(i, i + 300);
  assert.ok(chunk.includes("e.key !== 'Enter' || e.shiftKey"), 'plain Enter sends, Shift+Enter newlines');
});

test('app.js applyIdentity feeds the companion name to the thread and the tab', () => {
  const s = read('renderer/app.js');
  assert.ok(s.includes('document.body.dataset.companionName = name'), 'dataset set for ask.js');
  assert.ok(s.includes("button[data-view=\"ask\"]"), 'the Ask tab is updated');
  assert.ok(s.includes("? 'Ask' : name"), 'the tab falls back to Ask for the default name');
});

test('styles ship the chat bubbles and the small-screen layout', () => {
  const css = read('renderer/styles.css');
  assert.ok(css.includes('.qa .q') && css.includes('align-self: flex-end'), 'question bubble on the right');
  assert.ok(css.includes('.qa .who'), 'companion name label style');
  assert.ok(css.includes('@media (max-width: 640px)'), 'responsive block exists');
  const media = css.slice(css.indexOf('@media (max-width: 640px)'));
  assert.ok(media.includes('.tabs') && media.includes('overflow-x: auto'), 'tabs scroll on phones');
  assert.ok(media.includes('#ask-conv-bar'), 'conversation bar wraps on phones');
});

test('the thinking indicator and the Ask heading carry the companion name', () => {
  const ask = read('renderer/ask.js');
  assert.ok(ask.includes('is thinking`'), 'the pending hint names the companion');
  assert.ok(!ask.includes("'Thinking'"), 'no bare Thinking label left');
  const html = read('renderer/index.html');
  assert.ok(html.includes('id="ask-heading"'), 'the Ask heading is addressable');
  const app = read('renderer/app.js');
  assert.ok(app.includes("getElementById('ask-heading')"), 'the heading follows the name');
  const ov = read('renderer/overlay.js');
  assert.ok(ov.includes('state_get()'), 'the overlay reads the companion name from state');
  assert.ok(ov.includes("typeof thinking === 'function' ? thinking() : thinking"), 'thinking hints can be computed');
  assert.ok(ov.includes('is thinking`'), 'the overlay thinking hint names the companion');
});

test('the app opens on the companion chat once setup is done', () => {
  const boot = read('renderer/boot.js');
  assert.ok(boot.includes("needsSetup ? 'onboarding' : 'ask'"), 'ready state lands on the chat');
  const ob = read('renderer/onboarding.js');
  assert.ok(ob.includes("UI.show('ask')"), 'finishing setup ends in the chat');
});

test("the Today brief opens in the companion's voice", () => {
  const app = read('renderer/app.js');
  assert.ok(app.includes("'companion-lead'"), 'brief renders a companion lead line');
  assert.ok(app.includes("dataset.companionName"), 'the lead uses the companion name');
  assert.ok(app.includes("${cname} here."), 'the lead names the companion');
  const css = read('renderer/styles.css');
  assert.ok(css.includes('.companion-lead'), 'the lead line has a style');
});

test('the open conversation title is visible in the chat header', () => {
  const ask = read('renderer/ask.js');
  assert.ok(ask.includes('function updateSub'), 'ask.js keeps the title line in step');
  assert.ok(ask.includes("getElementById('ask-sub')"), 'the title targets ask-sub');
  for (const p of ['renderer/index.html', 'web/index.html']) {
    assert.ok(read(p).includes('id="ask-sub"'), p + ' carries the ask-sub element');
  }
  const css = read('renderer/styles.css');
  assert.ok(css.includes('.ask-sub'), 'the title line has a style');
});

test('a fresh ask opts into persistence, and a declined consent cleans up', () => {
  const ask = read('renderer/ask.js');
  assert.ok(ask.includes('api.chat_new()'), 'a fresh ask creates its thread first');
  assert.ok(ask.includes('conversation_id: currentId'), 'the ask runs inside that thread');
  assert.ok(ask.includes('api.chat_delete({ id: emptyId })'), 'a declined cloud consent removes the empty thread');
  assert.ok(ask.includes('input.value = question'), 'the declined question returns to the input');
});

test('the ask streams model tokens and keeps the final answer authoritative', () => {
  const s = read('renderer/ask.js');
  assert.ok(s.includes("typeof api.on === 'function'"), 'streaming subscribes only where a push channel exists');
  assert.ok(s.includes("api.on('ai:token'"), 'tokens arrive on the ai:token push channel');
  assert.ok(s.includes('t.request_id !== requestId'), 'a window only renders its own ask tokens');
  assert.ok(s.includes('!pending.isConnected'), 'tokens stop rendering once the ask row is gone');
  assert.ok(s.includes('answerEl.textContent = res.answer'), 'the final result replaces the streamed text');
  assert.ok(s.includes('if (stopTokens) stopTokens()'), 'the subscription is released when the ask ends');
});

test('ai:token is allowlisted on both sides of the IPC boundary and tagged per request', () => {
  const ch = read('src/ipc-channels.js');
  const pre = read('src/preload.js');
  for (const s of [ch, pre]) {
    assert.ok(s.includes("'ai:token'"), 'ai:token is in the push-event allowlist');
  }
  const main = read('src/main.js');
  assert.ok(main.includes("sender.send('ai:token', { request_id: requestId, piece: String(piece) })"), 'tokens are tagged with the request id');
  assert.ok(main.includes('onToken: (piece)'), 'the ask pipeline forwards model tokens');
});

test('auto-scroll follows streaming only near the bottom; user actions snap to the newest message', () => {
  const s = read('renderer/ask.js');
  assert.ok(s.includes('function nearBottom()'), 'the near-bottom check exists');
  assert.ok(s.includes('if (!force && !nearBottom()) return;'), 'streaming growth does not yank a reader back down');
  assert.ok(s.includes('scrollToLatest(true);'), 'user actions force the snap to the newest message');
  const token = s.slice(s.indexOf("api.on('ai:token'"));
  assert.ok(token.includes('scrollToLatest()'), 'token growth scrolls only when guarded');
});

test('the conversation picker carries relative activity stamps', () => {
  const s = read('renderer/ask.js');
  assert.ok(s.includes('function relativeStamp(iso)'), 'a relative-time helper exists');
  assert.ok(s.includes("if (mins < 1) return 'just now'"), 'minutes bucket');
  assert.ok(s.includes('return `${mins}m ago`'), 'minutes label');
  assert.ok(s.includes('return `${hours}h ago`'), 'hours label');
  assert.ok(s.includes("if (days === 1) return 'yesterday'"), 'yesterday label');
  assert.ok(s.includes('o.textContent = stamp ? `${title} (${stamp})` : title;'), 'picker options show title with stamp');
  assert.ok(s.includes('titles.set(String(c.id), title);'), 'the plain title, not the stamped text, feeds rename and the header');
});

test('the thinking hint counts elapsed seconds and leaves no timer behind', () => {
  const s = read('renderer/ask.js');
  assert.ok(s.includes('function startThinkingClock(textNode)'), 'a shared elapsed-seconds clock exists');
  assert.ok(s.includes("if (!textNode.isConnected) { clearInterval(timer); return; }"), 'the clock clears itself once the hint leaves the page');
  assert.ok(s.includes('textNode.nodeValue = `${companionName()} is thinking (${Math.floor((Date.now() - started) / 1000)}s)`;'), 'only the hint text updates, the Cancel button stays');
  assert.match(s, /pendingText\);\n {4}startThinkingClock|startThinkingClock\(pendingText\)/, 'the main ask path starts the clock');
  assert.ok(s.includes('startThinkingClock(waitingText);'), 'the cloud-consent waiting path starts the clock too');
});

test('a failed or crashed ask leaves no stuck thinking state', () => {
  const s = read('renderer/ask.js');
  assert.ok(s.includes('try {\n      res = await api.ai_ask('), 'the main ask call is guarded');
  assert.ok(s.includes("UI.friendlyError('ask_failed')"), 'a friendly error is shown on a crash');
  const mainCatch = s.slice(s.indexOf('res = await api.ai_ask('), s.indexOf('needs_cloud_consent'));
  assert.ok(mainCatch.includes('btn.disabled = false;'), 'the send button unlocks after a crash');
  assert.ok(mainCatch.includes('input.value = question;'), 'the question returns to the input for a retry');
  assert.ok(mainCatch.includes('pending.remove();'), 'the thinking hint leaves the page');
  const consentCall = s.indexOf('res2 = await api.ai_ask(');
  assert.ok(consentCall > 0, 'the consented cloud call is guarded too');
  const consentCatch = s.slice(consentCall, consentCall + 900);
  assert.ok(consentCatch.includes('waiting.remove()'), 'the waiting hint leaves on a crash there too');
  assert.ok(s.includes('try {\n        made = await api.chat_new();'), 'a thrown thread-creation error cannot strand the button');
});

test('ask_failed maps to a plain retry message', () => {
  const s = read('renderer/errors.js');
  assert.ok(s.includes('ask_failed:'), 'the code is mapped in errors.js');
  assert.ok(s.includes('try again.'), 'the message invites a retry');
});

test('the chat log is a live region: new messages are announced', () => {
  const html = read('renderer/index.html');
  assert.ok(html.includes('<div id="ask-log" role="log">'), 'role=log gives the chat log polite live-region semantics');
  const ov = read('renderer/overlay.html');
  assert.ok(ov.includes('<div id="ov-answer" class="ov-answer" aria-live="polite">'), 'the overlay answer already announces');
  const web = read('web/index.html');
  assert.ok(web.includes('<div id="ask-log" role="log">'), 'the web bundle keeps the same live-region semantics');
  assert.ok(web.includes('<p class="hint" id="ob-progress" role="status" aria-live="polite">'), 'the web onboarding progress announces');
  assert.ok(web.includes('<h2 id="ob-prompt" aria-live="polite">'), 'the web onboarding question announces');
});

test('row editors return focus to the row after the list re-renders', () => {
  const src = read('renderer/app.js');
  assert.ok(src.includes('function refocusRow('), 'a refocusRow helper exists');
  assert.ok(src.includes('li.dataset.id = item.id;'), 'due rows carry their item id');
  assert.ok(src.includes('li.dataset.id = c.id;'), 'course rows carry their course id');
  // deadline editor: save and cancel both land back on the row
  assert.ok(src.includes("await refresh();\n      refocusRow(item.id, 'due-list');"), 'deadline save refocuses');
  assert.ok(src.includes("cancel.addEventListener('click', async () => { await refresh(); refocusRow(item.id, 'due-list'); });"), 'deadline cancel refocuses');
  // course editor and its remove confirm
  assert.ok(src.includes("await refresh();\n      refocusRow(c.id, 'course-list');"), 'course save refocuses');
  assert.ok(src.includes("cancel.addEventListener('click', async () => { await refresh(); refocusRow(c.id, 'course-list'); });"), 'course cancel refocuses');
  assert.ok(src.includes("no.addEventListener('click', async () => { await refresh(); refocusRow(c.id, 'course-list'); });"), 'remove-cancel refocuses');
  const used = src.split('refocusRow(').length - 1;
  assert.ok(used >= 6, 'refocusRow is wired after every editor close, got ' + used);
});

test('row editors take Enter to save and Escape to cancel', () => {
  const src = read('renderer/app.js');
  assert.ok(src.includes("form.addEventListener('keydown', (e) => {"), 'the editor forms listen for keys');
  assert.ok(src.includes("(e.target === title || e.target === date)"), 'the deadline editor fires save on Enter from its text and date fields');
  assert.ok(src.includes("(e.target === name || e.target === code || e.target === term)"), 'the course editor fires save on Enter from its text fields');
  const escapes = src.split("if (e.key === 'Escape') { e.preventDefault(); cancel.click(); }").length - 1;
  assert.ok(escapes >= 2, 'both editors dismiss on Escape, got ' + escapes);
});

test('the add forms take Enter in a text field', () => {
  const src = read('renderer/app.js');
  assert.ok(src.includes('async function addCourse()'), 'the course add path is a function the button and Enter share');
  assert.ok(src.includes('async function addDeadline()'), 'the deadline add path is a function the button and Enter share');
  assert.ok(src.includes("document.getElementById('course-add-btn').addEventListener('click', addCourse)"), 'the course button uses the shared path');
  assert.ok(src.includes("document.getElementById('dl-add').addEventListener('click', addDeadline)"), 'the deadline button uses the shared path');
  const enters = src.split("e.key === 'Enter'").length - 1;
  assert.ok(enters >= 4, 'Enter is wired on both add forms and both row editors, got ' + enters);
});

test('the AI status chip is a real button, keyboard-reachable', () => {
  for (const copy of ['renderer/index.html', 'web/index.html']) {
    const html = read(copy);
    assert.ok(html.includes('<button id="ai-status" class="status" type="button" aria-live="polite">'), copy + ' makes the status chip a real button whose status changes announce');
    assert.ok(!html.includes('<span id="ai-status"'), copy + ' no longer ships the click-only span');
  }
  // styles.css is a build output in web/ (regenerated before CI's smoke step), so only the renderer copy is asserted here
  assert.ok(read('renderer/styles.css').includes('button.status { border: 0; }'), 'renderer/styles.css keeps the chip look borderless');
});

test('the section tabs announce the open section with aria-current', () => {
  const src = read('renderer/dom.js');
  assert.ok(src.includes("b.dataset.view === name) b.setAttribute('aria-current', 'true')"), 'dom.js sets aria-current on the open tab');
  assert.ok(src.includes("else b.removeAttribute('aria-current')"), 'dom.js clears aria-current on the rest');
});

test('the overlay submit path has no dangling calls: speech stops inline', () => {
  const ov = read('renderer/overlay.js');
  assert.ok(!ov.includes('stopSpeaking('), 'no dangling stopSpeaking call: it was defined nowhere and crashed every typed overlay ask');
  const stops = ov.split('if (speech.isSpeaking()) speech.stop();').length - 1;
  assert.ok(stops >= 3, 'every ask entry point stops a running read-aloud inline before asking');
});

test('chat bubbles wrap long unbroken tokens at every viewport width', () => {
  const css = read('renderer/styles.css');
  const q = css.slice(css.indexOf('.qa .q {'), css.indexOf('.qa .answer'));
  const a = css.slice(css.indexOf('.qa .answer {'), css.indexOf('.qa .who'));
  assert.ok(q.includes('overflow-wrap: anywhere'), 'the question bubble breaks long tokens');
  assert.ok(a.includes('overflow-wrap: anywhere'), 'the answer bubble breaks long tokens');
  assert.ok(css.slice(css.indexOf('.ov-answer {')).includes('overflow-wrap: anywhere'), 'the overlay answer breaks long tokens too');
});

test('the overlay open button reports a refused overlay instead of doing nothing', () => {
  const s = read('renderer/about.js');
  assert.ok(!s.includes('() => api.overlay_show());'), 'the result of overlay_show is not dropped');
  assert.ok(s.includes('ovMsg.textContent = UI.friendlyError(res.error)'), 'a refused overlay shows the shared friendly wording');
});

test('the ask Enter path respects the in-flight guard, one ask at a time', () => {
  const s = read('renderer/ask.js');
  const i = s.indexOf('async function submit()');
  const head = s.slice(i, i + 400);
  assert.ok(head.includes('if (btn.disabled) return;'), 'submit refuses a second ask while one is pending');
});

test('a failed fresh ask cleans up its empty thread instead of littering the list', () => {
  const s = read('renderer/ask.js');
  const plain = s.slice(s.indexOf("const cancelled = isAskCancel(res.error);"));
  assert.ok(plain.includes('msgs.messages.length === 0'), 'the plain failure path removes only a thread with no messages');
  assert.ok(plain.includes('log.appendChild(entry)'), 'the error card stays on screen after the cleanup');
  const caught = s.slice(s.indexOf("cancelled ? 'Ask cancelled.' : UI.friendlyError('ask_failed')"));
  assert.ok(caught.includes('msgs.messages.length === 0'), 'the transport-crash path follows the same rule');
});

test('a pending ask keeps its own thread; completion never yanks the picker back', () => {
  const s = read('renderer/ask.js');
  assert.ok(s.includes('const askThreadId = currentId;'), 'the ask captures its thread at submit time');
  assert.ok(s.includes('if (res.conversation_id && currentId === askThreadId)'), 'local completion re-selects the ask thread only when the user stayed on it');
  assert.ok(s.includes('if (res2.conversation_id && currentId === askThreadId)'), 'cloud completion follows the same rule');
  assert.ok(s.includes('conversation_id: askThreadId, cloud_consent: true'), 'the consented ask saves to the thread it was asked in, not the open one');
});

test('streamed answers are announced to screen readers via a live region', () => {
  for (const f of ['renderer/index.html', 'web/index.html']) {
    const html = read(f);
    const i = html.indexOf('id="ask-live"');
    assert.ok(i > 0, `${f}: the ask live region exists`);
    const tag = html.slice(Math.max(0, i - 120), i + 80);
    assert.ok(tag.includes('role="status"') && tag.includes('aria-live="polite"'), `${f}: the live region is a polite status`);
    assert.ok(tag.includes('class="sr-only"'), `${f}: the live region is visually hidden`);
  }
  const css = read('renderer/styles.css');
  assert.ok(css.includes('.sr-only'), 'the sr-only hiding class ships');
  assert.ok(css.includes('clip: rect(0 0 0 0)'), 'sr-only hides visually without display:none');
  const s = read('renderer/ask.js');
  assert.ok(s.includes('function announce('), 'the announce helper exists');
  assert.ok(s.includes("announce(companionName() + \"'s answer is arriving\")"), 'the first streamed token is announced');
  const ok = s.indexOf('if (res.ok) {');
  const chunk = s.slice(ok, ok + 500);
  assert.ok(chunk.includes('announce(res.answer)'), 'the streamed final answer is announced');
  assert.ok(chunk.includes('entry.isConnected'), 'a mid-ask switch announces nothing for the abandoned view');
  assert.ok(!s.includes('announce(res2.answer)'), 'the consented cloud answer inserts as a node; no double announcement');
});

test('an abandoned cloud-consent prompt cleans up its empty thread on switch', () => {
  const s = read('renderer/ask.js');
  assert.ok(s.includes('const pendingConsents = [];'), 'unresolved consents are tracked');
  assert.ok(s.includes('const consentItem = { entry, threadId: askThreadId || null };'), 'the consent row registers its card and the ask thread');
  assert.ok(s.includes('pendingConsents.push(consentItem);'), 'the registration lands in the tracked list');
  const ls = s.indexOf('async function loadSelected()');
  const chunk = s.slice(ls, ls + 1000);
  assert.ok(s.includes('if (dead.entry.isConnected) continue;'), 'the switch is detected by the card leaving the page');
  assert.ok(chunk.includes('msgs.messages.length === 0'), 'the thread is checked empty, never assumed');
  assert.ok(chunk.includes('api.chat_delete({ id: dead.threadId })'), 'only the ask own thread is removed');
  const send = s.indexOf("sendBtn.addEventListener('click'");
  const stay = s.indexOf("stayBtn.addEventListener('click'");
  assert.ok(send > 0 && stay > send, 'both consent buttons retire their own consent');
});

test('a failed consented cloud ask cleans up its empty thread in place', () => {
  const s = read('renderer/ask.js');
  const send = s.indexOf("sendBtn.addEventListener('click'");
  const stay = s.indexOf("stayBtn.addEventListener('click'");
  assert.ok(send > 0 && stay > send, 'the consent handlers exist');
  const chunk = s.slice(send, stay);
  assert.ok(chunk.includes('const cleanupEmptyAsk'), 'the consented path owns an empty-thread cleanup');
  assert.equal((chunk.match(/await cleanupEmptyAsk\(\)/g) || []).length, 3, 'the throw and both failure branches clean up');
  assert.ok(chunk.includes('msgs.messages.length === 0'), 'the thread is checked empty, never assumed');
  assert.ok(chunk.includes('api.chat_delete({ id: emptyId })'), 'only the ask own thread is removed');
});

test('every abandoned consent prompt is tracked, not just the latest', () => {
  const s = read('renderer/ask.js');
  assert.ok(s.includes('const pendingConsents = [];'), 'consents are tracked as a list');
  assert.ok(s.includes('const consentItem = { entry, threadId: askThreadId || null };') && s.includes('pendingConsents.push(consentItem);'), 'each consent registers its card and its ask thread');
  const ls = s.indexOf('async function loadSelected()');
  const chunk = s.slice(ls, ls + 1400);
  assert.ok(chunk.includes('[...pendingConsents]'), 'a switch sweeps every tracked consent');
  assert.ok(chunk.includes('pendingConsents.splice(pendingConsents.indexOf(dead), 1);'), 'swept consents leave the list');
  const send = s.indexOf("sendBtn.addEventListener('click'");
  const stay = s.indexOf("stayBtn.addEventListener('click'");
  const splices = (s.match(/pendingConsents\.indexOf\(consentItem\)/g) || []).length;
  assert.equal(splices, 2, 'send and stay each retire their own consent');
});

test('a failed ask cleans the picker even when the user switched away', () => {
  const s = read('renderer/ask.js');
  assert.equal((s.match(/if \(del\.ok\) \{/g) || []).length, 3, 'both m21 sites and the consented helper refresh unconditionally after a delete');
  assert.equal((s.match(/const wasCurrent = currentId === emptyId;/g) || []).length, 3, 'both cleanup sites and the consented helper branch on the selection');
  assert.equal((s.match(/await refreshList\(currentId\);/g) || []).length >= 2, true, 'the refresh keeps the user where they are');
});

test('a cancelled ask reads as cancelled, not as a failure', () => {
  const s = read('renderer/ask.js');
  assert.ok(s.includes('function isAskCancel(failure)'), 'a cancel detector exists');
  assert.equal((s.match(/'Ask cancelled\.'/g) || []).length, 4, 'every ask-completion site shows the neutral note on a cancel');
  assert.equal((s.match(/cancelled \? 'hint' : 'error'/g) || []).length, 4, 'a cancel is a hint, never styled as an error');
  assert.ok(s.includes("UI.friendlyError('ask_failed')"), 'real crashes keep their wording');
  assert.ok(s.includes('if (cancelled && !input.value.trim()) input.value = question;'), 'a cancelled ask hands the question back');
});

test('the desktop HTML carries every element the ask script needs', () => {
  const s = read('renderer/ask.js');
  const ids = [...s.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(ids.length > 5, 'the scan found the ask view ids');
  for (const f of ['renderer/index.html', 'web/index.html']) {
    const html = read(f);
    for (const id of ids) {
      assert.ok(html.includes(`id="${id}"`), `${f}: ask.js needs #${id}`);
    }
  }
});

test('a long unbroken thread title or status note wraps instead of pushing the page sideways', () => {
  const s = read('renderer/styles.css');
  assert.ok(s.includes('.ask-sub { color: var(--muted); font-size: 12px; margin: 4px 0 0; overflow-wrap: anywhere; }'), 'the thread title line wraps long runs');
  assert.ok(s.includes('#ask-conv-bar select { flex: 1 1 12rem; min-width: 0; text-overflow: ellipsis; }'), 'the conversation picker shrinks and truncates instead of sizing to its longest title');
  assert.ok(s.includes('.hint { color: var(--muted); font-size: 12px; margin: 6px 0; overflow-wrap: anywhere; }'), 'status hints wrap long runs');
  for (const rule of ['.error { color: var(--bad); overflow-wrap: anywhere; }',
    '.hint.error { color: var(--bad); overflow-wrap: anywhere; }',
    '.ov-answer.error { color: var(--bad); overflow-wrap: anywhere; }']) {
    assert.ok(s.includes(rule), `error rule wraps long runs: ${rule}`);
  }
});

test('the ask inputs accept exactly what conversation history accepts', () => {
  const hist = read('src/chat-history.js');
  const m = hist.match(/const MAX_MESSAGE_CHARS = (\d+);/);
  assert.ok(m, 'the store constant is readable');
  const cap = m[1];
  for (const f of ['renderer/index.html', 'web/index.html']) {
    const html = read(f);
    const t = html.match(/<textarea id="ask-input" rows="3" maxlength="(\d+)"/);
    assert.ok(t, `${f}: the ask textarea declares its cap`);
    assert.equal(t[1], cap, `${f}: the ask input cap matches the history store cap, so a paste is never silently shortened`);
  }
  const ov = read('renderer/overlay.html');
  const o = ov.match(/<input id="ov-input" type="text" maxlength="(\d+)"/);
  assert.ok(o, 'the overlay input declares its cap');
  assert.equal(o[1], cap, 'the overlay input cap matches the history store cap');
});

test('the rename input accepts exactly what conversation history keeps', () => {
  const hist = read('src/chat-history.js');
  const m = hist.match(/const MAX_TITLE_CHARS = (\d+);/);
  assert.ok(m, 'the title cap is readable');
  const cap = m[1];
  for (const f of ['renderer/index.html', 'web/index.html']) {
    const html = read(f);
    const t = html.match(/<input id="ask-rename-input" class="ask-sub" hidden maxlength="(\d+)"/);
    assert.ok(t, `${f}: the rename input declares its cap`);
    assert.equal(t[1], cap, `${f}: the rename input cap matches the history store cap, so a chosen title is never silently shortened`);
  }
});

test('deleting the thread that holds an in-flight ask cancels it first', () => {
  const s = read('renderer/ask.js');
  assert.ok(s.includes('let activeAsk = null;'), 'the in-flight ask is tracked');
  assert.equal((s.match(/activeAsk = \{ requestId/g) || []).length, 2, 'both ask call sites mark their in-flight state');
  assert.equal((s.match(/finally \{ activeAsk = null; \}/g) || []).length, 2, 'both call sites clear it when the ask settles');
  const del = s.indexOf("deleteBtn.addEventListener('click'");
  const chunk = s.slice(del, del + 900);
  const i = chunk.indexOf('const res = await api.chat_delete({ id: currentId })');
  const before = chunk.slice(0, i);
  assert.ok(before.includes('activeAsk && activeAsk.threadId === currentId'), 'the delete consults the in-flight ask state first');
  assert.ok(before.includes('await api.ai_cancel({ request_id: activeAsk.requestId })'), 'the delete cancels the stranded call before clearing the log');
});

test('a reload mid-ask leaves an empty thread that the boot sweep removes once', () => {
  const s = read('renderer/ask.js');
  assert.ok(s.includes('async function sweepEmptyThreads()'), 'the sweep exists');
  assert.ok(s.includes('if (msgs.ok && msgs.messages.length === 0)'), 'it deletes only zero-message threads');
  assert.ok(s.includes('await api.chat_delete({ id: c.id })'), 'it uses the same delete path as the failure cleanup');
  const guard = s.indexOf('if (!bootSwept) { bootSwept = true; await sweepEmptyThreads(); }');
  const show = s.indexOf("UI.onShow('ask'");
  const ref = s.indexOf('await refreshList();', show);
  assert.ok(guard > -1 && guard > show && guard < ref, 'the sweep runs once at boot, before the picker first lists threads');
  assert.ok(s.includes('let bootSwept = false;'), 'the boot guard is separate from the boot-landing flag');
});
