#!/usr/bin/env bash
# llama.cpp on-device benchmark driver (Gate 1 POC).
# Review fix, 23 Nov 2026: the benchmark now runs in the BACKGROUND on the
# device and /proc/<pid>/status VmHWM is sampled WHILE the process is
# alive; the earlier version sampled pidof after exit, which made peak RSS
# null on every run. The PID comes from a device-side pid file written as
# $! of the backgrounded llama-bench itself, so an unrelated process can
# never be sampled. Exit code is captured via a device-side rc file, and
# logcat is captured through a timestamp window: device-wide logcat is
# never cleared.
# Env: LLAMA_BENCH_BIN, MODEL_FILE, RUN_ID (default timestamp),
#      G1_SAMPLE_INTERVAL (host poll seconds, default 0.5),
#      G1_MAX_SECONDS (overall timeout, default 1800)
# Paths with spaces or quotes are refused: they are forwarded into a
# device-side shell command.
# No downloads, no uploads; writes only inside this directory. On timeout
# the script kills only the benchmark process it launched.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
LLAMA_BENCH_BIN="${LLAMA_BENCH_BIN:?set LLAMA_BENCH_BIN to the built llama-bench host path}"
MODEL_FILE="${MODEL_FILE:?set MODEL_FILE to the gguf host path}"
RUN_ID="${RUN_ID:-llamacpp-$(date -u +%Y%m%d-%H%M%S)}"
INTERVAL="${G1_SAMPLE_INTERVAL:-0.5}"
MAXSEC="${G1_MAX_SECONDS:-1800}"
for f in "$LLAMA_BENCH_BIN" "$MODEL_FILE"; do
  case "$f" in *[\'\"]*|*\ *) echo "refusing: path contains a space or quote: $f" >&2; exit 2;; esac
  [ -f "$f" ] || { echo "refusing: not a file: $f" >&2; exit 2; }
done
OUTDIR="$HERE/results/llamacpp"
mkdir -p "$OUTDIR"
DEV_DIR=/data/local/tmp/gate1
DEV_BIN="$DEV_DIR/llama-bench"
DEV_MODEL="$DEV_DIR/$(basename "$MODEL_FILE")"
DEV_OUT="$DEV_DIR/bench.out"
DEV_RC="$DEV_DIR/bench.rc"
DEV_PID="$DEV_DIR/bench.pid"
MET="$OUTDIR/$RUN_ID.metrics.log"

adb shell "mkdir -p $DEV_DIR"
adb push "$LLAMA_BENCH_BIN" "$DEV_BIN" >/dev/null
adb push "$MODEL_FILE" "$DEV_MODEL" >/dev/null
"$HERE/scripts/collect_metrics.sh" before "$MET"
START_TS=$(adb shell 'date "+%m-%d %H:%M:%S.000"' | tr -d '\r')
# Background launch on device: llama-bench itself is the backgrounded job
# ($!), so the pid file holds ITS exact pid; wait then records its exit
# code. The rc file is the completion marker.
adb shell "(nohup sh -c '$DEV_BIN -m $DEV_MODEL -t 4 -p 512 -n 128 -r 3 -o md > $DEV_OUT 2>&1 & echo \$! > $DEV_PID; wait \$!; echo \$? > $DEV_RC' >/dev/null 2>&1 &); sleep 1"
PID=$(adb shell "cat $DEV_PID 2>/dev/null || true" | tr -d '\r' | tr -d '[:space:]')
echo "remote pid: ${PID:-not-visible}"
MAXPOLL=$(awk -v s="$MAXSEC" -v i="$INTERVAL" 'BEGIN{ i=i; if (i<=0) i=1; printf "%d", s/i }')
PEAK=""
POLL=0
while :; do
  RC=$(adb shell "cat $DEV_RC 2>/dev/null || true" | tr -d '\r')
  if [ -n "$PID" ]; then
    KB=$(adb shell "grep VmHWM /proc/$PID/status 2>/dev/null || true" | tr -d '\r' | sed -n 's/^VmHWM:[[:space:]]*\([0-9][0-9]*\).*/\1/p')
    if [ -n "$KB" ] && { [ -z "$PEAK" ] || [ "$KB" -gt "$PEAK" ]; }; then PEAK="$KB"; fi
  fi
  [ -n "$RC" ] && break
  POLL=$((POLL + 1))
  if [ "$POLL" -ge "$MAXPOLL" ]; then
    echo "timeout after ~${MAXSEC}s; killing remote pid ${PID:-?}" >&2
    if [ -n "$PID" ]; then
      adb shell "kill $PID 2>/dev/null || true" >/dev/null || true
    fi
    RC="timeout"
    break
  fi
  sleep "$INTERVAL"
done
adb shell "cat $DEV_OUT 2>/dev/null || true" > "$OUTDIR/$RUN_ID.raw.txt"
adb logcat -d -b crash -T "$START_TS" > "$OUTDIR/$RUN_ID.crash.txt" 2>/dev/null || true
"$HERE/scripts/collect_metrics.sh" after "$MET"
{
  echo "run_id=$RUN_ID"
  echo "exit_code=${RC:-null (no rc marker: process killed or device shell lost)}"
  echo "peak_rss_kb=${PEAK:-null (live sampling never observed the process)}"
  echo "peak_rss_source=/proc/<pid>/status VmHWM, sampled live while the benchmark ran"
  echo "logcat_window_start=$START_TS (timestamp-filtered capture; device-wide logcat was NOT cleared)"
  echo "crash_lines=$(wc -l < "$OUTDIR/$RUN_ID.crash.txt" 2>/dev/null || echo 0)"
} >> "$MET"
echo "done: raw=$OUTDIR/$RUN_ID.raw.txt metrics=$MET exit_code=${RC:-null} peak_rss_kb=${PEAK:-null}"
