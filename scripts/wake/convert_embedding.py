#!/usr/bin/env python3
# Convert Google's Apache-2.0 speech_embedding module into the ONNX feature
# extractor CompanionDesk ships for wake-word detection.
#
# Provenance (docs/WAKE_PROVENANCE.md): adapted from openWakeWord's own
# Apache-2.0 notebook notebooks/converting_google_speech_embedding_model.ipynb
# (github.com/dscripka/openWakeWord), which documents the manual Keras
# re-implementation and the exact weight-copy step. We deliberately do NOT
# ship openWakeWord's own embedding_model.onnx: its license is unsettled
# upstream (issues #338/#346/#348/#357, no maintainer answer as of
# 24 Nov 2026), so we convert from Google's Apache-2.0 module ourselves and
# verify the result numerically before writing anything.
#
# Inputs:  the speech_embedding module (tfhub URL or a local directory).
# Output:  embedding_model.onnx  (input: [batch, T, 32] log-mel frames,
#          output: embeddings), written only after the numeric check passes.
#
# Training-only tool: this script never ships inside the app.
#
# Usage:  python3 convert_embedding.py [--module URL_OR_DIR] [--out PATH]
# Deps:   pip install tensorflow tensorflow-hub tf2onnx onnx numpy

import argparse
import os
import sys

import tensorflow as tf  # training-only tool; never ships in the app

DEFAULT_MODULE = "https://tfhub.dev/google/speech_embedding/1"
# Fixed shapes per the notebook: the model consumes log-mel frames
# [batch, T, 32, 1]; T=76 corresponds to 12,400 raw samples (775 ms) at
# 16 kHz. Export supports a dynamic time axis so the app can stream.
DYNAMIC_T = None


def leakyrelu(alpha=0.4000000059604645):
    # The notebook's export-friendly variant of leaky ReLU.
    # keras.ops keeps this functional in Keras 3 (raw tf ops reject KerasTensors).
    return lambda x: tf.keras.ops.maximum(alpha * x / 2, x)


def build_model():
    """The exact Keras re-implementation from the notebook, cell 18."""
    def bn_act(x):
        x = tf.keras.layers.BatchNormalization()(x)
        x = leakyrelu()(x)
        x = tf.keras.ops.maximum(x, -0.4000000059604645)
        return x

    class CenterAround(tf.keras.constraints.Constraint):
        def __init__(self, ref_value):
            self.ref_value = ref_value
        def __call__(self, w):
            mean = tf.reduce_mean(w, axis=(0, 1))
            return w - mean + self.ref_value

    t = DYNAMIC_T if DYNAMIC_T else 76
    inputs = tf.keras.Input((t, 32, 1))
    x = tf.keras.layers.ZeroPadding2D((0, 1))(inputs)
    x = tf.keras.layers.Conv2D(24, (3, 3), use_bias=False, padding='valid',
                               kernel_constraint=CenterAround(0.0), activation='relu')(x)
    x = bn_act(x)
    x = tf.keras.layers.Conv2D(24, (1, 3), use_bias=False, padding='same')(x); x = bn_act(x)
    x = tf.keras.layers.Conv2D(24, (3, 1), use_bias=False, padding='valid')(x); x = bn_act(x)
    x = tf.keras.layers.MaxPool2D((2, 2), (2, 2), padding='valid')(x)
    x = tf.keras.layers.Conv2D(48, (1, 3), use_bias=False, padding='same')(x); x = bn_act(x)
    x = tf.keras.layers.Conv2D(48, (3, 1), use_bias=False, padding='valid')(x); x = bn_act(x)
    x = tf.keras.layers.Conv2D(48, (1, 3), use_bias=False, padding='same')(x); x = bn_act(x)
    x = tf.keras.layers.Conv2D(48, (3, 1), use_bias=False, padding='valid')(x); x = bn_act(x)
    x = tf.keras.layers.MaxPool2D((1, 2), (1, 2), padding='same')(x)
    x = tf.keras.layers.Conv2D(72, (1, 3), use_bias=False, padding='same')(x); x = bn_act(x)
    x = tf.keras.layers.Conv2D(72, (3, 1), use_bias=False, padding='valid')(x); x = bn_act(x)
    x = tf.keras.layers.Conv2D(72, (1, 3), use_bias=False, padding='same')(x); x = bn_act(x)
    x = tf.keras.layers.Conv2D(72, (3, 1), use_bias=False, padding='valid')(x); x = bn_act(x)
    x = tf.keras.layers.MaxPool2D((2, 2), (2, 2), padding='valid')(x)
    x = tf.keras.layers.Conv2D(96, (1, 3), use_bias=False, padding='same')(x); x = bn_act(x)
    x = tf.keras.layers.Conv2D(96, (3, 1), use_bias=False, padding='valid')(x); x = bn_act(x)
    x = tf.keras.layers.Conv2D(96, (1, 3), use_bias=False, padding='same')(x); x = bn_act(x)
    x = tf.keras.layers.Conv2D(96, (3, 1), use_bias=False, padding='valid')(x); x = bn_act(x)
    x = tf.keras.layers.MaxPool2D((1, 2), (1, 2), padding='valid')(x)
    x = tf.keras.layers.Conv2D(96, (1, 3), use_bias=False, padding='same')(x); x = bn_act(x)
    x = tf.keras.layers.Conv2D(96, (3, 1), use_bias=False, padding='valid')(x); x = bn_act(x)
    x = tf.keras.layers.Conv2D(96, (1, 3), use_bias=False, padding='same')(x); x = bn_act(x)
    x = tf.keras.layers.Conv2D(96, (3, 1), use_bias=False, padding='valid')(x); x = bn_act(x)
    x = tf.keras.layers.MaxPool2D((2, 2), (2, 2), padding='valid')(x)
    x = tf.keras.layers.Conv2D(96, (3, 1), use_bias=False, padding='valid')(x)
    return tf.keras.Model(inputs=inputs, outputs=x)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--module', default=DEFAULT_MODULE,
                    help='tfhub/Kaggle module URL or a local unpacked directory')
    ap.add_argument('--out', default='embedding_model.onnx')
    args = ap.parse_args()

    import numpy as np
    import tensorflow as tf
    import tensorflow_hub as hub

    print(f"loading module: {args.module}")
    original = hub.load(args.module)
    fn = original.signatures['default']
    print("signature outputs:", list(fn.structured_outputs.keys()))

    rng = np.random.default_rng(20261124)
    sample = rng.uniform(-1, 1, size=(1, 12400)).astype(np.float32)
    ref = np.asarray(fn(tf.constant(sample))['default'], dtype=np.float32).ravel()
    print(f"reference embeddings: {ref.shape}")

    # Read the module's INTERNAL log-mel straight from its SavedModel
    # graph: the input of the first ZeroMeanConv2D's pad op IS the scaled
    # log-mel the embedding consumes (this reproduces the notebook's
    # intermediate-tensor read without needing TFLite flex ops, which
    # current TensorFlow cannot convert for this module).
    import tempfile, os
    graph = fn.graph
    # Walk from the ZeroMeanConv2d conv back to the Pad feeding it, then one
    # hop further: the pad's input IS the unscaled-free internal log-mel
    # (32 mel bins, same layout the notebook's reimplementation consumes).
    conv_ops = [op for op in graph.get_operations()
                if op.type == 'Conv2D' and 'ZeroMeanConv2d/Conv2D' in op.name]
    pad_ops = []
    for conv in conv_ops:
        src = conv.inputs[0].op
        if src.type == 'Pad':
            pad_ops.append(src)
    if not pad_ops:
        pad_ops = [op for op in graph.get_operations() if op.type == 'Pad']
    if not pad_ops:
        print("could not locate the module's internal log-mel tensor",
              file=sys.stderr)
        sys.exit(1)
    mel_t = pad_ops[0].inputs[0]
    with tf.compat.v1.Session(graph=graph) as sess:
        spec = np.asarray(sess.run(mel_t, feed_dict={'samples:0': sample}))
    if spec.shape[-2] != 32 or spec.shape[-3] < 76:
        print(f"unexpected internal log-mel shape {spec.shape}", file=sys.stderr)
        sys.exit(1)
    spec = spec[0]  # [T, 32, 1]

    model = build_model()
    # Weight copy, exactly the notebook's cell 19: all layers, then the
    # first conv re-centered around zero per its constraint.
    # hub.load returns a SavedModel wrapper (no get_weights); its variables
    # are in checkpoint order, which matches the re-implementation's stack.
    src_weights = [v.numpy() for v in original.variables]
    if len(src_weights) != len(model.weights):
        print(f"weight count mismatch: module {len(src_weights)} vs model "
              f"{len(model.weights)}", file=sys.stderr)
        sys.exit(1)
    model.set_weights(src_weights)
    k0 = model.layers[2].kernel_constraint(model.layers[2].weights[0])
    model.layers[2].set_weights([k0])

    ours = model(np.clip(spec[None, ...], 1e-10, None)).numpy().ravel()
    diff = float(np.abs(ours - ref).max())
    print(f"max abs embedding difference: {diff:.6f}")
    if diff > 0.05:
        print("REFUSING to write the model: the conversion does not match "
              "the original module closely enough. Fix before shipping.",
              file=sys.stderr)
        sys.exit(1)

    # Export to ONNX with a dynamic time axis for streaming.
    dyn_input = tf.keras.Input((None, 32, 1))
    dyn = tf.keras.Model(inputs=dyn_input, outputs=model(dyn_input))
    spec_proto = [tf.TensorSpec([None, None, 32, 1], tf.float32, name='input')]
    import tf2onnx
    tf2onnx.convert.from_keras(dyn, input_signature=spec_proto, opset=13,
                               output_path=args.out)
    print(f"wrote {args.out}")
    import hashlib
    h = hashlib.sha256(open(args.out, 'rb').read()).hexdigest()
    print(f"sha256 {h}")


if __name__ == '__main__':
    main()
