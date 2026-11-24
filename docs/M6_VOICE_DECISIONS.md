# M6 voice decisions - what needs Ninad's call

Status: PROPOSAL, written 24 Nov 2026. Nothing here is decided or
implemented beyond M6 slice 1 (the groundwork now on main). Voice is off
until Ninad enables it in settings; nothing listens, nothing downloads.

## 1. Local speech-to-text (the transcriber behind Speak)

The existing pipeline already runs entirely on-device: audio stays in the
overlay page, goes to a local whisper.cpp binary over a fixed-path
allowlist, and the temp WAV is deleted after each run. The decision is only
WHICH model file is allowed, and whether multilingual is wanted.

| Option | Licence | Model size (approx) | Fit on 8 GB Air M1 / OnePlus 12R | Notes |
|---|---|---|---|---|
| whisper.cpp tiny.en (smallest currently supported) | MIT (whisper.cpp code + OpenAI Whisper weights) | ~75 MiB | trivial | Fast, weakest accuracy; already in the allowlist |
| whisper.cpp base.en (current default) | MIT | ~142 MiB | fine | The README-recommended default |
| whisper.cpp small.en | MIT | ~466 MiB | fine on M1; usable on 12R | Best accuracy/size balance for English |
| whisper.cpp multilingual (tiny/base/small, no .en) | MIT | similar, slightly larger | same | Needed only for non-English input; the language setting is already plumbed |
| Vosk streaming | Apache-2.0 (verify per model) | ~40-50 MiB en-us | very light | Real-time streaming but clearly weaker accuracy than whisper |
| sherpa-onnx streaming zipformer | Apache-2.0 code; VERIFY each model's training-data terms (some corpora are non-commercial research only) | ~50-200 MiB | fine | Streaming; personal use is unaffected by corpus terms, redistribution is not |

Recommendation to react to: keep whisper.cpp, add small.en as the optional
higher-quality model, and enable a multilingual twin of whatever size he
picks only if he wants non-English input. No download happens until he
names the model; the app finds model files the user places in the models
folder. Size figures are the commonly published approximations; verify the
exact file size on the download page before committing disk.

## 2. Wake word

Roadmap rule: wake word only after the licensing decision, behind a
separate auto-listening toggle, off by default, visible mic state, immediate
stop. What the licensing actually looks like (checked 24 Nov 2026):

- openWakeWord: the CODE is Apache-2.0, but its README says all included
  pre-trained models are CC BY-NC-SA 4.0 (non-commercial), and the licence
  of the shared feature models is unclear. Fine for a private hobby build;
  a problem for anything distributed.
- Picovoice Porcupine: proprietary. A free personal tier exists, but
  commercial use needs a paid agreement with unpublished pricing; the terms
  also restrict modification and ML training.
- Android platform SpeechRecognizer (on-device on recent Android): no
  third-party licence at all, but it is a platform service, not a
  portable model, and behaviour varies by device.

Recommendation to react to: skip wake word for now (push-to-talk covers
the real use case, and the strongest open option is non-commercial anyway);
revisit only if Ninad says auto-listening matters to him.

## 3. Test checklist (needs his device time; nothing here can be self-certified)

MacBook Air M1 (macOS):
1. Fresh install: no microphone permission prompt at startup.
2. Voice toggle off (default): Speak does nothing but explain where to turn it on.
3. Enable in About > Voice input: first Speak press triggers the macOS mic
   prompt once; deny, then allow, both paths behave.
4. Speak a sentence, check the transcript lands in the overlay input.
5. Escape mid-recording and mid-transcription: mic releases, no stray
   notification, no crash; the temp WAV is gone (temp dirs clean).
6. Record past the cap: it auto-stops at 30 s.
7. Whisper missing / model missing: the health page and the overlay both
   say exactly what to install.

OnePlus 12R (Android build):
1. RECORD_AUDIO runtime permission appears only on first Speak press.
2. Foreground-service mic rules: verify the capture runs inside a service
   with the microphone type per current Android docs (RISK_REGISTER flags
   this for verification before M6 lands on Android).
3. Same enable-gate, cap, cancel and no-retention checks as desktop.
4. Backgrounding mid-recording: capture stops, nothing keeps the mic.

Sources checked 24 Nov 2026: whisper.cpp README (github.com/ggml-org/whisper.cpp, MIT);
wake-word licensing survey in kernel-ai-assistant issue #2021 (openWakeWord model
licence CC BY-NC-SA 4.0, Porcupine commercial terms unpublished); outspoken.cloud
wake-word comparison (Oct 2026). Item sizes and Vosk details are approximations
to re-verify at download time.
