#!/usr/bin/env bash
# Mandatory pre-flight before ANY model download (Gate 1 POC).
# Prints the exact license recorded on the Hugging Face model card.
# It downloads NOTHING and writes nothing. The owner reads the output and
# only then decides, explicitly, whether to run the manual download command
# from the README.
set -euo pipefail
MODEL_ID="${1:?usage: verify-model-license.sh <org/model-id>}"
echo "Model: $MODEL_ID"
echo "Reading the Hugging Face model-card metadata (read-only API call)..."
curl -fsSL "https://huggingface.co/api/models/${MODEL_ID}" -o /tmp/hf-model-meta.json
python3 - "$MODEL_ID" <<'PY'
import json, sys, datetime
mid = sys.argv[1]
d = json.load(open('/tmp/hf-model-meta.json'))
cd = d.get('cardData') or {}
lic = cd.get('license')
taglic = [t.split(':',1)[1] for t in d.get('tags', []) if t.startswith('license:')]
print(f"cardData.license : {lic}")
print(f"license tags     : {taglic}")
print(f"gated            : {d.get('gated')}")
print(f"model id         : {d.get('modelId') or d.get('id')}")
print(f"verified at (UTC): {datetime.datetime.now(datetime.timezone.utc).isoformat()}")
if not lic and not taglic:
    print("NO LICENSE FIELD FOUND: do not download this model without an explicit owner decision.")
    sys.exit(2)
PY
rm -f /tmp/hf-model-meta.json
echo "Next step (owner only): if the license above is acceptable, run the manual download command from README Phase 2. This script never downloads weights."
