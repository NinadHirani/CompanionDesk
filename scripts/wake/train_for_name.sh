#!/usr/bin/env bash
# One-command per-name wake model: the dynamic "Hey + <companion name>"
# requirement is met by training a model PER NAME with the same local,
# no-cost, license-verified pipeline, and the engine loading ONLY the file
# named for the currently configured phrase (docs/WAKE_WORD.md). Changing
# the companion name in Settings invalidates the old model (the engine
# reports phrase_mismatch); this script produces the new one.
#
# Usage:
#   bash scripts/wake/train_for_name.sh --name "Nova" \
#        [--models-dir /path/to/app/models/wake] [--positives 800] \
#        [--word-negatives 1600] [--hard-negatives 300] [--noise-negatives 400]
#        [--embedding /path/to/embedding_model.onnx]
#
# Name rules mirror src/wake-word.js exactly (letters, spaces, apostrophes,
# hyphens; <=40 chars); an invalid name is refused BEFORE any model id or
# training run happens. Nothing downloads; the only voice is the one
# verified in docs/WAKE_PROVENANCE.md.
set -euo pipefail
cd "$(dirname "$0")/../.."

NAME="" ; MODELS_DIR="models/wake" ; POS=800 ; WNEG=1600 ; HNEG=300 ; NNEG=400
EMBED=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) NAME="$2"; shift 2 ;;
    --models-dir) MODELS_DIR="$2"; shift 2 ;;
    --positives) POS="$2"; shift 2 ;;
    --word-negatives) WNEG="$2"; shift 2 ;;
    --hard-negatives) HNEG="$2"; shift 2 ;;
    --noise-negatives) NNEG="$2"; shift 2 ;;
    --embedding) EMBED="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

python3 - "$NAME" <<'PY'
import sys
name = (sys.argv[1] if len(sys.argv) > 1 else '').strip()
MAX_NAME = 40
NAME_RE_OK = bool(name) and (
    (len(name) == 1 and name.isalpha())
    or (1 < len(name) <= MAX_NAME and name[0].isalpha() and name[-1].isalnum() and all(c.isalpha() or c in " '-." for c in name))
)
if not NAME_RE_OK:
    print("REFUSED: companion name does not meet the wake phrase charset "
          "(letters, spaces, apostrophes, hyphens; <=40 chars). Nothing "
          "was trained and no model id was built.", file=sys.stderr)
    sys.exit(1)
model_id = 'hey-' + ''.join(c if c.isalnum() else '-' for c in name.lower())
import re
model_id = re.sub(r'-+', '-', model_id).strip('-')
if not model_id or model_id == 'hey-':
    print("REFUSED: name normalizes to no model id.", file=sys.stderr)
    sys.exit(1)
print(model_id)
PY
MODEL_ID=$(python3 - "$NAME" <<'PY'
import sys, re
name = (sys.argv[1] if len(sys.argv) > 1 else '').strip()
model_id = 'hey-' + ''.join(c if c.isalnum() else '-' for c in name.lower())
print(re.sub(r'-+', '-', model_id).strip('-'))
PY
)

if [[ -z "$EMBED" ]]; then EMBED="/tmp/waketrain/embedding_model.onnx"; fi
if [[ ! -f "$EMBED" ]]; then
  echo "missing embedding model at $EMBED - run convert_embedding.py first (scripts/wake/README.md step 1)" >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
# The generator writes manifest paths relative to its working directory and the
# trainer resolves them the same way, so both steps run from the temp workdir.
echo "== generating synthetic corpus for \"Hey $NAME\" =="
( cd "$WORK" && python3 "$(cd "$(dirname "$0")" && pwd)"/generate_training_data.py --phrase "Hey $NAME" \
  --voices /tmp/waketrain/en_US-amy-medium.onnx \
  --positives "$POS" --word-negatives "$WNEG" --hard-negatives "$HNEG" --noise-negatives "$NNEG" \
  --out data )
echo "== training the head =="
( cd "$WORK" && python3 "$(cd "$(dirname "$0")" && pwd)"/train_wake_model.py --data data --embedding "$EMBED" \
  --out wake_model.onnx --report report.json )
EMBED_OUT="$MODELS_DIR/embedding.onnx"
echo "== placing artifacts =="
mkdir -p "$MODELS_DIR"
cp "$EMBED" "$EMBED_OUT"
cp "$WORK/wake_model.onnx" "$MODELS_DIR/$MODEL_ID.onnx"
cp "$WORK/report.json" "$MODELS_DIR/$MODEL_ID.report.json"
echo "done: $MODELS_DIR/$MODEL_ID.onnx (+ embedding.onnx, report)"
