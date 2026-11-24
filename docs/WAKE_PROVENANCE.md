# Wake word asset provenance (primary-source verification log)

Verified 24 Nov 2026, 18:00-18:55 IST, from primary sources only. Rule:
nothing ships, trains or downloads without an entry here. Training-only
tools are marked as such and never ship in the app.

## Engine framework and code

| asset | role | license (primary source) | verdict |
| --- | --- | --- | --- |
| openWakeWord repo code (dscripa/openWakeWord) | reference implementation, conversion notebook, streaming pipeline design | Apache-2.0 (repo LICENSE + README) | SHIP OK as code; repo active (pushed 2025-12-30), not archived |
| openWakeWord pretrained wake-word classifiers (alexa, hey jarvis, hey mycroft, hey rhasspy, timer, weather, silero_vad) | NOT USED | README License section: ALL included pre-trained models CC BY-NC-SA 4.0 (non-commercial) | REFUSED: not shippable, not used directly or indirectly |
| openWakeWord v0.5.1 release artifact melspectrogram.onnx / embedding_model.onnx | feature extractor candidates | AMBIGUOUS upstream | REFUSED: not shipped (see below) |

The ambiguity, read from the sources on 24 Nov 2026 ~18:45 IST: the README
blanket ("all included pre-trained models are CC BY-NC-SA 4.0") sits next
to a statement that the embedding model is a re-implementation of Google's
Apache-2.0 speech_embedding module. Issues #338, #346, #348 and #357 in
the upstream repo ask exactly this question (commercial redistribution of
the two shared feature files by projects that trained their own
classifiers); ALL FOUR were still open with no maintainer answer. We do
not ship these files and do not train through them.

## The compliant feature-extractor route (ours)

| asset | role | license (primary source) | verdict |
| --- | --- | --- | --- |
| Google speech_embedding TFHub/Kaggle module | pretrained feature-extractor weights | Apache-2.0 (module license page; re-confirmed at conversion time) | TRAIN + SHIP as OUR converted artifact |
| scripts/wake/convert_embedding.py | our conversion (adapted from openWakeWord's own Apache-2.0 notebook, per its license and attribution) | our file, Apache-2.0 header | SHIP OK |
| our converted embedding .onnx | shipped feature extractor | derivative of an Apache-2.0 module, converted by us | SHIP OK with checksum + provenance in the release notes |

Verified DSP parameters (read 24 Nov 2026 ~19:20 IST from Google's module
graph itself, not from the notebook's transcription): 16 kHz audio;
periodic-hann window of 400 samples, hop 160, FFT length 512 (rfft 257
bins), center=False (a 12,400-sample window yields exactly 76 frames);
MAGNITUDE spectrum (abs of the rfft, NOT power); mel filterbank built in
the htk mel domain (1127*log10(1+f/700)) with triangular weights over bin
frequencies and no slaney normalization (tf.signal
.linear_to_mel_weight_matrix style), fmin 60 Hz, fmax 3800 Hz; natural
log of the mel clipped at 1e-10. The embedding model consumes this tensor
DIRECTLY; the /10+2 scaling and 10*log10 belong to openWakeWord's separate
melspectrogram feature, which we do not use. Corrected from an earlier
draft of this file that had power-2 and /10+2 - the numeric checks below
are what settled it. The embedding emits one 96-dim vector per 8 mel
frames (80 ms); the wake head consumes a 16-step embedding window
(1.28 s), matching openWakeWord's get_features(n_feature_frames=16).

## Conversion verification record (24 Nov 2026 ~19:15-19:25 IST)

- scripts/wake/convert_embedding.py output verified against Google's
  module on a deterministic random 12,400-sample input: max absolute
  embedding difference 0.000010. Output: embedding_model.onnx, 1,328,354
  bytes, sha256 d6a0f210d65edd12f1050db78d18c60ca467121681fb5cd4eb43576f4543219b.
- The numpy log-mel in scripts/wake/train_wake_model.py verified against
  the module's own internal log-mel tensor: max abs diff 0.000922, mean
  6.7e-05 on the same test input. This is the canonical DSP the app's
  listener (wake-mel.js) must reproduce; train-time and app-time features
  must stay identical.
- The module's architecture (read from its graph): 20 convolutions and 19
  batchnorms; the final two stages carry four convolutions between the
  last two max-pools, not two as the notebook transcription assumed; the
  converted re-implementation now mirrors the module exactly.

## Training data and tools

| asset | role | license (primary source) | verdict |
| --- | --- | --- | --- |
| rhasspy/piper-sample-generator | synthetic positive/negative sample generator | MIT (repo license field), active (pushed 2026-03-12) | TRAINING-ONLY tool; verify voice models below |
Verified per voice from the voice's own MODEL_CARD in rhasspy/piper-voices, read 24 Nov 2026 19:00 IST (primary sources, per-voice chain followed):
- `en_US-amy-medium` VERIFIED: model card defers to the mimic3-voices repo (github.com/MycroftAI/mimic3-voices), whose LICENSE is CC BY-SA 4.0. Permissive with attribution; used with attribution recorded here. Quality medium, single speaker (Hi-Fi TTS reader 92, Cori Samuel finetune).
- en_US-ryan-high REFUSED: model card dataset license CC BY-NC-SA 4.0 (non-commercial).
- en_US-lessac-medium REFUSED: Blizzard 2013 license is a manual per-person license (Voice Factory / Lessac Technologies), not permissive redistribution.
- en_GB-northern_english_female-medium EXCLUDED: no MODEL_CARD at its HF path; unverifiable, so unused.
| Piper voice models | TTS voices for synthetic speech | en_US-amy-medium only (CC BY-SA 4.0 chain above); every other candidate refused at the card | SHIP/TRAIN OK with attribution |
| synthetic noise (numpy white/pink) | negative + augmentation | generated by our code, no third-party data | SHIP/TRAIN OK |
| PyTorch (CPU), numpy, librosa, onnx, onnxruntime | training/export toolchain | BSD/Apache-2.0/MIT respectively | TRAINING-ONLY tools |
| piper-tts 1.3.x (pip) + scipy | synthetic speech generation (training only) | MIT (piper), BSD (scipy) | TRAINING-ONLY tools; voice model chain below |
| onnxruntime-web 1.31.1 | shipped inference runtime (listener page) | MIT (package LICENSE) | SHIP OK; pinned in package.json, vendored by scripts/wake/vendor-ort.sh |
| our trained wake classifier .onnx | the wake model | OURS: trained only on synthetic audio generated by us with permissive voices; no third-party speech dataset | SHIP OK with checksum + training-data statement |

Deliberate exclusions and why:
- ACAV100M-derived negative features (upstream's training set) are
  CC BY-NC-SA 4.0; not used.
- Free Music Archive audio and MIT impulse-response sets are usable but
  add provenance surface; fully synthetic negatives keep the chain clean
  and are sufficient for v1 (documented limitation: real-world noise
  robustness is validated only on-device later).
- Picovoice Porcupine: proprietary, free tier non-commercial only, online
  AccessKey validation conflicts with local-first (decision 24 Nov 2026).
  Rejected; never evaluated further.

## Nothing ships unverified

Before any release the shipped assets (converted embedding model, trained
classifier, onnxruntime-web version) get checksums and license notes in
the release manifest. If a verification fails, the wake word stays
disabled with the named reason; nothing is substituted silently.
