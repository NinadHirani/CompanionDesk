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

## Files

| file | role |
| --- | --- |
| src/wake-word.js | Pure policy: phrase resolution, session state machine |
| src/wake-engine.js | Main-process gate chain over the session machine |
| renderer/wake-listener.html/.js | Hidden always-listening page (slice 5) |
| renderer/wake-mel.js | Streaming log-mel DSP in JS (slice 5) |
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
