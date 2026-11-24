# M6 voice decisions

## Decided (24 Nov 2026, Ninad)

- STT: whisper.cpp `small.en` is the initial model. The app must support adding and selecting multilingual models later, Hindi included. Implemented as a fixed allowlist of the six small/base/tiny English/multilingual ggml names; `voice_model` setting selects inside it (default `small.en`); the renderer can never point at an arbitrary path. A user-set `WHISPER_MODEL` env var remains an explicit override, as before.
- Wake word: REQUIRED, not optional. It must work. No wake-word engine or model may ship until its licensing is verified from primary sources; nothing non-commercial or proprietary is silently chosen; nothing fake or questionable is bundled.

## Wake-word research (primary sources, 24 Nov 2026)

| Engine / path | License (code / included models) | Ships in CompanionDesk? |
| --- | --- | --- |
| openWakeWord, included pretrained models | Apache-2.0 / **CC BY-NC-SA 4.0** | **No.** Non-commercial models cannot ship in an app Ninad may commercialize. |
| openWakeWord, custom model trained on 100% synthetic speech over the frozen Apache-2.0 shared feature extractor | Own output asset; feature extractor Apache-2.0; third-party training centre (openwakeword.com/train) claims Apache-2.0-licensed outputs, sub-100 KB, on-device | **Recommended path**, with conditions below |
| Picovoice Porcupine | Proprietary SDK; free tier is personal non-commercial only; Foundation tier US$6,000/yr (eligibility-gated); AccessKey validated online at runtime | **No.** Terms conflict with local-first (online key validation), non-commercial free tier, and silent proprietary licensing is excluded. |
| microWakeWord | ESP32-S3-focused engine | Not applicable to M1 / OnePlus 12R app builds. |

Conditions on the custom-training path, to verify before any model ships:

1. Train our own model for a chosen wake phrase on fully synthetic speech, the same way the openWakeWord project made its own models, so the model is our asset, not their non-commercial one.
2. Every dataset piece (wake utterances, background speech, false-positive noise) must carry permissive provenance we can document and redistribute.
3. Verify the third-party training centre's actual terms and data handling, or run the training ourselves (openWakeWord's pipeline is open source; the project documents the process at openwakeword.com/train).
4. Confirm runtime behavior on both targets: small ONNX models run locally on Apple M1 and Android via onnxruntime; frame-based scoring, adjustable threshold for false-trigger control.

Design requirements for wake word (unchanged): explicit opt-in, OS microphone permission requested only on first use after a user action, visible listening indicator, local-only keyword detection, no raw audio retention or upload, pause/stop controls, adjustable false-trigger threshold.

Until a model is trained and verified, wake word stays disabled in the app; voice remains push-to-talk through the chosen STT model. This is deliberate, not a skip: wake word is a required feature and the search for a compliant path continues.

## Not yet decided

- The wake phrase itself.
- Whether to self-train or use a third-party training service (verify terms first).
