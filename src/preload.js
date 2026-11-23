'use strict';

// Sandboxed preload: relative requires are unavailable inside a sandboxed
// renderer, so the channel list is inlined here. It MUST mirror
// src/ipc-channels.js; main.js independently registers handlers only for its
// own copy of the list, so a stray channel fails closed on both sides.

const { contextBridge, ipcRenderer } = require('electron');

const IPC_CHANNELS = [
  'state:get',
  'syllabus:import',
  'ai:ask',
  'ai:models',
  'brief:today',
  'assignment:setDone',
  'settings:get',
  'settings:save',
  'memory:list',
  'memory:add',
  'memory:forget',
  'memory:suggest',
  'memory:decide',
  'patterns:get',
  'activity:clear',
  'onboarding:get',
  'onboarding:answer',
  'onboarding:complete',
  'deadline:add',
  'deadline:remove',
  'grades:get',
  'grades:setScore',
  'grades:setTarget',
  'calendar:import',
  'calendar:upcoming',
  'calendar:remove',
  'overlay:ask',
  'overlay:show',
  'overlay:hide',
  'overlay:setHotkey',
  'overlay:status',
  'voice:status',
  'voice:transcribe',
  'screen:status',
  'screen:windows',
  'screen:ask',
  'app:docs',
  'health:check',
  'update:status',
  'update:check',
  'update:download',
  'update:install',
  'update:openReleases',
  'ollama:detect',
  'ollama:setupPlan',
  'ollama:openInstall',
  'ollama:diskCheck',
  'ollama:pullStart',
  'ollama:pullCancel',
];

// Messages main may push to this window. Mirrors IPC_EVENTS in ipc-channels.js.
const IPC_EVENTS = ['overlay:token', 'overlay:reset', 'update:state', 'ollama:pullProgress'];

const api = {};
for (const channel of IPC_CHANNELS) {
  api[channel.replaceAll(':', '_')] = (...args) => ipcRenderer.invoke(channel, ...args);
}

// Listen to an allowlisted push event. Returns a function that stops listening.
// The callback receives only the payload, never the raw Electron event.
api.on = (channel, callback) => {
  if (!IPC_EVENTS.includes(channel) || typeof callback !== 'function') return () => {};
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('companiondesk', api);
