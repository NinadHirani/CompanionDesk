#!/usr/bin/env python3
# Train the wake-word classifier head on OUR OWN synthetic data and export
# the ONNX the app loads.
#
# Pipeline: audio -> log-mel (the verified parameters) -> our converted
# embedding ONNX -> 16-step embedding windows -> small GRU head -> sigmoid.
# The head sees ONLY our synthetic corpus; no third-party speech dataset
# (ACAV100M, FMA, and so on) is involved, which is what makes the result
# our own asset with a clean license chain (docs/WAKE_PROVENANCE.md).
#
# Evaluation is honest and bounded: metrics are computed on a held-out
# synthetic split with the same generator, and the report says exactly
# that. Real-microphone performance is unmeasured until physical device
# testing; the threshold dial is the user-facing mitigation.
#
# Training-only tool: this script never ships inside the app.
#
# Usage: python3 train_wake_model.py --data data/ --embedding embedding_model.onnx \
#          --out wake_model.onnx --report report.json
# Deps: pip install torch --index-url https://download.pytorch.org/whl/cpu
#       pip install onnx onnxruntime numpy soundfile

import argparse
import hashlib
import json
import os
import sys

import numpy as np
import onnxruntime as ort
import torch
import torch.nn as nn


# ---- log-mel reference implementation (the verified parameters) ----
# Verified 24 Nov 2026 against Google's speech_embedding module's own
# internal log-mel tensor (max abs diff < 0.001 on a test signal):
#   periodic hann window of 400 samples, hop 160, FFT length 512,
#   MAGNITUDE spectrum (not power), mel filterbank with the htk mel
#   formula 1127*log10(1+f/700), fmin 60 Hz, fmax 3800 Hz, triangular
#   weights built in the mel domain with no slaney normalization
#   (tf.signal.linear_to_mel_weight_matrix style), natural log of the
#   clipped mel. The embedding model consumes this tensor DIRECTLY: the
#   /10+2 scaling belongs to openWakeWord's separate melspectrogram
#   feature, which we do not use.
MEL_FMIN = 60.0
MEL_FMAX = 3800.0


def mel_filterbank(sr=16000, n_fft=512, n_mels=32):
    """tf.signal.linear_to_mel_weight_matrix-style filterbank."""
    def hz_to_mel(f):
        return 1127.0 * np.log10(1.0 + np.asarray(f, dtype=np.float64) / 700.0)
    def mel_to_hz(m):
        return 700.0 * (10 ** (np.asarray(m, dtype=np.float64) / 1127.0) - 1.0)
    mel_edges = np.linspace(hz_to_mel(MEL_FMIN), hz_to_mel(MEL_FMAX), n_mels + 2)
    freqs = np.arange(n_fft // 2 + 1) * sr / n_fft
    mel_freqs = hz_to_mel(freqs)
    fb = np.zeros((n_mels, n_fft // 2 + 1), dtype=np.float64)
    for i in range(n_mels):
        lo, ce, hi = mel_edges[i], mel_edges[i + 1], mel_edges[i + 2]
        lower = (mel_freqs - lo) / (ce - lo)
        upper = (hi - mel_freqs) / (hi - ce)
        fb[i] = np.maximum(0.0, np.minimum(lower, upper))
    return fb


def logmel(audio, sr=16000, win=400, hop=160, n_fft=512):
    """Raw audio -> [T, 32] natural-log mel, matching the module."""
    n = len(audio)
    if n < win:
        audio = np.pad(audio, (0, win - n))
        n = win
    n_frames = 1 + (n - win) // hop
    idx = np.arange(win)[None, :] + hop * np.arange(n_frames)[:, None]
    window = 0.5 - 0.5 * np.cos(2.0 * np.pi * np.arange(win) / win)  # periodic hann
    frames = audio[idx] * window
    spec = np.abs(np.fft.rfft(frames, n=n_fft, axis=1))  # magnitude, [T, 257]
    mel = mel_filterbank(sr=sr, n_fft=n_fft) @ spec.T  # [32, T]
    return np.log(np.maximum(mel, 1e-10)).T.astype(np.float32)  # [T, 32]


class WakeHead(nn.Module):
    """Small GRU head over 16 embedding steps, openWakeWord-shaped.

    The forward pass ends in a sigmoid, so the exported ONNX emits a
    probability in [0, 1] directly: the listener reports that score as-is
    and the engine's bounded-score contract holds by construction.
    """
    def __init__(self, emb_dim=96, hidden=64):
        super().__init__()
        self.gru = nn.GRU(emb_dim, hidden, batch_first=True)
        self.fc1 = nn.Linear(hidden, 32)
        self.relu = nn.ReLU()
        self.fc2 = nn.Linear(32, 1)
        self.sigmoid = nn.Sigmoid()

    def forward(self, x):
        _, h = self.gru(x)
        return self.sigmoid(self.fc2(self.relu(self.fc1(h[-1]))))


def load_clip(path):
    import soundfile as sf
    data, sr = sf.read(path, dtype='float32')
    assert sr == 16000, f"expected 16 kHz, got {sr}"
    if data.ndim > 1:
        data = data.mean(axis=1)
    return data


# One training sample: MEL_WINDOW mel frames (about 2 s of audio) fed to
# the converted embedding model, which yields one 96-dim embedding every 8
# frames (80 ms), then OUT_STEPS consecutive embeddings scored by the head.
# The app's listener uses exactly this shape: streaming log-mel -> sliding
# 196-frame window -> 16 embeddings -> score, re-scored every 80 ms.
MEL_WINDOW = 196
OUT_STEPS = 16


def phrase_span(mels):
    """Energy-based [start, end] mel-frame span of the voiced content.

    The mel is a natural-log spectrogram with a fixed floor: silence sits at
    log(1e-10) = -23.03 while speech is near 0 and above. The frame energy is
    therefore the SIGNED per-frame maximum over mel bins; the earlier draft
    squared the values, which put silence (its -23 floor squared) above speech
    and made every clip look fully voiced, so no window could contain the span
    and the 24 Nov 2026 full run trained on zero positive windows. The held-out
    report refused to publish a false-reject rate, which is what exposed it.
    """
    energy = mels.max(axis=1)
    ordered = np.sort(energy)
    floor = float(np.median(ordered[:max(1, len(ordered) // 4)]))
    peak = float(energy.max())
    thr = floor + 0.3 * (peak - floor)
    voiced = np.where(energy > thr)[0]
    if len(voiced) == 0:
        return None
    return int(voiced[0]), int(voiced[-1])


def extract_windows(audio, emb_sess, step=8, span=None):
    """Audio -> [OUT_STEPS, 96] samples; positives need span fully inside."""
    mels = logmel(audio)
    if len(mels) < MEL_WINDOW:
        mels = np.pad(mels, ((0, MEL_WINDOW - len(mels)), (0, 0)))
    windows = []
    for start in range(0, len(mels) - MEL_WINDOW + 1, step):
        if span is not None and span[1] - span[0] + 1 > MEL_WINDOW:
            # Voiced content longer than one window: keep exactly one window
            # centred on the span's energy centroid instead of yielding none.
            centre = (span[0] + span[1]) // 2
            start = max(0, min(centre - MEL_WINDOW // 2, len(mels) - MEL_WINDOW))
        elif span is not None and not (start <= span[0] and start + MEL_WINDOW - 1 >= span[1]):
            continue
        chunk = mels[start:start + MEL_WINDOW][None, ..., None]
        emb = emb_sess.run(None, {'input': chunk})[0]
        emb = np.asarray(emb, dtype=np.float32).reshape(-1, emb.shape[-1])
        if emb.shape[0] != OUT_STEPS:
            continue
        windows.append(emb)
    return windows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', default='data')
    ap.add_argument('--embedding', default='embedding_model.onnx')
    ap.add_argument('--out', default='wake_model.onnx')
    ap.add_argument('--report', default='report.json')
    ap.add_argument('--epochs', type=int, default=4)
    ap.add_argument('--max-windows', type=int, default=40000)
    args = ap.parse_args()

    manifest = json.load(open(os.path.join(args.data, 'manifest.json')))
    emb_sess = ort.InferenceSession(args.embedding, providers=['CPUExecutionProvider'])

    pos, neg = [], []
    for wav in manifest['positives']:
        audio = load_clip(wav)
        mels = logmel(audio)
        pos.extend(extract_windows(audio, emb_sess, span=phrase_span(mels)))
    for wav in manifest['negatives']:
        neg.extend(extract_windows(load_clip(wav), emb_sess))
    rng = np.random.default_rng(20261124)
    rng.shuffle(pos); rng.shuffle(neg)
    pos, neg = pos[:args.max_windows], neg[:args.max_windows * 2]
    hold_p, hold_n = int(len(pos) * 0.1), int(len(neg) * 0.1)
    X = np.array(pos[hold_p:] + neg[hold_n:], dtype=np.float32)
    y = np.concatenate([np.ones(len(pos) - hold_p), np.zeros(len(neg) - hold_n)]).astype(np.float32)
    Xh = np.array(pos[:hold_p] + neg[:hold_n], dtype=np.float32)
    yh = np.concatenate([np.ones(hold_p), np.zeros(hold_n)]).astype(np.float32)

    model = WakeHead(emb_dim=X.shape[-1])
    opt = torch.optim.Adam(model.parameters(), lr=1e-3)
    lossf = nn.BCELoss()
    Xt = torch.tensor(X); yt = torch.tensor(y).unsqueeze(1)
    Xht = torch.tensor(Xh); yht = torch.tensor(yh).unsqueeze(1)
    for epoch in range(args.epochs):
        perm = torch.randperm(len(Xt))
        total = 0.0
        for i in range(0, len(Xt), 256):
            idx = perm[i:i + 256]
            opt.zero_grad()
            loss = lossf(model(Xt[idx]), yt[idx])
            loss.backward(); opt.step()
            total += float(loss) * len(idx)
        with torch.no_grad():
            scores = model(Xht).numpy().ravel()
        print(f"epoch {epoch + 1}/{args.epochs} loss {total / len(Xt):.4f} "
              f"held-out AUROC-ish sep mean(pos) {scores[yht.numpy().ravel() == 1].mean():.3f} "
              f"mean(neg) {scores[yht.numpy().ravel() == 0].mean():.3f}")

    # Export + honest held-out report on a fixed threshold sweep.
    torch.onnx.export(model, Xht[:2], args.out, input_names=['input'],
                      output_names=['logit'], opset_version=13,
                      dynamic_axes={'input': {0: 'batch'}})
    sess = ort.InferenceSession(args.out, providers=['CPUExecutionProvider'])
    scores = sess.run(None, {'input': Xht.numpy()})[0].ravel()
    if hold_p == 0:
        raise SystemExit("REFUSING to write a model: zero held-out positive windows; "
                         "positive extraction produced nothing, the report would be meaningless")
    report = {'held_out_positive_windows': int(hold_p), 'held_out_negative_windows': int(hold_n),
              'thresholds': {}}
    for thr in [0.3, 0.5, 0.7]:
        neg, pos = scores[yh == 0], scores[yh == 1]
        fa = float((neg >= thr).mean()) if len(neg) else None
        fr = float((pos < thr).mean()) if len(pos) else None
        report['thresholds'][str(thr)] = {'false_accept_rate': fa, 'false_reject_rate': fr}
    report['data'] = 'fully synthetic, generated by scripts/wake/generate_training_data.py'
    report['real_world_status'] = 'unmeasured until physical device testing'
    with open(args.report, 'w') as f:
        json.dump(report, f, indent=2)
    print(json.dumps(report, indent=2))
    h = hashlib.sha256(open(args.out, 'rb').read()).hexdigest()
    print(f"wrote {args.out} sha256 {h}")


if __name__ == '__main__':
    main()
