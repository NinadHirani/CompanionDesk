# Reference held-out evaluation: "Hey CompanionDesk"

Record of the first end-to-end training run on the full synthetic corpus
(3,100 clips: 800 positives, 2,300 negatives; voice en_US-amy-medium,
verified in docs/WAKE_PROVENANCE.md), 24 Nov 2026. This is a RECORD, not a
shipped artifact: the model is per-name and is regenerated locally with
`bash scripts/wake/train_for_name.sh --name "<name>"`. Real-microphone
performance is unmeasured until physical device testing.

- held-out positive windows: 169
- held-out negative windows: 617
- threshold 0.3: false accept 1.30%, false reject 0.0%
- threshold 0.5: false accept 0.97%, false reject 0.0%  (shipped default)
- threshold 0.7: false accept 0.65%, false reject 0.59%
- model sha256: 56e58e78f2e629cc5f0aaee978c014319ef2986668eaa0a6f3d4135329996021
- data: fully synthetic (scripts/wake/generate_training_data.py); no real
  recordings, no third-party pretrained wake model.

Note: an earlier same-day run trained on ZERO positive windows (a
phrase-localisation bug that squared the log-mel floor, putting silence above
speech) and its report was meaningless; the trainer now refuses to write a
model with zero held-out positives.

## Reproduction (24 Nov 2026, 20:52 IST)

Re-ran the evaluation only (no retraining) with `scripts/wake/repro_eval.py`
from the same corpus directory: rebuilt the deterministic held-out split
(seed 20261124, 10% hold-out) from the manifest, scored all 786 held-out
windows with the saved `wake_model.onnx` (sha256
`56e58e78f2e629cc5f0aaee978c014319ef2986668eaa0a6f3d4135329996021`), and
recomputed the sweep. Every number matched the recorded report exactly:
169 positive / 617 negative windows; FA 1.30% / FR 0.00% at 0.3, FA
0.97% / FR 0.00% at 0.5, FA 0.65% / FR 0.59% at 0.7. The only differences
in the file are the report's `data` and `real_world_status` note fields,
which are metadata, not metrics.
