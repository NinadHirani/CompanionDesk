#!/usr/bin/env bash
# Battery + thermal snapshot (Gate 1 POC). Read-only. No uploads.
# Usage: collect_metrics.sh <label-before|after> <out-file>
set -euo pipefail
LABEL="${1:?usage: collect_metrics.sh <before|after> <out-file>}"
OUT="${2:?usage: collect_metrics.sh <before|after> <out-file>}"
BATT=$(adb shell dumpsys battery | grep -E 'level|Charge counter' | tr -d '\r')
THERM=$(adb shell 'for z in /sys/class/thermal/thermal_zone*; do t=$(cat $z/temp 2>/dev/null); [ -n "$t" ] && echo "$t"; done' | sort -n | tail -1)
{
  echo "label=$LABEL"
  echo "timestamp_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "$BATT"
  echo "max_thermal_zone_temp_millicelsius=$THERM"
} >> "$OUT"
echo "metrics ($LABEL) appended to $OUT"
