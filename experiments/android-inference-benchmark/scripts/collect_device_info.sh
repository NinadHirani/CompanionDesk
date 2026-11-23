#!/usr/bin/env bash
# One baseline row of device facts (Gate 1 POC). Read-only adb getprop.
# Review fix, 23 Nov 2026: JSON is assembled by Python's json module, so
# getprop values containing quotes, backslashes or unicode cannot corrupt
# the file. Writes only inside this directory.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$HERE/results/device-info-$(date -u +%Y%m%d-%H%M%S).json"
adb shell getprop | tr -d '\r' > /tmp/gate1-props-all.txt
python3 - "$OUT" <<'PY'
import json, sys, datetime
want = {
    'ro.product.model', 'ro.product.manufacturer', 'ro.build.version.sdk',
    'ro.product.cpu.abilist', 'ro.soc.model', 'ro.soc.manufacturer',
    'ro.build.display.id',
}
d = {}
for line in open('/tmp/gate1-props-all.txt', encoding='utf-8', errors='replace'):
    line = line.rstrip('\n')
    if not line.startswith('[') or ']: [' not in line:
        continue
    key, val = line.split(']: [', 1)
    d[key[1:]] = val[:-1]
out = {k: d[k] for k in sorted(want) if k in d}
missing = sorted(want - set(out))
if missing:
    out['_missing_props'] = missing
out['captured_at_utc'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
text = json.dumps(out, indent=2, ensure_ascii=True)
with open(sys.argv[1], 'w', encoding='utf-8') as f:
    f.write(text + '\n')
print(text)
PY
echo "device info written: $OUT"
