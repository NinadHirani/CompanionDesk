#!/usr/bin/env bash
# Copy the exact onnxruntime-web runtime files the listener page needs from
# node_modules into renderer/vendor/wake-ort/ (the same vendoring pattern the
# app already uses for sql.js). Run once after npm install; the wake engine
# reports wake_engine_missing until these files exist. License: MIT
# (docs/WAKE_PROVENANCE.md), pinned to the package.json version.
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir -p renderer/vendor/wake-ort
for f in ort.min.js ort-wasm-simd-threaded.wasm ort-wasm-simd-threaded.mjs; do
  cp "node_modules/onnxruntime-web/dist/$f" "renderer/vendor/wake-ort/$f"
done
echo "vendored: $(ls renderer/vendor/wake-ort)"
