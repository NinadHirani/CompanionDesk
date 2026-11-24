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
const os = require('os');
const Hardware = require('./hardware');
const ProviderStatus = require('./provider-status');
const { chatFallbackForProfile, recommendedForProfile } = require('./model-selection');
const { todayIso, localNowIso, addDaysIso } = require('./dates');
const { createUpdateController } = require('./updater');
const policy = require('./update-policy');

// Gate 2 wiring: the agent runtime is owned by main. The renderer reaches
// it only through the six read-only channels of ipc-contract.js (wired by
// agent-surface.js). Run start/step/resume/abort, approvals, grants,
// emergency stop and persistence are main-only and are NOT wired to any
// handler in this slice: nothing in this file calls them either.
const { createRegistry } = require('./tool-registry');
const { createApprovalDesk } = require('./approval');
const { createEmergencyStop } = require('./emergency-stop');
const { createAuditLog } = require('./audit');
const { createPolicyEngine } = require('./policy-engine');
const { createOrchestrator } = require('./agent-orchestrator');
const { createNotificationDesk } = require('./agent-notifications');
const { createNotificationsDisplayStore } = require('./agent-notifications-display');
const { createDisplayDelivery } = require('./agent-display-delivery');
const { createRunDriver } = require('./agent-run-driver');
const { createReminderBook } = require('./agent-reminders');
const { createAgentSurface } = require('./agent-surface');
const { createSchedulerSurface } = require('./scheduler-surface');
const { createAgentRuntime, createAgentStack } = require('./agent-runtime');
const { createAgentPersistence } = require('./agent-persistence');

const SMOKE = process.argv.includes('--smoke');

let db = null;
let ai = null;
// Detected once at startup from the OS's own APIs (local-only); the renderer
// only ever receives sanitized facts via hardware:report.
let hardwareRaw = null;
// In-flight ask abort controllers, keyed by request id (M1 slice 2): the
// renderer cancels through ai:cancel, the abort reaches the network call and
// the streaming reader, and no retry follows.
const askControllers = new Map();
let secureStore = null;
let win = null;
let overlay = null;

// The in-memory agent runtime (Gate 2). Constructed in init(); nothing in
// main starts or advances a run in this slice.
let agentRegistry = null;
let agentApprovals = null;
let agentStop = null;
let agentAudit = null;
  let agentPersistence = null;
  let agentRunDriver = null;
let agentOrchestrator = null;
let agentNotifications = null;
let agentScheduler = null;
let schedulerSurface = null;
// Main-owned notification display store (blueprint 3j.3): separate from the
// persisted desk, in-memory only, no read semantics. The renderer reads it
// through the existing notifications:read channel and can never write it.
//
// Display delivery (blueprint 3j.6): the narrow MAIN-ONLY operation below
// copies unread desk records into this store. It never marks the desk read
// and never acknowledges; the 3j.4/3j.5 decision (option C) stands. The
// pass runs ONLY at two main-side moments: once after the agent runtime
// starts (restart reconciliation) and after every successful
// acknowledgement. A future main-side creation site must call
// runDisplayDelivery() in the same step. There is no renderer trigger, no
// timer and no other path into this store.
const notificationsDisplay = createNotificationsDisplayStore();
const displayDelivery = createDisplayDelivery({
  readDesk: () => (agentNotifications ? agentNotifications.list() : null),
  store: notificationsDisplay,
});
function runDisplayDelivery() {
  const r = displayDelivery.deliver();
  if (!r || r.ok !== true) {
    console.warn('[agent] display delivery refused: ' + String((r && r.reason) || 'unknown'));
  }
  return r;
}
let agentReminders = null;
let agentSurface = null;
let agentRuntime = null;

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
// The hardware profile steers only the DEFAULT models, never an explicit
// choice; unknown hardware stays on the conservative lightweight tier.
function effectiveProfile(settings) {
  return Hardware.resolveProfile(settings.hardware_profile, Hardware.classifyProfile(hardwareRaw || {}));
}

async function modelSelection() {
  const settings = P.getSettings(db);
  return resolveModelSelection({
    settings,
    ai,
    chatFallback: chatFallbackForProfile(effectiveProfile(settings)),
    visionFallback: SCREEN.DEFAULT_VISION_MODEL,
  });
}

async function init() {
  const dataDir = path.join(app.getPath('userData'), 'data');
  db = await LocalDb.open({ file: path.join(dataDir, 'companiondesk.db') });
  hardwareRaw = Hardware.detectNodeHardware(os);
  // The optional Gemini key lives in the OS credential vault, decrypted in
  // this process only when a cloud call needs it. Without a saved key the
  // cloud fallback is off.
  secureStore = createSecureStore({ safeStorage, filePath: path.join(app.getPath('userData'), 'gemini.key.bin'), platform: process.platform });
  // Cloud fallback is double-gated: the saved key AND the explicit
  // cloud_enabled setting (default false). A key alone arms nothing.
  ai = createAi({ geminiKey: () => secureStore.readKey(), cloudEnabled: P.getSettings(db).cloud_enabled === true });
  // Agent runtime, now persistence-backed (Gate 2 slice P2). The stack is
  // built by a factory so every recovery starts from FRESH desks and never
  // reuses a possibly poisoned stack. The state store is a dedicated
  // LocalDb file next to the course database. Secrets never enter this
  // store: the Gemini key stays in the OS credential vault (secureStore),
  // which remains the only credential storage this app uses. No agent run
  // is ever resumed automatically across a restart.
  agentRuntime = createAgentRuntime({
    openDb: () => LocalDb.open({ file: path.join(app.getPath('userData'), 'agent-state.db') }),
    buildAgent: ({ db: agentDb }) => {
      // ONE shared factory (agent-runtime.js) builds the stack, so the
      // integration test proves the exact construction the app runs:
      // persistence FIRST, then the orchestrator wired to the persistence
      // layer's durable audit wrapper (never the raw audit log).
      const stack = createAgentStack({ db: agentDb, clock: () => Date.now() });
      agentRegistry = stack.registry;
      agentApprovals = stack.approvals;
      agentStop = stack.emergencyStop;
      agentAudit = stack.audit;
      // The acknowledgement writer needs the persistence LAYER (its
      // durable appendAudit and save), not the raw log. Blueprint 3j.5.
      agentPersistence = stack.persistence;
      // Gate 2 3j.9 Stage A: the run driver is constructed and ready but
      // nothing in this build calls it (decision D1: runs come only from
      // explicit user-initiated plans, whose entry point is a later gate).
      // The registry stays EMPTY (nothing registers tools), so no step can
      // execute even if a run were started.
      agentRunDriver = createRunDriver({
        orchestrator: stack.orchestrator,
        persistence: stack.persistence,
        notifications: stack.notifications,
        registry: stack.registry,
      });
      agentOrchestrator = stack.orchestrator;
      agentNotifications = stack.notifications;
      agentReminders = stack.reminders;
      // M5 slice 1: the proactive scheduler rides the same stack and the
      // same durable persistence path as the Gate 2 desks.
      agentScheduler = stack.schedules;
      return stack;
    },
  });
  const agentStarted = await agentRuntime.start();
  if (!agentStarted.ok) {
    // Fail-closed and non-destructive: the agent surface reports the
    // blocked state and refuses every write path; the rest of the app runs
    // normally. No automatic reset, no fallback to an empty store.
    console.warn('[agent] persistence blocked:', (agentStarted.problems || []).join('; '));
  }
  // Restart reconciliation (blueprint 3j.6): repopulate the ephemeral
  // display store from the desk's unread records. A blocked runtime makes
  // this pass refuse honestly; the desk keeps every record either way.
  runDisplayDelivery();
  // Gate 2 3j.9 Stage A, decision D4: reconcile ledger rows still marked
  // 'running' from a previous session. Best effort: a refusal is logged and
  // never blocks startup.
  if (agentPersistence) {
    const rec = agentPersistence.reconcileInterruptedRuns();
    if (!rec || rec.ok !== true) {
      console.warn('[agent] run reconciliation refused: ' + String((rec && rec.reason) || 'unknown'));
    }
  }
  agentSurface = createAgentSurface({
    status: () => {
      if (!agentRuntime.isActive()) {
        return {
          agentActive: false,
          persistenceBlocked: true,
          persistenceProblems: agentRuntime.problems() || [],
          stopped: false,
          activeRun: null,
          notificationsPending: 0,
          remindersScheduled: 0,
          auditEntries: 0,
        };
      }
      const active = agentOrchestrator.activeRun();
      return {
        agentActive: true,
        persistenceBlocked: false,
        persistenceProblems: [],
        stopped: agentStop.isActive() === true,
        activeRun: active ? active.runId : null,
        notificationsPending: agentNotifications.pending().length,
        remindersScheduled: agentReminders.list().filter((x) => x.cancelled !== true).length,
        auditEntries: agentAudit.snapshot().entries.length,
      };
    },
    listRuns: (runId) => {
      if (!agentRuntime.isActive()) return [];
      if (runId) {
        const st = agentOrchestrator.getRun(runId);
        return st ? [st] : [];
      }
      const active = agentOrchestrator.activeRun();
      return active ? [active] : [];
    },
    readAudit: (f) => {
      if (!agentRuntime.isActive()) {
        return { base: { seq: 0, hash: null }, entries: [], lastHash: null, verified: true, persistenceBlocked: true };
      }
      const fromSeq = Number.isInteger(f.fromSeq) ? f.fromSeq : 1;
      const limit = Number.isInteger(f.limit) ? f.limit : 500;
      const snap = agentAudit.snapshot();
      const entries = snap.entries.filter((e) => e.seq >= fromSeq).slice(0, limit);
      return { base: snap.base, entries, lastHash: snap.lastHash, verified: agentAudit.verify().ok === true };
    },
    listProviders: async (name) => {
      const sel = await modelSelection();
      const status = ProviderStatus.buildProviderStatus({
        ollamaUp: sel.ollama,
        installed: sel.installed,
        chat: sel.chat,
        vision: sel.vision,
        secureStore: secureStore.status(),
        cloudEnabled: P.getSettings(db).cloud_enabled === true,
        ollamaFault: sel.fault || null,
        caps: sel.caps,
        capsFaults: sel.capsFaults || null,
      });
      const list = [status].filter(Boolean);
      return name ? list.filter((x) => x && x.name === name) : list;
    },
    listNotifications: (limit) => (agentRuntime.isActive() ? agentNotifications.list().slice(0, Number.isInteger(limit) ? limit : 500) : []),
    listDisplayNotifications: (limit) => notificationsDisplay.list(limit),
    listReminders: (limit) => (agentRuntime.isActive() ? agentReminders.list().slice(0, Number.isInteger(limit) ? limit : 500) : []),
    // Blueprint 3j.5 (option C): the ONE writer the renderer can reach,
    // and only through the notifications:ack id-only request. The
    // persistence layer performs the transition and stays authoritative;
    // a blocked or failed runtime refuses here (fail closed), it never
    // falls back.
    acknowledgeNotification: (id) => {
      const r = agentRuntime.isActive() && agentPersistence
        ? agentPersistence.acknowledgeNotification(id)
        : { ok: false, reason: 'persistence_unavailable' };
      // Blueprint 3j.6: after a successful acknowledgement a delivery pass
      // frees the evicted slot deterministically (the acked record becomes
      // safe to displace) and the next unread record reaches the display
      // store. The pass never acknowledges anything; the response shape is
      // unchanged.
      if (r && r.ok === true) runDisplayDelivery();
      return r;
    },
  });
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

// M5 slice 1: the proactive delivery loop. Main-process only, no network,
// no cloud. A scheduler tick marks due schedules fired EXACTLY ONCE; the
// user's opt-in settings decide whether an OS notification is actually
// shown. Quiet hours defer a due schedule to the window's end and never
// drop it (the scheduler enforces that). Every delivery attempt or skip is
// audited through the persistence layer's durable log. Nothing here runs
// unless the user both created a schedule AND turned delivery on.
function proactiveQuietHours(s) {
  return {
    enabled: s.proactive_quiet_enabled === true,
    start: typeof s.proactive_quiet_start === 'string' ? s.proactive_quiet_start : '22:00',
    end: typeof s.proactive_quiet_end === 'string' ? s.proactive_quiet_end : '08:00',
  };
}

function proactiveScopeAllowed(s, scope) {
  if (s.proactive_enabled !== true) return false;
  return scope === 'reminder' ? s.proactive_scope_reminder === true : s.proactive_scope_deadline === true;
}

// The OS notification adapter. Deliberately tiny and isolated: everything
// around it (ticks, quiet hours, exactly-once, audit) is pure and tested;
// this is the one impure boundary, guarded so an unsupported platform
// reports a clean refusal instead of throwing.
function createOsNotifier() {
  let Notification = null;
  try { Notification = require('electron').Notification; } catch (e) { Notification = null; }
  return (title, body) => {
    if (!Notification || typeof Notification.isSupported !== 'function' || !Notification.isSupported()) {
      return { ok: false, reason: 'unsupported' };
    }
    try {
      const n = new Notification({ title, body });
      n.show();
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: 'show_failed' };
    }
  };
}
const osNotifier = createOsNotifier();

let proactiveTimer = null;
function runProactiveTick() {
  if (proactiveTimer === null) return; // loop stopped
  // A blocked runtime or missing persistence means no tick at all: the
  // in-memory fired mark could not be persisted, so firing now could
  // re-fire after a restart. Fail closed by doing nothing.
  if (!agentRuntime.isActive() || !agentScheduler || !agentPersistence) return;
  let s;
  try { s = P.getSettings(db); } catch (e) { return; }
  const result = agentScheduler.tick(Date.now(), { quietHours: proactiveQuietHours(s) });
  if (!result.due.length && !result.deferred.length) return;
  for (const r of result.due) {
    let outcome;
    if (proactiveScopeAllowed(s, r.scope)) {
      const delivered = osNotifier(r.title, r.notes || (r.scope === 'reminder' ? 'Reminder' : 'Deadline'));
      outcome = delivered && delivered.ok === true ? 'shown' : 'failed:' + ((delivered && delivered.reason) || 'unknown');
    } else {
      outcome = 'skipped_settings';
    }
    try {
      agentPersistence.appendAudit({ actor: 'system', action: 'proactive.delivery', detail: { id: r.id, scope: r.scope, outcome } });
    } catch (e) { /* the fired mark is already durable-side pending; never throw from the timer */ }
  }
  try { agentPersistence.save(); } catch (e) { /* best effort; next tick converges */ }
}

function startProactiveLoop() {
  if (proactiveTimer !== null) return;
  proactiveTimer = setInterval(runProactiveTick, 60000);
  if (typeof proactiveTimer.unref === 'function') proactiveTimer.unref();
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
  // One AbortController per ask, keyed by the renderer's request id, so a
  // cancel aborts the network call and the streaming reader, and nothing
  // retries afterwards. The controllers map sits above the handlers.
  ipcMain.handle('ai:ask', async (_e, payload) => {
    const sel = await modelSelection();
    const requestId = payload && typeof payload.request_id === 'string' ? payload.request_id : `ask_${Date.now()}`;
    const controller = new AbortController();
    askControllers.set(requestId, controller);
    try {
      return await P.ask(ctx(), payload, todayIso(), {
        model: sel.chat.model,
        signal: controller.signal,
      });
    } finally {
      askControllers.delete(requestId);
    }
  });
  ipcMain.handle('ai:cancel', (_e, payload) => {
    const id = payload && payload.request_id;
    const controller = id ? askControllers.get(id) : null;
    if (controller) controller.abort();
    return { ok: true, canceled: Boolean(controller) };
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
    defaults: { chat: chatFallbackForProfile(effectiveProfile(P.getSettings(db))), vision: SCREEN.DEFAULT_VISION_MODEL },
  }));

  ipcMain.handle('settings:get', async () => ({ ok: true, settings: P.getSettings(db) }));

  // Hardware facts for Settings: read once at startup from the OS's own APIs,
  // then sanitized before leaving this process (coarse memory buckets only:
  // no exact bytes, no architecture, no free-memory reading, nothing that
  // could fingerprint the device). The recommendation only names models
  // Ollama already has installed; nothing is downloaded.
  ipcMain.handle('hardware:report', async () => {
    const settings = P.getSettings(db);
    const profile = effectiveProfile(settings);
    let installed = null;
    try { installed = await ai.listModels(); } catch { installed = null; }
    const names = Array.isArray(installed)
      ? installed.map((m) => String((m && m.name) || '')).filter(Boolean)
      : null;
    return {
      ok: true,
      ...Hardware.sanitizeHardware(hardwareRaw),
      profile,
      recommendation: recommendedForProfile(profile, names),
    };
  });

  // One provider-status snapshot for Settings, on demand only. It gathers
  // the bounded LOCAL probes (Ollama tags/show) and the OS vault's masked
  // booleans; it never contacts the cloud and never polls. Key material is
  // never passed anywhere: only the vault's configured boolean is read.
  ipcMain.handle('provider:status', async () => {
    const sel = await modelSelection();
    return {
      ok: true,
      ...ProviderStatus.buildProviderStatus({
        ollamaUp: sel.ollama,
        installed: sel.installed,
        chat: sel.chat,
        vision: sel.vision,
        secureStore: secureStore.status(),
        cloudEnabled: P.getSettings(db).cloud_enabled === true,
        ollamaFault: sel.fault || null,
        caps: sel.caps,
        capsFaults: sel.capsFaults || null,
      }),
    };
  });
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
    const requestId = payload && typeof payload.request_id === 'string' ? `overlay_${payload.request_id}` : `overlay_${Date.now()}`;
    const controller = new AbortController();
    askControllers.set(requestId, controller);
    try {
      return await P.ask(ctx(), payload, todayIso(), {
        model: sel.chat.model,
        onToken: (t) => overlay.send('overlay:token', t),
        signal: controller.signal,
      });
    } finally {
      askControllers.delete(requestId);
    }
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

  ipcMain.handle('voice:status', async () => {
    const s = voice.status({ modelsDir: modelsDir() });
    return { ...s, enabled: db.getSetting('voice_enabled', false) === true };
  });
  ipcMain.handle('voice:transcribe', async (_e, payload) => {
    if (!db.getSetting('voice_enabled', false)) return { ok: false, error: 'voice_disabled' };
    return voice.transcribe(payload, { modelsDir: modelsDir(), language: process.env.WHISPER_LANG || 'en' });
  });
  ipcMain.handle('voice:cancel', async () => voice.cancelActiveRun());

  ipcMain.handle('screen:status', async () => {
    const sel = await modelSelection();
    return { ok: true, model: sel.vision.model, available: await ai.hasModel(sel.vision.model) };
  });
  ipcMain.handle('screen:windows', async () => listWindows({ desktopCapturer, systemPreferences }));
  ipcMain.handle('screen:ask', async (_e, payload) => {
    const requestId = payload && typeof payload.request_id === 'string' ? `screen_${payload.request_id}` : `screen_${Date.now()}`;
    const controller = new AbortController();
    askControllers.set(requestId, controller);
    try {
      return await askAboutScreen(ctx(), payload, todayIso(), {
        visionModel: (await modelSelection()).vision.model,
        capture: (windowId) => captureWindow({ desktopCapturer, systemPreferences, windowId }),
        onToken: (t) => overlay.send('overlay:token', t),
        signal: controller.signal,
      });
    } finally {
      askControllers.delete(requestId);
    }
  });

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
  // Gate 2 wiring: register the read-only agent surface, one literal line
  // per contract channel so the ipc-sync structural guard can parse them
  // and prove main registers a handler for every channel and no others.
  // If construction failed, nothing registers and every renderer call
  // fails closed. The handlers themselves come from agent-surface.js,
  // whose tests prove its key set equals the contract's RENDERER_CHANNELS.
  try {
    if (!agentSurface) throw new Error('agent surface not constructed');
    ipcMain.handle('status:get', agentSurface.handlers['status:get']);
    ipcMain.handle('runs:get', agentSurface.handlers['runs:get']);
    ipcMain.handle('audit:read', agentSurface.handlers['audit:read']);
    ipcMain.handle('providers:get', agentSurface.handlers['providers:get']);
    ipcMain.handle('notifications:read', agentSurface.handlers['notifications:read']);
    ipcMain.handle('reminders:read', agentSurface.handlers['reminders:read']);
    // The ONE non-read channel (blueprint 3j.4 option C): an id-only
    // acknowledgement request from an explicit per-record user gesture.
    // Main stays authoritative: the persistence layer validates the id,
    // records the acknowledgement durably (audit row + anchor in ONE
    // transaction, flushed before the desk flips) and refuses on any
    // integrity or durability failure.
    ipcMain.handle('notifications:ack', agentSurface.handlers['notifications:ack']);
    // M5 slice 1: the scheduler's user surface. Product channels (like
    // settings:*), registered as literal lines so the ipc-sync structural
    // guard keeps the allowlist, the preload and these handlers in step.
    // The scheduler is NOT part of the agent contract and the agent
    // registry never sees it.
    if (!agentScheduler) throw new Error('scheduler not constructed');
    schedulerSurface = createSchedulerSurface({ schedules: agentScheduler, persistence: agentPersistence });
    ipcMain.handle('schedules:create', schedulerSurface.handlers['schedules:create']);
    ipcMain.handle('schedules:list', schedulerSurface.handlers['schedules:list']);
    ipcMain.handle('schedules:pause', schedulerSurface.handlers['schedules:pause']);
    ipcMain.handle('schedules:resume', schedulerSurface.handlers['schedules:resume']);
    ipcMain.handle('schedules:cancel', schedulerSurface.handlers['schedules:cancel']);
    ipcMain.handle('schedules:update', schedulerSurface.handlers['schedules:update']);
  } catch (e) {
    console.error('[agent] read-only surface unavailable:', e && e.message);
  }
  // M5 slice 1: start the proactive delivery loop only after the surfaces
  // are registered. With no schedules and delivery off by default it is
  // inert: the first fire happens only for a schedule the user created.
  startProactiveLoop();
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
  // The agent state store converges and closes first: an acknowledged
  // transition is already durable (each append flushes), so this final save
  // only converges desk state. A blocked runtime saves nothing. The result
  // is reported bounded: outcome and reason code only, never paths,
  // machine details, or secrets.
  if (agentRuntime) {
    const q = agentRuntime.beforeQuit();
    console.log('[agent-state] ' + (q.ok ? 'converged and closed' : 'save failed (' + String(q.reason || 'persist_failure') + '); store closed'));
  }
  if (db) {
    try {
      db.flush();
    } catch (err) {
      console.error('[store] flush failed (' + String((err && err.code) || (err && err.message) || 'unknown') + ')');
    }
  }
});

app.on('will-quit', () => {
  if (overlay) overlay.unregisterAll();
  // The display store is in-memory only: closing it just refuses further
  // appends; its frozen snapshot stays readable and is then discarded.
  notificationsDisplay.close();
  // The main store closes with the app; a failed close changes nothing.
  if (db) {
    try { db.close(); } catch (err) { /* closing is best effort */ }
    db = null;
  }
});
