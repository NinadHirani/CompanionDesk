'use strict';

// Dedicated preload for the hidden wake listener window. Deliberately tiny:
// it exposes ONLY the listener's own channels, never the app's full IPC
// surface. The listener page receives start/mic commands (stopping is the
// window being destroyed) and sends scores and errors; it cannot ask for
// anything else. tests/ipc-sync.test.js enforces the exact mirror with
// main.js's wakeListenerWin sends.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wakeListener', {
  onStart: (cb) => { if (typeof cb === 'function') ipcRenderer.on('wake:listener:start', (_e, payload) => cb(payload)); },
  onMic: (cb) => { if (typeof cb === 'function') ipcRenderer.on('wake:listener:mic', (_e, payload) => cb(payload)); },
  sendScore: (score) => {
    if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) return;
    ipcRenderer.send('wake:listener:score', score);
  },
  sendReady: () => ipcRenderer.send('wake:listener:ready'),
  sendError: (msg) => ipcRenderer.send('wake:listener:error', String(msg && msg.message ? msg.message : msg)),
});
