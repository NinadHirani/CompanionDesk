'use strict';

// Single source of truth for what the renderer may ask the main process to do.
// main.js registers handlers for exactly this list; anything else is refused.
// src/preload.js mirrors this list inline (sandboxed preloads cannot require
// local modules), so keep the two in sync when you add a channel.

const IPC_CHANNELS = Object.freeze([
  'state:get',
  'syllabus:import',
  'ai:ask',
]);

function isAllowed(channel) {
  return IPC_CHANNELS.includes(channel);
}

module.exports = { IPC_CHANNELS, isAllowed };
