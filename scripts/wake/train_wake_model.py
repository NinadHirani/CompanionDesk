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
def mel_filterbank(sr=16000, n_fft=512, n_mels=32, fmin=60.0, fmax=3800.0):
    """librosa-compatible slaney mel filterbank, implemented directly."""
    def hz_to_mel(f):
        return 2595.0 * np.log10(1.0 + np.asarray(f, dtype=np.float64) / 700.0)
    def mel_to_hz(m):
        return 700.0 * (10 ** (np.asarray(m, dtype=np.float64) / 2595.0) - 1.0)
    mel_min, mel_max = hz_to_mel(fmin), hz_to_mel(fmax)
    mels = np.linspace(mel_min, mel_max, n_mels + 2)
    hz = mel_to_hz(mels)
    bins = np.floor((n_fft + 1) * hz / sr).astype(int)
    fb = np.zeros((n_mels, n_fft // 2 + 1), dtype=np.float64)
    for i in range(n_mels):
        left, center, right = bins[i], bins[i + 1], bins[i + 2]
        for k in range(max(left, 0), min(center, n_fft // 2 + 1)):
            fb[i, k] = (k - bins[i]) / (bins[i + 1] - bins[i])
        for k in range(center, min(right, n_fft // 2 + 1)):
            fb[i, k] = (bins[i + 2] - k) / (bins[i + 2] - bins[i + 1])
    # slaney normalization
    enorm = 2.0 / (hz[2:n_mels + 2] - hz[:n_mels])
    fb *= enorm[:, None]
    return fb


def logmel(audio, sr=16000, win=400, hop=160, n_fft=512):
    """Raw audio -> [T, 32] log-mel, matching torchlibrosa center=False."""
    import numpy.fft as fft
    n = len(audio)
    if n < win:
        audio = np.pad(audio, (0, win - n))
        n = win
    n_frames = 1 + (n - win) // hop
    idx = np.arange(win)[None, :] + hop * np.arange(n_frames)[:, None]
    frames = audio[idx]
    window = np.hanning(win + 1)[:win].astype(np.float64)  # periodic hann
    padded = np.zeros((n_frames, n_fft), dtype=np.float64)
    pad = (n_fft - win) // 2
    padded[:, pad:pad + win] = frames * window
    spec = np.abs(fft.rfft(padded, axis=1)) ** 2
    mel = mel_filterbank(sr=sr) @ spec.T  # [32, T]
    logmel = 10.0 * np.log10(np.maximum(mel, 1e-10))
    return (logmel / 10.0 + 2.0).T.astype(np.float32)  # [T, 32]


class WakeHead(nn.Module):
    """Small GRU head over 16 embedding steps, openWakeWord-shaped."""
    def __init__(self, emb_dim=1024, hidden=64):
        super().__init__()
        self.gru = nn.GRU(emb_dim, hidden, batch_first=True)
        self.fc1 = nn.Linear(hidden, 32)
        self.relu = nn.ReLU()
        self.fc2 = nn.Linear(32, 1)

    def forward(self, x):
        _, h = self.gru(x)
        return self.fc2(self.relu(h[-1]))


def load_clip(path):
    import soundfile as sf
    data, sr = sf.read(path, dtype='float32')
    assert sr == 16000, f"expected 16 kHz, got {sr}"
    if data.ndim > 1:
        data = data.mean(axis=1)
    return data


def extract_windows(audio, emb_sess, window=76, step=8, out_steps=16):
    """Audio -> overlapping [out_steps, emb_dim] windows."""
    mels = logmel(audio)
    windows = []
    for start in range(0, len(mels) - window + 1, step):
        chunk = mels[start:start + window][None, ..., None]
        emb = emb_sess.run(None, {'input': chunk})[0]  # [1, T', emb_dim]
        emb = np.asarray(emb[0], dtype=np.float32)
        for i in range(0, len(emb) - out_steps + 1):
            windows.append(emb[i:i + out_steps])
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
        pos.extend(extract_windows(load_clip(wav), emb_sess))
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
    lossf = nn.BCEWithLogitsLoss()
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
            scores = torch.sigmoid(model(Xht)).numpy().ravel()
        print(f"epoch {epoch + 1}/{args.epochs} loss {total / len(Xt):.4f} "
              f"held-out AUROC-ish sep mean(pos) {scores[yht.numpy().ravel() == 1].mean():.3f} "
              f"mean(neg) {scores[yht.numpy().ravel() == 0].mean():.3f}")

    # Export + honest held-out report on a fixed threshold sweep.
    torch.onnx.export(model, Xht[:2], args.out, input_names=['input'],
                      output_names=['logit'], opset_version=13,
                      dynamic_axes={'input': {0: 'batch'}})
    sess = ort.InferenceSession(args.out, providers=['CPUExecutionProvider'])
    scores = sess.run(None, {'input': Xht})[0].ravel()
    report = {'held_out_positive_windows': int(hold_p), 'held_out_negative_windows': int(hold_n),
              'thresholds': {}}
    for thr in [0.3, 0.5, 0.7]:
        fa = float((scores[yh == 0] >= thr).mean())
        fr = float((scores[yh == 1] < thr).mean())
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
