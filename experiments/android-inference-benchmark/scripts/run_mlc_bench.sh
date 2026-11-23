#!/usr/bin/env bash
# MLC Android app benchmark capture (Gate 1 POC).
# Review fix, 23 Nov 2026: TOTAL PSS values are parsed as NUMBERS and the
# maximum is recorded with units (the earlier version took the
# lexicographically-last string). The app's logcat is captured through a
# timestamp window; device-wide logcat is never cleared.
# The MLC run itself happens inside the app the owner built per the
# official docs (https://llm.mlc.ai/docs/deploy/android). This script
# starts nothing, downloads nothing, uploads nothing.
# Env: MLC_APP_PACKAGE (required), RUN_ID (default timestamp),
#      MLC_SAMPLES (default 10), MLC_SAMPLE_SECONDS (default 5)
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
APP_PACKAGE="${MLC_APP_PACKAGE:?set MLC_APP_PACKAGE to the MLC demo app package id (from your build)}"
case "$APP_PACKAGE" in *[\'\"\ \;]*|*\`*) echo "refusing: suspicious package id: $APP_PACKAGE" >&2; exit 2;; esac
RUN_ID="${RUN_ID:-mlc-$(date -u +%Y%m%d-%H%M%S)}"
SAMPLES="${MLC_SAMPLES:-10}"
INTERVAL="${MLC_SAMPLE_SECONDS:-5}"
OUTDIR="$HERE/results/mlc"
mkdir -p "$OUTDIR"
MET="$OUTDIR/$RUN_ID.metrics.log"

START_TS=$(adb shell 'date "+%m-%d %H:%M:%S.000"' | tr -d '\r')
"$HERE/scripts/collect_metrics.sh" before "$MET"
echo "owner: start the benchmark run in the MLC app NOW; sampling TOTAL PSS ${SAMPLES}x every ${INTERVAL}s..."
: > /tmp/gate1-mem.txt
for _ in $(seq 1 "$SAMPLES"); do
  adb shell dumpsys meminfo "$APP_PACKAGE" 2>/dev/null | tr -d '\r' >> /tmp/gate1-mem.txt || true
  sleep "$INTERVAL"
done
python3 - <<'PY' > /tmp/gate1-pss-max.txt
import re
text = open('/tmp/gate1-mem.txt', errors='replace').read()
vals = [int(x.group(1)) for x in re.finditer(r'TOTAL\s+PSS:\s*(\d+)', text)]
if vals:
    print('%d kB (max of %d samples)' % (max(vals), len(vals)))
else:
    print('null (no TOTAL PSS samples parsed; check the package id and app state)')
PY
"$HERE/scripts/collect_metrics.sh" after "$MET"
adb logcat -d -T "$START_TS" > "$OUTDIR/$RUN_ID.logcat.txt" 2>/dev/null || true
CRASH=$(adb logcat -d -b crash -T "$START_TS" 2>/dev/null | grep -i -A3 "$APP_PACKAGE" | head -20 | tr -d '\r' || true)
{
  echo "run_id=$RUN_ID"
  echo "peak_pss_kB_max=$(cat /tmp/gate1-pss-max.txt)"
  echo "crash_excerpt: ${CRASH:-none}"
  echo "logcat_window_start=$START_TS (timestamp-filtered capture; device-wide logcat was NOT cleared)"
} >> "$MET"
echo "done: logcat=$OUTDIR/$RUN_ID.logcat.txt metrics=$MET"
echo "Extract prompt/gen tokens per s and timings from the app's own logcat output; put them in the schema record, null with a note if the app does not report them."
