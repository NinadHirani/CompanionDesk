#!/usr/bin/env bash
# Assembles the self-contained web/mobile bundle in web/ (the Capacitor
# webDir). Run after every source change:
#   bash scripts/build-web.sh
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p web/vendor web/core web/prompts
cp renderer/app.js renderer/styles.css web/
cp prompts/syllabus-extract.md web/prompts/
cp src/extraction-core.js src/import-errors.js src/ai.js src/db.js web/core/
cp src/web/bridge.js web/bridge.js
cp node_modules/sql.js/dist/sql-wasm.js node_modules/sql.js/dist/sql-wasm.wasm web/vendor/
cp node_modules/pdfjs-dist/build/pdf.min.mjs node_modules/pdfjs-dist/build/pdf.worker.min.mjs web/vendor/

echo "web bundle assembled in web/ ($(find web -type f | wc -l) files)"
