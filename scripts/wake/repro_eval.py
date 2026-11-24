#!/usr/bin/env python3
# Reproduce the recorded held-out metrics from the SAVED model + corpus,
# without retraining. Rebuilds the deterministic held-out split (the same
# seed and ratios as train_wake_model.py), scores it with the saved
# wake_model.onnx, and prints the threshold sweep. Compare its output with
# the recorded wake_report.json by hand: the data/real_world_status notes
# are report metadata, not metrics.
#
# Training-only tool: needs the training venv (torch, onnxruntime, numpy,
# soundfile) and the corpus layout train_wake_model.py wrote:
#   /tmp/waketrain$ python3 /path/to/repo/scripts/wake/repro_eval.py
# Usage: python3 repro_eval.py            # data/, embedding_model.onnx,
#         # wake_model.onnx and wake_report.json in the current directory
import sys, json, numpy as np, onnxruntime as ort
sys.path.insert(0, '/workspace/cd-dist/scripts/wake')
from train_wake_model import load_clip, logmel, phrase_span, extract_windows

manifest = json.load(open('data/manifest.json'))
emb = ort.InferenceSession('embedding_model.onnx', providers=['CPUExecutionProvider'])
pos, neg = [], []
for wav in manifest['positives']:
    audio = load_clip(wav); mels = logmel(audio)
    pos.extend(extract_windows(audio, emb, span=phrase_span(mels)))
for wav in manifest['negatives']:
    neg.extend(extract_windows(load_clip(wav), emb))
rng = np.random.default_rng(20261124)
rng.shuffle(pos); rng.shuffle(neg)
pos, neg = pos[:40000], neg[:80000]
hold_p, hold_n = int(len(pos)*0.1), int(len(neg)*0.1)
Xh = np.array(pos[:hold_p] + neg[:hold_n], dtype=np.float32)
yh = np.concatenate([np.ones(hold_p), np.zeros(hold_n)]).astype(np.float32)
sess = ort.InferenceSession('wake_model.onnx', providers=['CPUExecutionProvider'])
scores = sess.run(None, {'input': Xh})[0].ravel()
rep = {'held_out_positive_windows': int(hold_p), 'held_out_negative_windows': int(hold_n), 'thresholds': {}}
for thr in [0.3, 0.5, 0.7]:
    n, p = scores[yh == 0], scores[yh == 1]
    rep['thresholds'][str(thr)] = {'false_accept_rate': float((n >= thr).mean()),
                                   'false_reject_rate': float((p < thr).mean())}
orig = json.load(open('wake_report.json'))
print(json.dumps(rep, indent=2))
print('MATCHES_ORIGINAL:', rep == orig)
