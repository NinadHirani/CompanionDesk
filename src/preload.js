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
  'ai:cancel',
  'ai:models',
  'chat:list',
  'chat:messages',
  'chat:new',
  'chat:rename',
  'chat:delete',
  'cloud:status',
  'cloud:setKey',
  'cloud:testKey',
  'cloud:removeKey',
  'brief:today',
  'assignment:setDone',
  'assignment:setCategory',
  'settings:get',
  'settings:save',
  'hardware:report',
  'provider:status',
  'memory:list',
  'memory:add',
  'memory:forget',
  'memory:suggest',
  'memory:decide',
  'memory:items',
  'memory:mark',
  'memory:persist',
  'memory:search',
  'patterns:get',
  'activity:clear',
  'onboarding:get',
  'onboarding:answer',
  'onboarding:complete',
  'deadline:add',
  'deadline:remove',
  'deadline:edit',
  'course:add',
  'course:rename',
  'course:remove',
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
  'voice:cancel',
  'wake:status',
  'wake:start',
  'wake:stop',
  'wake:pause',
  'wake:resume',
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

  // Gate 2 agent surface. Mirrors RENDERER_CHANNELS in ipc-contract.js
  // exactly: six reads plus ONE narrow exception, notifications:ack
  // (blueprint 3j.4 option C, chosen by the user on 24 Nov 2026): an
  // id-only acknowledgement REQUEST the panel emits only from an explicit
  // per-record user gesture. The renderer performs no write itself; main
  // validates the id and stays authoritative. No main-only channel (run
  // start/step/resume/abort, approvals, grants, stop, persistence) may
  // ever be added here.
  // M5 slice 1: the proactive scheduler user surface (product channels,
  // NOT part of the Gate 2 agent contract).
  'schedules:create',
  'schedules:list',
  'schedules:pause',
  'schedules:resume',
  'schedules:cancel',
  'schedules:update',

  'status:get',
  'runs:get',
  'audit:read',
  'providers:get',
  'notifications:read',
  'reminders:read',
  'notifications:ack',
  'workspace:rows',
  'workspace:connectors',
  'workspace:connectorConnect',
  'workspace:connectorDisconnect',
  'workspace:connectorRevoke',
  'workspace:connectorReadmit',
  'workspace:connectorCredentialSet',
  'workspace:connectorCredentialRemove',
  'workspace:connectorRequests',
  'workspace:connectorRequestResolve',
  // Real connector actions (27 Nov 2026 adapter batch): the action engine
  // and the OAuth setup helpers for adapters that run on a client the user
  // creates themselves.
  'workspace:connectorAction',
  'workspace:connectorOAuthAuthorizeUrl',
  'workspace:connectorOAuthExchange',
  'workspace:connectorCustomAdd',
  'workspace:connectorCustomRemove',
];

// Messages main may push to this window. Mirrors IPC_EVENTS in ipc-channels.js.
const IPC_EVENTS = ['overlay:token', 'overlay:reset', 'update:state', 'ollama:pullProgress', 'ai:token'];

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
