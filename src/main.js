'use strict';

// Electron entry. One process, one window for M0/M1; the companion overlay
// window arrives in M3. Nothing here requires a cloud service to start, and
// no billing, account, or telemetry path exists anywhere in this app.
// Handler logic lives in services.js and personal.js so it can be tested
// without Electron; this file only wires channels to those functions.

const { app, BrowserWindow, ipcMain, dialog, session, desktopCapturer, systemPreferences, shell, safeStorage } = require('electron');
const { createOverlayController } = require('./overlay');
const hotkey = require('./hotkey');
const voice = require('./voice');
const permissions = require('./permissions');
const SCREEN = require('./screen');
const { listWindows, captureWindow } = require('./screen-capture');
const { askAboutScreen } = require('./screen-service');
const { readDocs } = require('./docs');
const skills = require('./skills');
const { collectHealth } = require('./health');
const path = require('path');
const LocalDb = require('./db');
const { createAi } = require('./ai');
const { createSecureStore } = require('./secure-store');
const { resolveModelSelection } = require('./model-selection');
const chatHistory = require('./chat-history');
const OllamaSetup = require('./ollama-setup');
const { ingestSyllabus } = require('./ingest');
const { humanizeImportError } = require('./import-errors');
const { getBrief, setDone } = require('./services');
const P = require('./personal');
const G = require('./gradebook');
const CAL = require('./calendar');
const fs = require('fs');
const { todayIso, localNowIso, addDaysIso } = require('./dates');
const { createUpdateController } = require('./updater');
const policy = require('./update-policy');

const SMOKE = process.argv.includes('--smoke');

let db = null;
let ai = null;
let secureStore = null;
let win = null;
let overlay = null;

function vaultDir() {
  return path.join(app.getPath('userData'), 'vault');
}

// The user's own about-me file lives in the vault folder. Its name starts with
// an underscore, which no course file can (course slugs never do).
function meFile() {
  return path.join(vaultDir(), '_about-me.md');
}

function modelsDir() {
  return path.join(app.getPath('userData'), 'models');
}

function lockDownPermissions() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    callback(permissions.requestAllowed({ permission, mediaTypes: details && details.mediaTypes, url: wc ? wc.getURL() : '' }));
  });
  ses.setPermissionCheckHandler((wc, permission, _origin, details) =>
    permissions.checkAllowed({ permission, mediaType: details && details.mediaType, url: wc ? wc.getURL() : '' }));
}

function savedHotkey() {
  const n = hotkey.normalize(db.getSetting('overlay_hotkey', hotkey.DEFAULT_HOTKEY));
  return n.ok ? n.value : hotkey.DEFAULT_HOTKEY;
}

function ctx() {
  return { db, ai, meFile: meFile() };
}

// Which models actually answer: the user's saved choice when it is still
// installed, the built-in default otherwise. Nothing is pulled from here;
// the settings UI only ever offers models Ollama reports as installed.
async function modelSelection() {
  return resolveModelSelection({
    settings: P.getSettings(db),
    ai,
    chatFallback: ai.localModel,
    visionFallback: SCREEN.DEFAULT_VISION_MODEL,
  });
}

async function init() {
  const dataDir = path.join(app.getPath('userData'), 'data');
  db = await LocalDb.open({ file: path.join(dataDir, 'companiondesk.db') });
  // The optional Gemini key lives in the OS credential vault, decrypted in
  // this process only when a cloud call needs it. Without a saved key the
  // cloud fallback is off.
  secureStore = createSecureStore({ safeStorage, filePath: path.join(app.getPath('userData'), 'gemini.key.bin') });
  ai = createAi({ geminiKey: () => secureStore.readKey() });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    title: 'CompanionDesk',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.on('closed', () => {
    win = null;
    // On macOS the app stays alive with the dashboard closed so the overlay
    // keeps working. Elsewhere there is no dock or tray to quit from, so
    // closing the dashboard quits.
    if (process.platform !== 'darwin') app.quit();
  });
}

function registerUpdates() {
  // Signed-or-not decides what macOS can do; the policy keeps that honest.
  const identity = require('../package.json').build && require('../package.json').build.mac
    ? require('../package.json').build.mac.identity
    : null;
  try {
    const { autoUpdater } = require('electron-updater');
    createUpdateController({
      autoUpdater,
      app,
      settings: { update_channel: db.getSetting('update_channel', 'stable') },
      broadcast: (state) => {
        for (const w of BrowserWindow.getAllWindows()) {
          if (!w.isDestroyed()) w.webContents.send('update:state', state);
        }
      },
      openExternal: (url) => require('electron').shell.openExternal(url),
      platform: process.platform,
      appVersion: app.getVersion(),
      isPackaged: app.isPackaged,
      macSigning: policy.macSigningFromBuildConfig(identity),
    });
  } catch (err) {
    console.warn('updates unavailable:', err && err.message);
  }
}

function registerIpc() {
  // Only allowlisted channels get handlers; anything else is refused by never
  // having a handler at all. tests/ipc-sync.test.js keeps this list, the
  // allowlist and the preload in step.
  ipcMain.handle('state:get', async () => {
    const today = todayIso();
    return {
      today,
      courses: db.listCourses(),
      due: db.listDue(today, addDaysIso(today, 7)),
      counts: db.counts(),
      student: (() => { const s = P.getSettings(db); return { enabled: skills.studentEnabled(s), active: skills.studentActive(db, s) }; })(),
      ai: await ai.status(),
    };
  });

  ipcMain.handle('syllabus:import', async () => {
    const res = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Syllabi', extensions: ['pdf', 'txt', 'md'] }],
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
    const summaries = [];
    for (const file of res.filePaths) {
      try {
        const summary = await ingestSyllabus({ file, ai, db, vaultDir: vaultDir() });
        summaries.push({ ok: true, file: path.basename(file), ...summary });
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        if (!e.code) e.code = String(e.message || 'import_failed').split(':')[0].trim();
        summaries.push({ ok: false, file: path.basename(file), error: e.code, message: humanizeImportError(e) });
      }
    }
    return { ok: true, summaries };
  });

  ipcMain.handle('brief:today', async () => getBrief(db, todayIso()));
  ipcMain.handle('assignment:setDone', async (_e, payload) => setDone(db, payload, localNowIso()));
  ipcMain.handle('ai:ask', async (_e, payload) => {
    const sel = await modelSelection();
    return P.ask(ctx(), payload, todayIso(), { model: sel.chat.model });
  });

  // Conversation history: local only, created when the ask view asks for
  // one; the overlay keeps its single-shot behavior.
  ipcMain.handle('chat:list', async () => chatHistory.listConversations(db));
  ipcMain.handle('chat:messages', async (_e, payload) => chatHistory.getMessages(db, payload && payload.id));
  ipcMain.handle('chat:new', async () => chatHistory.createConversation(db, { now: localNowIso() }));
  ipcMain.handle('chat:rename', async (_e, payload) =>
    chatHistory.renameConversation(db, payload && payload.id, payload && payload.title));
  // Optional cloud key. The renderer gets masked status only; the key never
  // crosses the IPC boundary in either direction.
  ipcMain.handle('cloud:status', async () => ({ ok: true, ...secureStore.status() }));
  ipcMain.handle('cloud:setKey', async (_e, payload) => secureStore.saveKey(payload && payload.key));
  ipcMain.handle('cloud:testKey', async (_e, payload) => {
    const key = payload && payload.key ? String(payload.key) : undefined;
    const res = await ai.testGeminiKey(key != null && key ? { key } : {});
    return { ok: Boolean(res.ok), reason: res.reason || null };
  });
  ipcMain.handle('cloud:removeKey', async () => ({ ...secureStore.removeKey() }));
  ipcMain.handle('chat:delete', async (_e, payload) => chatHistory.deleteConversation(db, payload && payload.id));

  ipcMain.handle('ai:models', async () => ({
    ok: true,
    ...(await modelSelection()),
    defaults: { chat: ai.localModel, vision: SCREEN.DEFAULT_VISION_MODEL },
  }));

  ipcMain.handle('settings:get', async () => ({ ok: true, settings: P.getSettings(db) }));
  ipcMain.handle('settings:save', async (_e, payload) => P.saveSettings(db, payload));

  ipcMain.handle('memory:list', async () => P.listMemory(ctx()));
  ipcMain.handle('memory:add', async (_e, payload) => P.addMemory(ctx(), payload));
  ipcMain.handle('memory:forget', async (_e, payload) => P.forgetMemory(ctx(), payload));
  ipcMain.handle('memory:suggest', async (_e, payload) => P.suggest(ctx(), payload, localNowIso()));
  ipcMain.handle('memory:decide', async (_e, payload) => P.decide(ctx(), payload));

  ipcMain.handle('patterns:get', async () => P.getPatterns(db));
  ipcMain.handle('activity:clear', async () => P.clearActivity(db));

  ipcMain.handle('onboarding:get', async () => P.getOnboarding(db));
  ipcMain.handle('onboarding:answer', async (_e, payload) => P.answerOnboarding(ctx(), payload));
  ipcMain.handle('onboarding:complete', async () => P.completeOnboarding(db));

  ipcMain.handle('deadline:add', async (_e, payload) => P.addDeadline(ctx(), payload, todayIso()));
  ipcMain.handle('grades:get', async () => G.getGrades(db));
  ipcMain.handle('grades:setScore', async (_e, payload) => G.setScore(db, payload, localNowIso()));
  ipcMain.handle('grades:setTarget', async (_e, payload) => G.setTarget(db, payload));

  ipcMain.handle('calendar:import', async () => {
    const res = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: 'Calendar', extensions: ['ics'] }],
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
    const file = res.filePaths[0];
    try {
      if (fs.statSync(file).size > CAL.MAX_BYTES) return { ok: false, error: 'file_too_large' };
      return CAL.importCalendar(db, { name: path.basename(file), text: fs.readFileSync(file, 'utf8') }, localNowIso());
    } catch (err) {
      return { ok: false, error: 'read_failed' };
    }
  });
  ipcMain.handle('calendar:upcoming', async (_e, payload) => CAL.upcoming(db, payload, todayIso()));
  ipcMain.handle('calendar:remove', async (_e, payload) => CAL.removeCalendar(db, payload));

  ipcMain.handle('overlay:ask', async (_e, payload) => {
    const sel = await modelSelection();
    return P.ask(ctx(), payload, todayIso(), { model: sel.chat.model, onToken: (t) => overlay.send('overlay:token', t) });
  });
  ipcMain.handle('overlay:show', async () => { overlay.show(); return { ok: true }; });
  ipcMain.handle('overlay:hide', async () => { overlay.hide(); return { ok: true }; });
  ipcMain.handle('overlay:status', async () => ({ ok: true, hotkey: savedHotkey(), registered: overlay.getHotkey() !== null }));
  ipcMain.handle('overlay:setHotkey', async (_e, payload) => {
    const n = hotkey.normalize(payload && payload.accelerator);
    if (!n.ok) return n;
    const r = overlay.register(n.value);
    if (!r.ok) return r;
    db.setSetting('overlay_hotkey', n.value);
    return { ok: true, hotkey: n.value };
  });

  ipcMain.handle('voice:status', async () => voice.status({ modelsDir: modelsDir() }));
  ipcMain.handle('voice:transcribe', async (_e, payload) =>
    voice.transcribe(payload, { modelsDir: modelsDir(), language: process.env.WHISPER_LANG || 'en' }));

  ipcMain.handle('screen:status', async () => {
    const sel = await modelSelection();
    return { ok: true, model: sel.vision.model, available: await ai.hasModel(sel.vision.model) };
  });
  ipcMain.handle('screen:windows', async () => listWindows({ desktopCapturer, systemPreferences }));
  ipcMain.handle('screen:ask', async (_e, payload) =>
    askAboutScreen(ctx(), payload, todayIso(), {
      visionModel: (await modelSelection()).vision.model,
      capture: (windowId) => captureWindow({ desktopCapturer, systemPreferences, windowId }),
      onToken: (t) => overlay.send('overlay:token', t),
    }));

  ipcMain.handle('health:check', async () =>
    collectHealth({
      ai, voice, modelsDir: modelsDir(), visionModel: (await modelSelection()).vision.model, systemPreferences,
      hotkey: savedHotkey(), hotkeyRegistered: overlay.getHotkey() !== null, platform: process.platform,
    }));
  ipcMain.handle('app:docs', async () => readDocs(path.join(__dirname, '..')));

  ipcMain.handle('deadline:remove', async (_e, payload) => P.removeDeadline(ctx(), payload));

  // Ollama onboarding. The main process detects, reports the official install
  // route, opens ONLY the allowlisted official URLs, checks disk space, and
  // streams a user-initiated model pull. It never runs an installer and never
  // starts a download on its own; every pull begins with a renderer click.
  let pullAbort = null;
  ipcMain.handle('ollama:detect', async () => OllamaSetup.detectOllama({ ollamaUrl: OllamaSetup.defaultOllamaUrl() }));

  ipcMain.handle('ollama:setupPlan', async () => ({
    ok: true,
    platform: process.platform,
    plan: OllamaSetup.installPlan(process.platform),
  }));

  ipcMain.handle('ollama:openInstall', async () => {
    const plan = OllamaSetup.installPlan(process.platform);
    if (!plan || !plan.url || !OllamaSetup.isOpenableUrl(plan.url)) return { ok: false, error: 'no_plan' };
    await shell.openExternal(plan.url);
    return { ok: true, url: plan.url, kind: plan.kind };
  });

  ipcMain.handle('ollama:diskCheck', async (_e, payload) => {
    const neededBytes = Math.max(1, Number(payload && payload.neededBytes) || 1);
    const dir = app.getPath('home');
    try {
      const st = await fs.promises.statfs(dir);
      return OllamaSetup.diskVerdict({ freeBytes: Number(st.bavail) * Number(st.bsize), neededBytes });
    } catch (err) {
      return { ok: false, error: 'statfs_failed', message: String((err && err.message) || err) };
    }
  });

  ipcMain.handle('ollama:pullStart', async (e, payload) => {
    if (pullAbort) return { ok: false, error: 'pull_in_progress' };
    const model = payload && typeof payload.model === 'string' && payload.model.trim()
      ? payload.model.trim()
      : OllamaSetup.RECOMMENDED_MODEL;
    pullAbort = new AbortController();
    const sender = e.sender;
    try {
      const res = await OllamaSetup.pullModel({
        ollamaUrl: OllamaSetup.defaultOllamaUrl(),
        model,
        signal: pullAbort.signal,
        onProgress: (p) => {
          if (!sender.isDestroyed()) sender.send('ollama:pullProgress', p);
        },
      });
      return { ok: true, ...res };
    } catch (err) {
      const aborted = pullAbort.signal.aborted;
      return { ok: false, error: aborted ? 'cancelled' : String((err && err.message) || err) };
    } finally {
      pullAbort = null;
    }
  });

  ipcMain.handle('ollama:pullCancel', async () => {
    if (pullAbort) pullAbort.abort();
    return { ok: true };
  });
}

app.whenReady().then(async () => {
  await init();
  overlay = createOverlayController({
    preloadPath: path.join(__dirname, 'preload.js'),
    htmlPath: path.join(__dirname, '..', 'renderer', 'overlay.html'),
    iconPath: path.join(__dirname, '..', 'build', 'icon.png'),
  });
  lockDownPermissions();
  registerIpc();
  registerUpdates();
  overlay.ensure();
  overlay.register(savedHotkey());
  createWindow();
  if (SMOKE) {
    console.log('smoke-ok');
    setTimeout(() => app.quit(), 400);
  }
});

app.on('activate', () => {
  if (!win) createWindow();
});

app.on('before-quit', () => {
  if (db) db.flush();
});

app.on('will-quit', () => {
  if (overlay) overlay.unregisterAll();
});
