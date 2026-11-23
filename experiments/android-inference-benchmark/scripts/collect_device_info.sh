#!/usr/bin/env bash
# One baseline row of device facts (Gate 1 POC). Read-only adb getprop +
# battery/thermal snapshot. Writes only inside this directory.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$HERE/results/device-info-$(date -u +%Y%m%d-%H%M%S).json"
adb shell 'for p in ro.product.model ro.product.manufacturer ro.build.version.sdk ro.product.cpu.abilist ro.soc.model ro.soc.manufacturer ro.build.display.id; do echo "$p=$(getprop $p)"; done' > /tmp/gate1-props.txt
{
  echo "{"
  first=1
  while IFS='=' read -r k v; do
    [ -n "$k" ] || continue
    [ $first -eq 1 ] || echo ","
    printf '  "%s": "%s"' "$k" "$v"
    first=0
  done < /tmp/gate1-props.txt
  echo ""
  echo "}"
} > "$OUT"
echo "device info written: $OUT"
cat "$OUT"
