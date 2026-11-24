# Wake word training pipeline

The user-approved route (24 Nov 2026): our own wake model for the phrase
"Hey <companion name>", trained entirely on synthetic speech, with every
asset's license verified from primary sources (docs/WAKE_PROVENANCE.md).
Nothing here ships in the app except the final artifacts the pipeline
produces (the converted feature extractor and the trained classifier), and
nothing is downloaded that is not listed there.

Order of operations:

1. `python3 convert_embedding.py` - convert Google's Apache-2.0
   speech_embedding module into the ONNX feature extractor the app ships.
   Adapted from openWakeWord's own Apache-2.0 conversion notebook
   (attribution in the file header). Verifies its output numerically
   against a numpy re-implementation before writing the file.
2. `python3 generate_training_data.py --voice ... --phrase "Hey Nova"` -
   generate positive and negative clips. Voices must be verified
   per-voice (license recorded in WAKE_PROVENANCE.md) before use.
3. `python3 train_wake_model.py` - train the classifier head on the
   embedding features and export the ONNX the app loads, with a held-out
   synthetic evaluation report. The head ends in a sigmoid, so the ONNX
   emits a probability in [0, 1] directly.
4. `bash scripts/wake/vendor-ort.sh` - copy the pinned onnxruntime-web
   runtime files into renderer/vendor/wake-ort/ for the listener page
   (MIT, version pinned in package.json). The wake engine reports
   wake_engine_missing until this has run.
5. Place the artifacts for the user (never fetched at runtime):
   models/wake/embedding.onnx (step 1's output) and
   models/wake/<modelId>.onnx (step 3's output) under the app's models
   directory. The app reads `<userData>/models/wake` at runtime (on macOS:
   `~/Library/Application Support/CompanionDesk/models/wake`), so when
   training for a real install pass that directory to the tooling, e.g.
   `bash scripts/wake/train_for_name.sh --name "Nova" --models-dir
   "$HOME/Library/Application Support/CompanionDesk/models/wake"`.
   directory.

Every script is explicitly offline-of-app: the app never downloads
anything; the model files are produced here and placed under
models/wake/<modelId>.onnx by the user (or a release process Ninad
approves) - never fetched at runtime.
