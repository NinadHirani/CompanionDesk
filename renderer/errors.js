'use strict';

// One place for user-facing error wording, shared by the dashboard and the overlay.
(function () {
  const MESSAGES = {
    window_gone: 'That window was closed. Click Screen and pick again.',
  screen_windows_failed: 'The window list could not be read. Click Screen and try again.',
  voice_status_failed: 'Voice could not be checked. Try again in a moment.',
  screen_permission: 'Allow screen recording for CompanionDesk in your system privacy settings, then restart the app.',
  capture_failed: 'I could not capture the screen.',
  vision_failed: 'The vision model did not answer. Check that Ollama is running.',
  voice_unavailable: 'Voice needs whisper.cpp set up. See the README.',
  no_speech: 'I did not catch that. Try again.',
  transcribe_failed: 'Voice transcription failed. Try again.',
  transcribe_empty: 'Nothing came through. Try speaking again.',
  voice_disabled: 'Voice is off. Turn it on in About > Voice input.',
  wake_disabled: 'Wake word is off. Turn it on in About > Wake word.',
  no_companion_name: 'Set a companion name first. Wake listening needs one.',
  name_too_long: 'That companion name is too long for a wake phrase.',
  invalid_name: 'That companion name uses characters a spoken wake phrase cannot carry.',
  wake_model_missing: 'No wake model is trained for the current companion name yet. See docs/WAKE_WORD.md.',
  phrase_mismatch: 'The companion name changed, so the trained wake model no longer matches. Retrain it or change the name back.',
  wake_engine_missing: 'The wake listening runtime is not installed on this build yet.',
  wake_mic_denied: 'The microphone permission was refused, so wake listening cannot run. Allow the microphone in your system settings, then start again.',
  wake_mic_missing: 'No microphone is available on this computer, so wake listening cannot run.',
  wake_platform_unsupported: 'Wake listening runs in the CompanionDesk desktop app only; this web or Android build cannot host it.',
  already_listening: 'Wake listening is already active.',
  not_listening: 'Wake listening is not active right now.',
  not_suspended: 'No wake query is in progress.',
  not_paused: 'Wake listening is not paused.',
  cooldown_active: 'Wake listening is in its brief cooldown after the last answer.',
  cancelled: 'Voice input cancelled.',
  voice_output_disabled: 'Reading aloud is off. Turn it on in About > Voice input.',
  user_action_required: 'Press Read aloud to hear the answer.',
  already_speaking: 'Already reading aloud.',
  empty_text: 'Nothing to read aloud.',
  text_too_long: 'That answer is too long to read aloud in one go.',
  speech_interrupted: 'Reading aloud was interrupted. Press Read aloud to try again.',
  synthesis_failed: 'The built-in voice could not read that. Try again.',
  synthesis_unavailable: 'The built-in voice is unavailable right now.',
  audio_busy: 'The system audio is busy. Try again in a moment.',
  audio_hardware: 'No working audio output was found.',
  synthesis_not_allowed: 'The system blocked speech playback.',
  no_synthesis_api: 'This system has no built-in speech voice, so answers cannot be read aloud.',
  nothing_speaking: 'Nothing is being read aloud.',
  too_long: 'That recording was too long. Keep it under 15 seconds.',
  mic_blocked: 'Microphone access was blocked. Allow it in your system privacy settings.',
  mic_missing: 'No microphone was found.',
  title_unavailable: 'That window\'s title could not be read, so it cannot be checked for private content. Pick a different window.',
  not_background_mode: 'Background cadence settings apply only when screen observation is in background mode.',
  not_granted: 'That app has not been granted access yet. Grant it in About > Device access.',
  not_enabled: 'That capability is not enabled yet. Enable it in About > Device access.',
  already_active: 'That is already running. Stop it first.',
  nothing_to_cancel: 'There is nothing in progress to cancel.',
  // Agent scheduler refusals (schedules panel, M5 slice 2)
  title_invalid: 'Add a title of 120 characters or fewer.',
  scope_invalid: 'Pick a valid scope for the schedule.',
  due_at_invalid: 'Pick a date and time for the schedule.',
  due_at_past: 'That time is already past. Pick a future one.',
  book_full: 'The schedule book is full. Remove or cancel one first.',
  notes_invalid: 'That note is too long (500 characters is the limit).',
  schedule_unknown: 'That schedule no longer exists.',
  schedule_cancelled: 'That schedule was already cancelled.',
  already_fired: 'That schedule already ran.',
  nothing_to_update: 'Nothing to change. Edit the title or the time.',
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
    category_unknown: "Pick one of this course's grading categories, or leave it not counted.",
    course_name_empty: 'Add a course name.',
    invalid_credit_hours: 'Credit hours should be a number, like 4.',
    not_found: 'That one is already gone. Refresh and try again.',
    not_manual: 'Only deadlines you added by hand can be edited here. Change the rest by importing an updated syllabus.',
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
    ask_failed: 'Something went wrong while answering. Your question is back in the box, so try again.',
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
