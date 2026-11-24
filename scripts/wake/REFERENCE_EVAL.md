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
