'use strict';

// Sandboxed preload: relative requires are unavailable inside a sandboxed
// renderer, so the channel list is inlined here. It MUST mirror
// src/ipc-channels.js; main.js independently registers handlers only for its
// own copy of the list, so a stray channel fails closed on both sides.

const { contextBridge, ipcRenderer } = require('electron');

const IPC_CHANNELS = ['state:get', 'syllabus:import', 'ai:ask'];

const api = {};
for (const channel of IPC_CHANNELS) {
  api[channel.replaceAll(':', '_')] = (...args) => ipcRenderer.invoke(channel, ...args);
}

contextBridge.exposeInMainWorld('companiondesk', api);
