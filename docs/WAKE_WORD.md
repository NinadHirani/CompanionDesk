# Wake word: design, provenance, and limitations

Ninad's decision of 24 Nov 2026: the wake phrase is exactly
"Hey + <companion name configured in Settings>" (e.g. "Hey Nova" with the
companion name Nova), and the engine route is local self-training: our own
model, trained on fully synthetic speech, with every asset's license
verified from primary sources before use. Nothing non-commercial or
proprietary ships, nothing is silently substituted, and nothing is
downloaded without an approved, documented provenance.

## Boundaries (all fail closed)

- **Separate gate, off by default.** Wake listening has its own setting,
  `wake_enabled`, default false, separate from push-to-talk
  `voice_enabled`. Creating the engine listens to nothing; `start` refuses
  any call that is not an explicit user action from the About card, and the
  OS microphone permission is requested only on that first explicit start,
  never at app startup.
- **Exact model gate.** Detection needs a trained model file for the EXACT
  phrase built from the CURRENT companion name
  (`models/wake/<modelId>.onnx`, modelId "hey-nova" for Nova). A missing
  model reports `wake_model_missing`; a companion name that no longer
  matches any trained model reports `phrase_mismatch` until the model is
  retrained (scripts/wake). No model is ever bundled silently, reused for a
  different name, or substituted.
- **The false-trigger dial.** `wake_threshold` is bounded to [0.1, 0.9];
  anything else fails closed to 0.5 so a corrupted setting can never widen
  a gate.
- **Local-only by construction.** The listener has no network route. The
  engine API accepts no audio at all: only bounded detection scores in
  [0, 1], one at a time. Nothing is recorded, stored or uploaded; audio
  exists only inside the listening page's memory while it is sampling.
- **Indicator and controls.** `micOpen` is true only while the listener is
  actively sampling; that is the indicator contract the UI renders. Pause
  and Stop close the microphone immediately; Stop is revocation. After a
  fired query, a caller-enforced cooldown (2 s) prevents retrigger loops
  before listening resumes.
- **No silent fallback.** If the local runtime pieces are missing the gate
  reports `wake_engine_missing`. There is no cloud fallback and no
  substitution with a different engine.

## Dynamic names: what is a model and what is a listener

- **A trained model is per-name.** The phrase is built live from the
  current `assistant_name`, and the engine only loads
  `models/wake/<modelId>.onnx` for THAT exact phrase. Changing the
  companion name in Settings makes the old model invalid: start refuses
  with `phrase_mismatch` until `scripts/wake/train_for_name.sh --name
  "<new name>"` produces the new model. Nothing is re-used or substituted
  silently; an invalid or over-long name is refused before any model id
  exists. That retrain path is local, free, and uses the same
  license-verified synthetic pipeline (docs/WAKE_PROVENANCE.md).
- **A trained model is not a working listener.** The model file only
  exists; the streaming listener (hidden page, onnxruntime-web, mic
  capture, engine gates) is a separate runtime slice, and `engineReady`
  checks its pieces on disk. Both must be present before a start can open
  a microphone.
- **Detection quality is reported, not claimed.** The trainer writes a
  held-out evaluation report (false accept / false reject rates at
  thresholds 0.3/0.5/0.7) next to each model, and refuses to write a model
  whose held-out positives are empty, so a meaningless report cannot ship.
  The numbers are computed on held-out SYNTHETIC clips from the same
  generator, which is exactly the stated limitation: real-microphone
  performance is unmeasured until physical device testing. The first full
  run for the default name (24 Nov 2026, 3,100 clips) is recorded in
  scripts/wake/REFERENCE_EVAL.md: false accept 0.97% / false reject 0.0%
  at the 0.5 default, 0.65% / 0.59% at 0.7. Wake stays default-off
  (`wake_enabled` false) until physical validation.
- **The shipped default artifact.** The reference model Ninad trains
  first is for the default companion name ("Hey CompanionDesk"). It is
  the default, not a claim: any other name needs its own model via the
  script, and the engine says so honestly when one is missing.

## Files

| file | role |
| --- | --- |
| src/wake-word.js | Pure policy: phrase resolution, session state machine |
| src/wake-engine.js | Main-process gate chain over the session machine |
| renderer/wake-listener.html/.js | Hidden always-listening page (slice 5) |
| renderer/wake-mel.js | Streaming log-mel DSP in JS (slice 5), pinned to the training reference by a fixture test |
| renderer/wake-eval.js | Pure evaluation policy: 196-frame window, 16-step embedding head window, 80 ms cadence |
| renderer/vendor/wake-ort/ | Pinned onnxruntime-web runtime files (MIT), vendored by scripts/wake/vendor-ort.sh |
| src/wake-listener-preload.js | The listener window's own minimal IPC surface (start/stop/mic in, scores out) |
| scripts/wake/ | Training pipeline: conversion, data, training, export |
| docs/WAKE_PROVENANCE.md | Primary-source license verification for every asset |

## Licensing provenance (verified from primary sources)

The upstream situation, read 24 Nov 2026 from the primary sources:

- openWakeWord (github.com/dscripka/openWakeWord) is Apache-2.0 CODE, but
  its README licenses ALL included pre-trained MODELS under CC BY-NC-SA
  4.0 "due to training data with unknown or restrictive licensing". The
  pretrained wake-word classifiers are therefore not shippable and are not
  used, directly or indirectly.
- The status of the two SHARED feature-extractor artifacts the project
  ships (melspectrogram.onnx, embedding_model.onnx) is UNSETTLED upstream:
  issues #338, #346, #348 and #357 ask exactly this question and the
  maintainer has not answered. We treat the exact files as unlicensed for
  our purposes and DO NOT ship them.
- The airtight route the README itself describes, and the one we follow:
  Google's `speech_embedding` TFHub module is Apache-2.0. openWakeWord's
  own Apache-2.0 notebook (notebooks/converting_google_speech_embedding_model.ipynb)
  documents the exact re-implementation and the fixed DSP parameters
  (16 kHz, win 400 / hop 160 / nfft 512, 32 mels, fmin 60, fmax 3800,
  log10 + 2 scaling). Our scripts/wake/convert_embedding.py performs that
  conversion OURSELVES from Google's Apache-2.0 module, so the feature
  extractor we ship is our own Apache-2.0-derived artifact with a
  documented chain of custody, not openWakeWord's ambiguous file.
- The wake-word CLASSIFIER is trained entirely by us on fully synthetic
  audio (text-to-speech + synthetic noise), so no third-party training
  dataset with unknown licensing is involved at all. The result is our own
  model.
- Every code, model, voice-data and training asset is individually
  verified in docs/WAKE_PROVENANCE.md before use. Tools used only to
  TRAIN (PyTorch, Piper, and so on) never ship in the app.

## Honest limitations

- The trained model is validated on synthetic held-out data (same
  distribution as training). Real-world false-accept and false-reject
  rates on actual microphones are UNMEASURED until physical device
  testing; the threshold dial is the user-facing mitigation.
- The phrase model is English-audio; a companion name is spoken once per
  activation and retraining is local and free.
- Speaker diversity in training is bounded by the set of permissively
  licensed TTS voices verified in the provenance doc.
