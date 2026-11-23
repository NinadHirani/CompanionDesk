#!/usr/bin/env bash
# Assembles the self-contained web/mobile bundle in web/ (the Capacitor
# webDir). Run after every source change:
#   bash scripts/build-web.sh
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p web/vendor web/core web/prompts
# Renderer modules: the same files the desktop window loads, in the same
# order. The overlay and the recorder are Electron-only (overlay.js,
# pcm.js, recorder*.js) and stay out of the browser bundle.
cp renderer/format.js renderer/errors.js renderer/dom.js renderer/app.js \
   renderer/ask.js renderer/about.js renderer/grades.js renderer/onboarding.js \
   renderer/boot.js renderer/styles.css web/
cp prompts/syllabus-extract.md web/prompts/
# Pure logic modules, wrapped dual-mode by scripts/web-wrap.js.
node scripts/web-wrap.js
# Already dual-mode modules plus the web bridge.
cp src/extraction-core.js src/import-errors.js src/ai.js src/model-selection.js src/chat-history.js src/ollama-setup.js src/db.js src/provider-registry.js src/task-router.js src/hardware.js src/provider-faults.js src/provider-status.js web/core/
cp src/web/bridge.js web/bridge.js
cp node_modules/sql.js/dist/sql-wasm.js node_modules/sql.js/dist/sql-wasm.wasm web/vendor/
cp node_modules/pdfjs-dist/build/pdf.min.mjs web/vendor/
# The worker runs in its own realm; prepend the Uint8Array shim directly.
cp src/uint8-hex.js web/vendor/uint8-hex.js
cp node_modules/pdfjs-dist/build/pdf.worker.min.mjs web/vendor/
cat web/vendor/uint8-hex.js web/vendor/pdf.worker.min.mjs > web/vendor/pdf.worker.min.mjs.new
mv web/vendor/pdf.worker.min.mjs.new web/vendor/pdf.worker.min.mjs

echo "web bundle assembled in web/ ($(find web -type f | wc -l) files)"
