#!/usr/bin/env bash
# Gate 1 scaffold self-test (no device needed, runs on macOS/Linux CI).
# 1) bash -n on every script; 2) shellcheck when installed (skipped
# otherwise, documented limitation); 3) static checks (no device-wide
# logcat clears, no weight downloads in capture scripts); 4) parser/flow
# tests against a mocked adb, run inside a TEMP COPY of this directory so
# the real repo tree is never written to. These tests verify the SCRIPTS,
# not any device: no device measurement is claimed anywhere.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
FAIL=0
ok()  { echo "ok: $1"; }
bad() { echo "FAIL: $1"; FAIL=1; }

echo "== bash -n =="
for f in "$HERE"/*.sh; do
  if bash -n "$f"; then ok "syntax $(basename "$f")"; else bad "syntax $f"; fi
done

echo "== shellcheck (if available) =="
if command -v shellcheck >/dev/null 2>&1; then
  if shellcheck "$HERE"/*.sh; then ok "shellcheck clean"; else bad "shellcheck findings"; fi
else
  ok "shellcheck not installed; skipped (documented limitation)"
fi

echo "== static checks =="
for f in run_llamacpp_bench.sh run_mlc_bench.sh collect_metrics.sh collect_device_info.sh; do
  if grep -n 'logcat' "$HERE/$f" | grep -Eq -- '-c([[:space:]]|$)'; then
    bad "$f appears to use 'logcat -c' (device-wide clear)"
  else
    ok "$f: no device-wide logcat clear"
  fi
done
if grep -nE 'huggingface-cli download|wget |git clone|curl .*(gguf|task)' \
     "$HERE/run_llamacpp_bench.sh" "$HERE/run_mlc_bench.sh" \
     "$HERE/collect_metrics.sh" "$HERE/collect_device_info.sh" >/dev/null; then
  bad "capture scripts must never download anything"
else
  ok "no downloads in capture scripts"
fi

echo "== mocked adb (sandboxed copy) =="
SAND="$TMP/g1"
cp -r "$ROOT" "$SAND"
S="$SAND/scripts"
STATE="$TMP/state"
mkdir -p "$TMP/mockbin" "$STATE"
export G1_TEST_STATE="$STATE"
cat > "$TMP/mockbin/adb" <<'STUB'
#!/usr/bin/env bash
STATE="${G1_TEST_STATE:?}"
mkdir -p "$STATE"
printf '%s\n' "$*" >> "$STATE/calls.log"
case "$*" in
  *getprop*)
    printf '[ro.product.model]: [Pixel "test" \\value]\n'
    printf '[ro.product.manufacturer]: [OnePlus]\n'
    printf '[ro.build.version.sdk]: [13]\n'
    printf '[ro.product.cpu.abilist]: [arm64-v8a,armeabi-v7a]\n'
    printf '[ro.soc.model]: [SM8550]\n'
    printf '[ro.soc.manufacturer]: [QTI]\n'
    printf '[ro.build.display.id]: [CPH2609]\n' ;;
  *battery*)
    printf 'Current battery service state:\n level: 85\n Charge counter: 4820000\n' ;;
  *thermal_zone*)
    case "${G1_THERMAL_SCENARIO:-millidegrees}" in
      millidegrees) printf '/sys/class/thermal/thermal_zone0|cpu|41250\n/sys/class/thermal/thermal_zone1|gpu|39120\n' ;;
      plain)        printf '/sys/class/thermal/thermal_zone0|cpu|41\n' ;;
      empty)        : ;;
    esac ;;
  *meminfo*)
    n=$(cat "$STATE/mem_calls" 2>/dev/null || echo 0)
    echo $((n + 1)) > "$STATE/mem_calls"
    case "$n" in
      0) printf 'TOTAL PSS: 1000\\n' ;;
      1) printf 'TOTAL PSS: %s\\n' "${G1_MEM_TOTAL:-95000}" ;;
      *) printf 'TOTAL PSS: 4000\\n' ;;
    esac ;;
  *nohup*) : ;;
  *proc*)
    n=$(cat "$STATE/vmhwm_calls" 2>/dev/null || echo 0)
    echo $((n + 1)) > "$STATE/vmhwm_calls"
    case "$n" in
      0) printf 'VmHWM:\t1000 kB\\n' ;;
      1) printf 'VmHWM:\t2000 kB\\n' ;;
      *) : ;;
    esac ;;
  *bench.rc*)
    n=$(cat "$STATE/rc_calls" 2>/dev/null || echo 0)
    echo $((n + 1)) > "$STATE/rc_calls"
    if [ "$n" -ge 2 ]; then printf '0'; fi ;;
  *bench.out*) printf 'raw benchmark output line' ;;
  *pidof*)
    n=$(cat "$STATE/pid_calls" 2>/dev/null || echo 0)
    echo $((n + 1)) > "$STATE/pid_calls"
    if [ "$n" -eq 0 ]; then printf '1234'; fi ;;
  *date*) printf '11-23 16:50:00.000' ;;
  *push*) echo 'pushed' ;;
  *mkdir*) : ;;
  *logcat*) echo 'logcat-window-content' ;;
  *) echo "UNMATCHED adb call: $*" >&2; exit 9 ;;
esac
STUB
chmod +x "$TMP/mockbin/adb"
export PATH="$TMP/mockbin:$PATH"

# --- test 1: device info JSON escaping ---
"$S/collect_device_info.sh" > "$TMP/t1.out" 2>&1
OUT_JSON=$(ls -t "$SAND/results"/device-info-*.json 2>/dev/null | head -1)
if python3 -c "
import json
d = json.load(open('$OUT_JSON'))
v = d['ro.product.model']
assert v == 'Pixel \"test\" \\\\value', repr(v)
assert d['ro.soc.model'] == 'SM8550'
assert d.get('_missing_props') is None
"; then ok "device info: JSON parses; quotes/backslash in getprop values survive"; else bad "device info JSON"; cat "$TMP/t1.out"; fi

# --- test 2: thermal unit handling (three scenarios) ---
run_metrics_case() {
  local scen="$1" expect="$2" units="$3"
  rm -f "$TMP/m.log"
  G1_THERMAL_SCENARIO="$scen" "$S/collect_metrics.sh" before "$TMP/m.log" >/dev/null 2>&1
  if python3 -c "
lines = [l.strip() for l in open('$TMP/m.log') if '=' in l]
d = dict(l.split('=', 1) for l in lines)
assert d['thermal_before_c'] == '$expect', d
assert d['thermal_units'].startswith('$units'), d
assert d['battery_level'] == '85'
assert d['battery_charge_counter_uah'] == '4820000'
"; then ok "thermal '$scen' -> $expect ($units)"; else bad "thermal '$scen'"; cat "$TMP/m.log" 2>/dev/null; fi
}
run_metrics_case millidegrees 41.25 "celsius, converted from millidegrees"
run_metrics_case plain 41 "celsius, as read"
run_metrics_case empty null "null"

# --- test 3: PSS numeric max ---
rm -rf "$SAND/results/mlc"
MLC_APP_PACKAGE=com.test.mlc MLC_SAMPLES=3 MLC_SAMPLE_SECONDS=0 \
  "$S/run_mlc_bench.sh" > "$TMP/t3.out" 2>&1
MLOG=$(ls "$SAND/results/mlc"/*.metrics.log 2>/dev/null | head -1)
if [ -n "$MLOG" ] && grep -q "peak_pss_kB_max=95000 kB (max of 3 samples)" "$MLOG" \
   && grep -q "logcat_window_start=11-23 16:50:00.000" "$MLOG"; then
  ok "mlc: numeric PSS max parsed with units; timestamp logcat window"
else
  bad "mlc PSS parsing"; cat "$MLOG" 2>/dev/null; cat "$TMP/t3.out"
fi

# --- test 4: llamacpp background run, live VmHWM sampling, exit code ---
rm -rf "$SAND/results/llamacpp"
: > "$TMP/fakebin"; : > "$TMP/fake.gguf"
LLAMA_BENCH_BIN="$TMP/fakebin" MODEL_FILE="$TMP/fake.gguf" G1_SAMPLE_INTERVAL=0 \
  RUN_ID=t4 "$S/run_llamacpp_bench.sh" > "$TMP/t4.out" 2>&1
MLOG=$(ls "$SAND/results/llamacpp"/t4.metrics.log 2>/dev/null | head -1)
if [ -n "$MLOG" ] && grep -q "peak_rss_kb=2000" "$MLOG" && grep -q "exit_code=0" "$MLOG" \
   && [ -s "$SAND/results/llamacpp/t4.raw.txt" ]; then
  ok "llamacpp: live VmHWM peak captured (2000 kB), exit code 0, raw stdout archived"
else
  bad "llamacpp sampling flow"; cat "$MLOG" 2>/dev/null; cat "$TMP/t4.out"
fi

# --- test 5: the mocked adb was never asked to clear device-wide logs ---
if grep -E 'logcat' "$STATE/calls.log" | grep -Eq -- '-c([[:space:]]|$)'; then
  bad "stub observed a device-wide logcat clear"
else
  ok "no device-wide logcat clear across all mocked runs"
fi

echo "== result =="
if [ "$FAIL" -eq 0 ]; then echo "SELFTEST PASS"; exit 0; else echo "SELFTEST FAIL"; exit 1; fi
