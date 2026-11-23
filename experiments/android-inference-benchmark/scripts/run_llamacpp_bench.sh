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
# Input validation (review, 23 Nov 2026), strict allowlists:
#   - host paths are refused if they contain spaces or quotes (they are
#     forwarded into a device-side shell command), and the model's final
#     filename component must match [A-Za-z0-9][A-Za-z0-9._-]* before it
#     becomes part of a device path/command (no traversal, no metachars);
#   - RUN_ID must match [A-Za-z0-9][A-Za-z0-9._-]*: it names result files
#     and is echoed into the metrics log, so slashes, leading dots
#     (path traversal) and shell/control characters are impossible;
#   - G1_SAMPLE_INTERVAL is a number >0 and <=60, G1_MAX_SECONDS an
#     integer 1..86400; anything else is refused before any adb call;
#   - the device-sourced PID is accepted only if purely numeric before it
#     is used in a /proc path or a device kill command.
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
DEV_MODEL_BASE=$(basename "$MODEL_FILE")
if ! [[ "$DEV_MODEL_BASE" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
  echo "refusing: model filename must match [A-Za-z0-9][A-Za-z0-9._-]* (got: $DEV_MODEL_BASE)" >&2; exit 2
fi
if ! [[ "$RUN_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
  echo "refusing: RUN_ID must match [A-Za-z0-9][A-Za-z0-9._-]* (got: $RUN_ID)" >&2; exit 2
fi
if ! [[ "$INTERVAL" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
  echo "refusing: G1_SAMPLE_INTERVAL must be a plain positive number (got: $INTERVAL)" >&2; exit 2
fi
if ! [[ "$MAXSEC" =~ ^[0-9]+$ ]]; then
  echo "refusing: G1_MAX_SECONDS must be a plain positive integer (got: $MAXSEC)" >&2; exit 2
fi
awk -v i="$INTERVAL" 'BEGIN{ if (i+0<=0 || i+0>60) exit 1 }' || { echo "refusing: G1_SAMPLE_INTERVAL must be >0 and <=60 (got: $INTERVAL)" >&2; exit 2; }
awk -v m="$MAXSEC" 'BEGIN{ if (m+0<1 || m+0>86400) exit 1 }' || { echo "refusing: G1_MAX_SECONDS must be 1..86400 (got: $MAXSEC)" >&2; exit 2; }
OUTDIR="$HERE/results/llamacpp"
mkdir -p "$OUTDIR"
DEV_DIR=/data/local/tmp/gate1
DEV_BIN="$DEV_DIR/llama-bench"
DEV_MODEL="$DEV_DIR/$DEV_MODEL_BASE"
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
case "$PID" in ''|*[!0-9]*) PID='' ;; esac
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
