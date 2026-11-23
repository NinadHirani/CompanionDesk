#!/usr/bin/env bash
# MLC Android app benchmark capture (Gate 1 POC).
# The MLC run itself happens inside the app the owner built per the official
# docs (https://llm.mlc.ai/docs/deploy/android). This script CAPTURES the
# run window: battery/thermal before/after, PSS sampling of the app process,
# and the app's logcat for the window. It starts nothing, downloads nothing,
# uploads nothing.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
APP_PACKAGE="${MLC_APP_PACKAGE:?set MLC_APP_PACKAGE to the MLC demo app package id (from your build)}"
RUN_ID="${RUN_ID:-mlc-$(date -u +%Y%m%d-%H%M%S)}"
OUTDIR="$HERE/results/mlc"
mkdir -p "$OUTDIR"
MET="$OUTDIR/$RUN_ID.metrics.log"
SAMPLES=10

adb logcat -c >/dev/null 2>&1 || true
"$HERE/scripts/collect_metrics.sh" before "$MET"
echo "owner: start the benchmark run in the MLC app NOW; sampling PSS ${SAMPLES}x every 5s..."
: > /tmp/gate1-pss.log
for i in $(seq 1 "$SAMPLES"); do
  adb shell dumpsys meminfo "$APP_PACKAGE" 2>/dev/null | grep -E 'TOTAL PSS|Native Heap' | tr -d '\r' >> /tmp/gate1-pss.log || true
  sleep 5
done
sort -n /tmp/gate1-pss.log 2>/dev/null | tail -1 >> /tmp/gate1-pss.log
"$HERE/scripts/collect_metrics.sh" after "$MET"
adb logcat -d > "$OUTDIR/$RUN_ID.logcat.txt" 2>/dev/null || true
CRASH=$(adb logcat -b crash -d 2>/dev/null | grep -i -A3 "$APP_PACKAGE" | head -20 | tr -d '\r' || true)
{
  echo "run_id=$RUN_ID"
  echo "peak_pss_line: $(sort -n /tmp/gate1-pss.log 2>/dev/null | tail -1 || echo null)"
  echo "crash_excerpt: ${CRASH:-none}"
} >> "$MET"
echo "done: logcat=$OUTDIR/$RUN_ID.logcat.txt metrics=$MET"
echo "Extract prompt/gen tokens per s and timings from the app's own logcat output; put them in the schema record, null with a note if the app does not report them."
