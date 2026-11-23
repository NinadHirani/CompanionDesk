#!/usr/bin/env bash
# Battery + thermal snapshot (Gate 1 POC). Read-only. No uploads.
# Usage: collect_metrics.sh <before|after> <out-file>
# Thermal handling (review fix, 23 Nov 2026): zones are read with their
# names; a value >= 1000 is treated as millidegrees and converted to
# Celsius (thermal_units records the conversion), a smaller value is kept
# as-is (units record that), and unreadable/absent zones record null. The
# raw value and the source zone are always written alongside, so nothing
# is silently converted.
set -euo pipefail
LABEL="${1:?usage: collect_metrics.sh <before|after> <out-file>}"
OUT="${2:?usage: collect_metrics.sh <before|after> <out-file>}"
adb shell dumpsys battery | tr -d '\r' > /tmp/gate1-batt.txt
adb shell 'for z in /sys/class/thermal/thermal_zone*; do t=$(cat "$z/temp" 2>/dev/null || true); n=$(cat "$z/type" 2>/dev/null || true); [ -n "$t" ] && echo "$z|$n|$t"; done' | tr -d '\r' > /tmp/gate1-therm.txt
python3 - "$LABEL" <<'PY' >> "$OUT"
import sys, datetime, re
label = sys.argv[1]
batt = open('/tmp/gate1-batt.txt', errors='replace').read()
level = None
m = re.search(r'level:\s*(\d+)', batt)
if m: level = int(m.group(1))
cc = None
m = re.search(r'Charge counter:\s*(\d+)', batt)
if m: cc = int(m.group(1))
zones = []
for line in open('/tmp/gate1-therm.txt', errors='replace'):
    line = line.strip()
    if not line: continue
    parts = line.split('|')
    if len(parts) < 3: continue
    path, ztype, raw = parts[0], parts[1], parts[2].strip()
    try:
        val = int(raw)
    except ValueError:
        continue
    zones.append((val, path, ztype))
cels = None; src = None; units = 'null'; raw_used = None
if zones:
    val, path, ztype = max(zones, key=lambda z: z[0])
    raw_used = val
    if val >= 1000:
        cels = round(val / 1000.0, 2)
        units = 'celsius, converted from millidegrees (raw/1000)'
    else:
        cels = val
        units = 'celsius, as read (raw below 1000: zone did not report millidegrees)'
    src = '%s (%s)' % (path, ztype)
print('label=%s' % label)
print('timestamp_utc=%s' % datetime.datetime.now(datetime.timezone.utc).isoformat())
print('battery_level=%s' % (level if level is not None else 'null'))
print('battery_charge_counter_uah=%s' % (cc if cc is not None else 'null'))
print('thermal_%s_c=%s' % (label, cels if cels is not None else 'null'))
print('thermal_raw_max=%s' % (raw_used if raw_used is not None else 'null'))
print('thermal_source_zone=%s' % (src if src is not None else 'null'))
print('thermal_units=%s' % units)
print('---')
PY
echo "metrics ($LABEL) appended to $OUT"
