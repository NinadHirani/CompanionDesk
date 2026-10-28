'use strict';

// Electron entry. One process, one window for M0/M1; the companion overlay
// window arrives in M3. Nothing here requires a cloud service to start, and
// no billing, account, or telemetry path exists anywhere in this app.

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { IPC_CHANNELS } = require('./ipc-channels');
const LocalDb = require('./db');
const { createAi } = require('./ai');
const { ingestSyllabus } = require('./ingest');
const vault = require('./vault');
const { humanizeImportError } = require('./import-errors');

const SMOKE = process.argv.includes('--smoke');

// Companion voice comes from the skill registry (src/skills.js). The general
// companion is the default; the optional student module appends its own lines
// only when student data exists. Companion ideas credited to potlakai/nus-desktop (MIT),
// generalized for non-student use.
const { createSkills } = require('./skills');

let db = null;
let ai = null;
let skills = null;
let win = null;

function todayIso() {
  const d = new Date();
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
}

function addDaysIso(iso, days) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function vaultDir() {
  return path.join(app.getPath('userData'), 'vault');
}

async function init() {
  const dataDir = path.join(app.getPath('userData'), 'data');
  db = await LocalDb.open({ file: path.join(dataDir, 'companiondesk.db') });
  ai = createAi();
  skills = createSkills();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    title: 'CompanionDesk',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

function buildContextPack() {
  const lines = [
    `Context pack (today: ${todayIso()}). This is everything the app knows; do not go beyond it.`,
    ...skills.context(db, { todayIso, addDaysIso }),
  ];
  return lines.join('\n');
}

function registerIpc() {
  // Only allowlisted channels get handlers; anything else is refused by never
  // having a handler at all.
  ipcMain.handle('state:get', async () => {
    const today = todayIso();
    return {
      today,
      courses: db.listCourses(),
      due: db.listDue(today, addDaysIso(today, 7)),
      counts: db.counts(),
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

  ipcMain.handle('ai:ask', async (_event, payload) => {
    const prompt = payload && typeof payload.prompt === 'string' ? payload.prompt.trim() : '';
    if (!prompt) return { ok: false, error: 'empty_prompt' };
    try {
      const answer = await ai.complete({ system: skills.system(db), prompt: buildContextPack() + '\n\nQuestion: ' + prompt });
      return { ok: true, answer };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });
}

app.whenReady().then(async () => {
  await init();
  registerIpc();
  createWindow();
  if (SMOKE) {
    console.log('smoke-ok');
    setTimeout(() => app.quit(), 400);
  }
});

app.on('window-all-closed', () => {
  if (db) db.flush();
  app.quit();
});
