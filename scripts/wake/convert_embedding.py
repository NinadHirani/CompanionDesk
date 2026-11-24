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

DEFAULT_MODULE = "https://tfhub.dev/google/speech_embedding/1"
# Fixed shapes per the notebook: the model consumes log-mel frames
# [batch, T, 32, 1]; T=76 corresponds to 12,400 raw samples (775 ms) at
# 16 kHz. Export supports a dynamic time axis so the app can stream.
DYNAMIC_T = None


def leakyrelu(alpha=0.4000000059604645):
    # The notebook's export-friendly variant of leaky ReLU.
    return lambda x: tf.keras.backend.maximum(alpha * x / 2, x)


def build_model():
    """The exact Keras re-implementation from the notebook, cell 18."""
    def bn_act(x):
        x = tf.keras.layers.BatchNormalization()(x)
        x = leakyrelu()(x)
        x = tf.maximum(x, -0.4000000059604645)
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
    original = hub.KerasLayer(args.module, trainable=False)

    model = build_model()
    # Weight copy, exactly the notebook's cell 19: all layers, then the
    # first conv re-centered around zero per its constraint.
    model.set_weights(original.get_weights())
    model.layers[2].set_weights([model.layers[2].kernel_constraint(model.layers[2].weights[0])])
    model.layers[2].set_weights([model.layers[2].weights[0].numpy() - model.layers[2].weights[0].numpy().mean(axis=(0, 1))])

    # Numeric equivalence check against the original module on raw audio,
    # mirroring the notebook's cells 22-24: the re-implementation must match
    # the original's embeddings on the module's own internal log-mel.
    rng = np.random.default_rng(20261124)
    sample = rng.uniform(-1, 1, size=(1, 12400)).astype(np.float32)
    # The module consumes raw audio; the re-implementation consumes its
    # internal log-mel. Extract that internal tensor via a tflite pass,
    # as the notebook does, then compare embeddings.
    wrapped = tf.keras.Model(inputs=tf.keras.Input((12400,)), outputs=original(tf.constant(sample)))
    print("computing reference embeddings from the original module...")
    ref = original(tf.constant(sample)).numpy()

    print("building the module's internal log-mel via its own graph...")
    # The internal spec tensor is produced inside the module's SavedModel;
    # use its concrete function to grab it by signature output, per the
    # notebook's approach of reading the intermediate tensor.
    loaded = tf.saved_model.load(args.module if os.path.isdir(args.module) else
                                 hub.resolve(args.module))
    fn = loaded.signatures['serving_default']
    out = fn(tf.constant(sample))
    spec_key = next(k for k in out if 'spec' in k.lower() or k != list(out.keys())[-1])
    spec = np.array(out[spec_key], dtype=np.float32).squeeze().T  # [T, 32]

    ours = model(spec[None, ..., None]).numpy()
    diff = float(np.abs(ours.flatten() - ref.flatten()).max())
    print(f"max abs embedding difference: {diff:.6f}")
    if diff > 0.05:
        print("REFUSING to write the model: the conversion does not match "
              "the original module closely enough. Fix before shipping.",
              file=sys.stderr)
        sys.exit(1)

    # Export to ONNX with a dynamic time axis for streaming.
    import tf2onnx
    dyn = tf.keras.Model(inputs=tf.keras.Input((None, 32, 1)), outputs=model(tf.keras.Input((None, 32, 1))))
    spec_proto = [tf.TensorSpec([None, None, 32, 1], tf.float32, name='input')]
    tf2onnx.convert.from_keras(dyn, input_signature=spec_proto, opset=13, output_path=args.out)
    print(f"wrote {args.out}")
    import hashlib
    h = hashlib.sha256(open(args.out, 'rb').read()).hexdigest()
    print(f"sha256 {h}")


if __name__ == '__main__':
    main()
