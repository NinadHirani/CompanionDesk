'use strict';

// Single source of truth for what the renderer may ask the main process to do.
// main.js registers handlers for exactly this list; anything else is refused.
// src/preload.js mirrors this list inline (sandboxed preloads cannot require
// local modules), so keep the two in sync when you add a channel.

const IPC_CHANNELS = Object.freeze([
  'state:get',
  'syllabus:import',
  'ai:ask',
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
]);

// Messages main may PUSH to a window (streaming tokens and the like). The
// renderer can only listen to these; the preload mirrors this list inline.
const IPC_EVENTS = Object.freeze(['overlay:token', 'overlay:reset', 'update:state', 'ollama:pullProgress']);

function isAllowed(channel) {
  return IPC_CHANNELS.includes(channel);
}

module.exports = { IPC_CHANNELS, IPC_EVENTS, isAllowed };
