#!/usr/bin/env bash
# llama.cpp on-device benchmark driver (Gate 1 POC).
# Env/args: LLAMA_BENCH_BIN (host path to the built llama-bench),
#           MODEL_FILE   (host path to the gguf),
#           RUN_ID       (record id; default timestamp)
# Behavior: pushes binary+model to /data/local/tmp, runs llama-bench with
# fixed parameters, captures raw stdout, VmHWM peak RSS, battery/thermal
# before and after, and the crash log for the window. No downloads, no
# uploads; writes only inside this directory.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
LLAMA_BENCH_BIN="${LLAMA_BENCH_BIN:?set LLAMA_BENCH_BIN to the built llama-bench host path}"
MODEL_FILE="${MODEL_FILE:?set MODEL_FILE to the gguf host path}"
RUN_ID="${RUN_ID:-llamacpp-$(date -u +%Y%m%d-%H%M%S)}"
OUTDIR="$HERE/results/llamacpp"
mkdir -p "$OUTDIR"
DEV_BIN=/data/local/tmp/llama-bench
DEV_MODEL=/data/local/tmp/$(basename "$MODEL_FILE")
MET="$OUTDIR/$RUN_ID.metrics.log"

adb push "$LLAMA_BENCH_BIN" "$DEV_BIN" >/dev/null
adb push "$MODEL_FILE" "$DEV_MODEL" >/dev/null
"$HERE/scripts/collect_metrics.sh" before "$MET"
adb logcat -b crash -c >/dev/null 2>&1 || true

set +e
adb shell "$DEV_BIN -m $DEV_MODEL -t 4 -p 512 -n 128 -r 3 -o md" > "$OUTDIR/$RUN_ID.raw.txt" 2>&1
RC=$?
set -e

PEAK_RSS=$(adb shell 'pid=$(pidof llama-bench); if [ -n "$pid" ]; then grep VmHWM /proc/$pid/status; else echo "VmHWM: null (process exited)"; fi' | tr -d '\r' || true)
"$HERE/scripts/collect_metrics.sh" after "$MET"
CRASH=$(adb logcat -b crash -d 2>/dev/null | grep -i -A3 'llama' | head -20 | tr -d '\r' || true)
{
  echo "run_id=$RUN_ID"
  echo "exit_code=$RC"
  echo "$PEAK_RSS"
  echo "crash_excerpt: ${CRASH:-none}"
} >> "$MET"
echo "done: raw=$OUTDIR/$RUN_ID.raw.txt exit=$RC metrics=$MET"
echo "Fill the schema record from these outputs before committing (results/schema.md)."
