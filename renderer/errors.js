'use strict';

// One place for user-facing error wording, shared by the dashboard and the overlay.
(function () {
  const MESSAGES = {
    window_gone: 'That window was closed. Click Screen and pick again.',
  screen_permission: 'Allow screen recording for CompanionDesk in your system privacy settings, then restart the app.',
  capture_failed: 'I could not capture the screen.',
  vision_failed: 'The vision model did not answer. Check that Ollama is running.',
  voice_unavailable: 'Voice needs whisper.cpp set up. See the README.',
  no_speech: 'I did not catch that. Try again.',
  transcribe_failed: 'Voice transcription failed. Try again.',
  voice_disabled: 'Voice is off. Turn it on in About > Voice input.',
  cancelled: 'Voice input cancelled.',
  too_long: 'That recording was too long. Keep it under 15 seconds.',
  mic_blocked: 'Microphone access was blocked. Allow it in your system privacy settings.',
  mic_missing: 'No microphone was found.',
  invalid_hotkey: 'That is not a valid shortcut. Example: CommandOrControl+Shift+Space.',
    needs_modifier: 'Add a modifier such as Ctrl, Cmd or Alt.',
    reserved_hotkey: 'Most apps already use that shortcut. Pick another.',
    hotkey_unavailable: 'Another app already uses that shortcut.',
    empty_prompt: 'Type a question first.',
    empty: 'Type something first.',
    empty_title: 'Add a short description.',
    invalid_date: 'That is not a real date.',
    date_in_past: 'That date has already passed.',
    duplicate: 'You already have that one.',
    invalid_answer: 'That does not look right. Try again, or skip.',
    invalid_settings: 'Some of those settings were not valid.',
    bad_request: 'That did not go through. Try again.',
    invalid_score: 'Enter a number from 0 to 100.',
    no_events: 'No events were found in that file.',
    file_too_large: 'That file is too large (5 MB is the limit).',
    read_failed: 'That file could not be read.',
    desktop_only: 'That one needs the desktop app; the rest works here.',
    unsupported: 'Cloud AI setup is not available in this build.',
    invalid_key_format: 'That does not look like a Gemini API key. Keys start with AIza.',
    missing_key: 'Paste a key first.',
    encryption_unavailable: 'This computer cannot encrypt the key securely (no OS credential vault; on Linux a real secret service such as GNOME Keyring or KWallet is required), so nothing was saved and the cloud stays off.',
    key_file_write_failed: 'The key file could not be written. Check the app folder permissions.',
    key_file_remove_failed: 'The key file could not be removed. Check the app folder permissions.',
    gemini_network_error: 'Could not reach Google to check the key. Check your connection and try again.',
  };

  function friendlyError(code, detail) {
    const c = String(code || '');
    if (c === 'screen_blocked') return `A window titled "${detail}" may show a password or sign-in form. Close or minimize it, then try again.`;
    if (c === 'vision_unavailable') return `Screen questions need a local vision model. Run: ollama pull ${detail}`;
    if (MESSAGES[c]) return MESSAGES[c];
    if (/^gemini_http_40[13]/.test(c)) return 'Google rejected the key. Make sure it is a valid Gemini API key with the API enabled.';
    if (/^gemini_http_429/.test(c)) return 'Google answered "too many requests". Your key plan is rate limited; try again later.';
    if (/fetch failed|ECONNREFUSED|ollama|NetworkError|no_cloud_key/i.test(c)) {
      return 'I could not reach the local model. Start Ollama, then try again.';
    }
    return `Something went wrong (${c || 'unknown'}).`;
  }

  window.friendlyError = friendlyError;
})();
