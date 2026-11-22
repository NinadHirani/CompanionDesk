'use strict';

// The setup check: what works, what is missing, and the exact fix for each.
// buildHealth is pure (plain facts in, a list out). collectHealth gathers the
// facts from the running app, with its dependencies passed in so tests can
// fake them.
//
// Status meanings:
//   ok        working
//   needed    the app cannot answer questions until this is fixed
//   optional  a feature the user has not set up; nothing is broken

const ORDER = ['ollama', 'model', 'shortcut', 'voice', 'vision', 'screen', 'mic'];

function item(id, label, status, detail, fix) {
  return { id, label, status, detail, fix: fix || null };
}

// facts: { ollama, model, modelLoaded, visionModel, hasVision, voice: {available, reason}, modelsDir,
//          screenPermission, micPermission, hotkey, hotkeyRegistered, platform }
// -> { ready, items }   ready is true when nothing 'needed' is outstanding.
function buildHealth(f) {
  const items = [];

  items.push(
    f.ollama
      ? item('ollama', 'Ollama', 'ok', 'Running.')
      : item('ollama', 'Ollama', 'needed', 'Not detected, so there is no local model to answer with.', {
          text: 'Install Ollama from ollama.com and open it. It runs in the background.',
        })
  );

  if (!f.ollama) {
    items.push(item('model', `Model ${f.model}`, 'needed', 'Waiting for Ollama.', null));
  } else if (f.modelLoaded) {
    items.push(item('model', `Model ${f.model}`, 'ok', 'Installed.'));
  } else {
    items.push(item('model', `Model ${f.model}`, 'needed', 'Ollama is running but this model is not downloaded yet.', {
      text: 'Download it once (a few GB):',
      command: `ollama pull ${f.model}`,
    }));
  }

  items.push(
    f.hotkeyRegistered
      ? item('shortcut', 'Overlay shortcut', 'ok', `${f.hotkey} opens the overlay from anywhere.`)
      : item('shortcut', 'Overlay shortcut', 'optional', `${f.hotkey} could not be taken, so the overlay shortcut is off.`, {
          text: 'Another app is using that shortcut. Pick a different one under About me, Quick overlay.',
        })
  );

  if (f.voice && f.voice.available) {
    items.push(item('voice', 'Voice input', 'ok', 'whisper.cpp and a model were found.'));
  } else if (f.voice && f.voice.reason === 'no_model') {
    items.push(item('voice', 'Voice input', 'optional', 'whisper.cpp is installed but no model file was found.', {
      text: `Download ggml-base.en.bin from the whisper.cpp project and put it in this folder:`,
      command: f.modelsDir || null,
    }));
  } else {
    items.push(item('voice', 'Voice input', 'optional', 'Not set up. Voice runs entirely on this computer.', {
      text: 'Install whisper.cpp, then add a model file (see the README):',
      command: 'brew install whisper-cpp',
    }));
  }

  if (!f.ollama) {
    items.push(item('vision', `Window questions (${f.visionModel})`, 'optional', 'Needs Ollama first.', null));
  } else if (f.hasVision) {
    items.push(item('vision', `Window questions (${f.visionModel})`, 'ok', 'The vision model is installed.'));
  } else {
    items.push(item('vision', `Window questions (${f.visionModel})`, 'optional', 'Needed to ask about a window. Not downloaded.', {
      text: 'Download a local vision model:',
      command: `ollama pull ${f.visionModel}`,
    }));
  }

  // macOS asks for these itself, so they only appear there.
  if (f.platform === 'darwin') {
    if (f.screenPermission === 'granted') {
      items.push(item('screen', 'Screen Recording permission', 'ok', 'Allowed.'));
    } else {
      items.push(item('screen', 'Screen Recording permission', 'optional', 'Not allowed yet. Only needed for window questions.', {
        text: 'Open System Settings, Privacy & Security, Screen Recording, turn on CompanionDesk, then restart the app.',
      }));
    }
    if (f.micPermission === 'granted') {
      items.push(item('mic', 'Microphone permission', 'ok', 'Allowed.'));
    } else if (f.micPermission === 'denied' || f.micPermission === 'restricted') {
      items.push(item('mic', 'Microphone permission', 'optional', 'Blocked. Only needed for voice input.', {
        text: 'Open System Settings, Privacy & Security, Microphone, and turn on CompanionDesk.',
      }));
    } else {
      items.push(item('mic', 'Microphone permission', 'optional', 'Not asked yet. macOS asks the first time you click Speak.', null));
    }
  }

  items.sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
  return { ready: items.every((i) => i.status !== 'needed'), items };
}

function safeStatus(systemPreferences, kind) {
  try { return systemPreferences.getMediaAccessStatus(kind); } catch { return 'unknown'; }
}

// deps: { ai, voice, modelsDir, visionModel, systemPreferences, hotkey, hotkeyRegistered, platform }
async function collectHealth(deps) {
  const status = await deps.ai.status();
  const hasVision = status.ollama ? await deps.ai.hasModel(deps.visionModel) : false;
  const mac = deps.platform === 'darwin';
  return {
    ok: true,
    ...buildHealth({
      ollama: Boolean(status.ollama),
      model: status.model,
      modelLoaded: Boolean(status.modelLoaded),
      visionModel: deps.visionModel,
      hasVision,
      voice: deps.voice.status({ modelsDir: deps.modelsDir }),
      modelsDir: deps.modelsDir,
      screenPermission: mac ? safeStatus(deps.systemPreferences, 'screen') : null,
      micPermission: mac ? safeStatus(deps.systemPreferences, 'microphone') : null,
      hotkey: deps.hotkey,
      hotkeyRegistered: Boolean(deps.hotkeyRegistered),
      platform: deps.platform,
    }),
  };
}

module.exports = { buildHealth, collectHealth };
