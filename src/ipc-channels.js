'use strict';

// Single source of truth for what the renderer may ask the main process to do.
// main.js registers handlers for exactly this list; anything else is refused.
// src/preload.js mirrors this list inline (sandboxed preloads cannot require
// local modules), so keep the two in sync when you add a channel.

const IPC_CHANNELS = Object.freeze([
  'state:get',
  'hardware:report',
  'provider:status',
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
  // M6 slice 4: wake word. Explicit user action only (wake:start carries
  // userInitiated from a direct control click); nothing autostarts.
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

  // Gate 2 agent surface (ipc-contract.js RENDERER_CHANNELS): six reads
  // plus ONE narrow exception, notifications:ack (blueprint 3j.4 option C,
  // the user's decision of 24 Nov 2026): an id-only acknowledgement
  // REQUEST emitted only from an explicit per-record user gesture in the
  // panel. Main stays authoritative: it validates the id, performs the
  // transition through the persistence layer's durable audit guarantees,
  // and refuses everything else. Run start/step/resume/abort, approvals,
  // grants, stop and persistence stay main-only and are never listed here.
  // M5 slice 1: the proactive scheduler's USER surface. These are product
  // channels like settings:*, driven by explicit user gestures in the UI;
  // they are NOT part of the Gate 2 agent contract (ipc-contract.js
  // RENDERER_CHANNELS stays read-only) and the agent registry never sees
  // the scheduler. "Proactive actions run only on schedules the user set"
  // is enforced by that split: no agent path can create, pause or fire one.
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
]);

// Messages main may PUSH to a window (streaming tokens and the like). The
// renderer can only listen to these; the preload mirrors this list inline.
const IPC_EVENTS = Object.freeze(['overlay:token', 'overlay:reset', 'update:state', 'ollama:pullProgress']);

function isAllowed(channel) {
  return IPC_CHANNELS.includes(channel);
}

module.exports = { IPC_CHANNELS, IPC_EVENTS, isAllowed };
