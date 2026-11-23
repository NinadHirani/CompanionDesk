#!/usr/bin/env bash
# Gate 1 scaffold self-test (no device needed, runs on macOS/Linux CI).
# 1) bash -n on every script; 2) shellcheck when installed (skipped
# otherwise, documented limitation); 3) static checks (no device-wide
# logcat clears, no weight downloads in capture scripts); 4) parser/flow
# tests against a mocked adb, run inside a TEMP COPY of this directory so
# the real repo tree is never written to. These tests verify the SCRIPTS,
# not any device: no device measurement is claimed anywhere.
# shellcheck disable=SC2012  # ls -t | head over timestamp-named files is deliberate
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
  *bench.pid*) printf '1234' ;;
  *date*) printf '11-23 16:50:00.000' ;;
  *push*) echo 'pushed' ;;
  *mkdir*) : ;;
  *logcat*) echo 'logcat-window-content' ;;
  *) echo "UNMATCHED adb call: $*" >&2; exit 9 ;;
esac
STUB
chmod +x "$TMP/mockbin/adb"
export PATH="$TMP/mockbin:$PATH"

cat > "$TMP/mockbin/curl" <<'CURLSTUB'
#!/usr/bin/env bash
STATE="${G1_TEST_STATE:?}"
printf '%s\n' "curl $*" >> "$STATE/calls.log"
out=""; prev=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then out="$a"; fi
  prev="$a"
done
printf '%s\n' '{"cardData":{"license":"apache-2.0"},"tags":["license:apache-2.0"],"gated":"manual","id":"ok/org-name_model.v2"}' > "${out:-/dev/stdout}"
CURLSTUB
chmod +x "$TMP/mockbin/curl"

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
MLC_APP_PACKAGE=com.test.mlc MLC_SAMPLES=3 MLC_SAMPLE_SECONDS=0.1 \
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
LLAMA_BENCH_BIN="$TMP/fakebin" MODEL_FILE="$TMP/fake.gguf" G1_SAMPLE_INTERVAL=0.05 \
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

echo "== malicious input refusal (no adb/curl call, no file written) =="
assert_refused() {
  local name="$1"; shift
  local calls_before calls_after rc files_before files_after
  calls_before=$(wc -l < "$STATE/calls.log" 2>/dev/null || echo 0)
  files_before=$(find "$SAND" -type f 2>/dev/null | wc -l | tr -d ' ')
  "$@" >"$TMP/rej.out" 2>&1
  rc=$?
  calls_after=$(wc -l < "$STATE/calls.log" 2>/dev/null || echo 0)
  files_after=$(find "$SAND" -type f 2>/dev/null | wc -l | tr -d ' ')
  if [ "$rc" -eq 0 ]; then bad "$name: exited 0, expected refusal"; return 1; fi
  if [ "$calls_after" != "$calls_before" ]; then bad "$name: an external call was made despite refusal"; return 1; fi
  if [ "$files_after" != "$files_before" ]; then bad "$name: a file was written despite refusal"; return 1; fi
  if ! grep -q "refusing" "$TMP/rej.out"; then bad "$name: no refusal reason printed"; echo "--- captured output ---"; cat "$TMP/rej.out"; echo "--- end ---"; return 1; fi
  ok "$name refused (no calls, no files, reason printed)"
}

: > "$TMP/fakebin2"; : > "$TMP/fake.gguf2"
: > "$TMP/mal;semi.gguf"; : > "$TMP/mal name.gguf"; : > "$TMP/.dotlead.gguf"

# llamacpp: RUN_ID must be an allowlisted token (no traversal, slash, newline, metachars)
assert_refused "llamacpp RUN_ID traversal"     env RUN_ID='../evil'   LLAMA_BENCH_BIN="$TMP/fakebin2" MODEL_FILE="$TMP/fake.gguf2" "$S/run_llamacpp_bench.sh"
assert_refused "llamacpp RUN_ID slash"         env RUN_ID='sub/dir'   LLAMA_BENCH_BIN="$TMP/fakebin2" MODEL_FILE="$TMP/fake.gguf2" "$S/run_llamacpp_bench.sh"
assert_refused "llamacpp RUN_ID newline"       env RUN_ID=$'x\ny'    LLAMA_BENCH_BIN="$TMP/fakebin2" MODEL_FILE="$TMP/fake.gguf2" "$S/run_llamacpp_bench.sh"
assert_refused "llamacpp RUN_ID metachars"     env RUN_ID='x;touch x' LLAMA_BENCH_BIN="$TMP/fakebin2" MODEL_FILE="$TMP/fake.gguf2" "$S/run_llamacpp_bench.sh"
assert_refused "llamacpp RUN_ID quote"         env RUN_ID="x'y"       LLAMA_BENCH_BIN="$TMP/fakebin2" MODEL_FILE="$TMP/fake.gguf2" "$S/run_llamacpp_bench.sh"
assert_refused "llamacpp RUN_ID dotfile"       env RUN_ID='.hidden'   LLAMA_BENCH_BIN="$TMP/fakebin2" MODEL_FILE="$TMP/fake.gguf2" "$S/run_llamacpp_bench.sh"
# llamacpp: model basename allowlist (device path is built from it)
assert_refused "llamacpp model basename semi"  env LLAMA_BENCH_BIN="$TMP/fakebin2" MODEL_FILE="$TMP/mal;semi.gguf" "$S/run_llamacpp_bench.sh"
assert_refused "llamacpp model basename space" env LLAMA_BENCH_BIN="$TMP/fakebin2" MODEL_FILE="$TMP/mal name.gguf" "$S/run_llamacpp_bench.sh"
assert_refused "llamacpp model basename dot"   env LLAMA_BENCH_BIN="$TMP/fakebin2" MODEL_FILE="$TMP/.dotlead.gguf" "$S/run_llamacpp_bench.sh"
# llamacpp: numeric bounds
assert_refused "llamacpp interval zero"        env RUN_ID=v6a G1_SAMPLE_INTERVAL=0    LLAMA_BENCH_BIN="$TMP/fakebin2" MODEL_FILE="$TMP/fake.gguf2" "$S/run_llamacpp_bench.sh"
assert_refused "llamacpp interval negative"    env G1_SAMPLE_INTERVAL=-1 LLAMA_BENCH_BIN="$TMP/fakebin2" MODEL_FILE="$TMP/fake.gguf2" "$S/run_llamacpp_bench.sh"
assert_refused "llamacpp interval scientific"  env G1_SAMPLE_INTERVAL=1e3 LLAMA_BENCH_BIN="$TMP/fakebin2" MODEL_FILE="$TMP/fake.gguf2" "$S/run_llamacpp_bench.sh"
assert_refused "llamacpp interval garbage"     env G1_SAMPLE_INTERVAL=abc LLAMA_BENCH_BIN="$TMP/fakebin2" MODEL_FILE="$TMP/fake.gguf2" "$S/run_llamacpp_bench.sh"
assert_refused "llamacpp interval hex"         env G1_SAMPLE_INTERVAL=0x10 LLAMA_BENCH_BIN="$TMP/fakebin2" MODEL_FILE="$TMP/fake.gguf2" "$S/run_llamacpp_bench.sh"
assert_refused "llamacpp interval over bound"  env G1_SAMPLE_INTERVAL=100 LLAMA_BENCH_BIN="$TMP/fakebin2" MODEL_FILE="$TMP/fake.gguf2" "$S/run_llamacpp_bench.sh"
assert_refused "llamacpp maxsec zero"          env G1_MAX_SECONDS=0 LLAMA_BENCH_BIN="$TMP/fakebin2" MODEL_FILE="$TMP/fake.gguf2" "$S/run_llamacpp_bench.sh"
assert_refused "llamacpp maxsec fractional"    env G1_MAX_SECONDS=1.5 LLAMA_BENCH_BIN="$TMP/fakebin2" MODEL_FILE="$TMP/fake.gguf2" "$S/run_llamacpp_bench.sh"
assert_refused "llamacpp maxsec garbage"       env G1_MAX_SECONDS=abc LLAMA_BENCH_BIN="$TMP/fakebin2" MODEL_FILE="$TMP/fake.gguf2" "$S/run_llamacpp_bench.sh"
assert_refused "llamacpp maxsec over bound"    env G1_MAX_SECONDS=999999999 LLAMA_BENCH_BIN="$TMP/fakebin2" MODEL_FILE="$TMP/fake.gguf2" "$S/run_llamacpp_bench.sh"
# mlc: package-name syntax
assert_refused "mlc package dash"              env MLC_APP_PACKAGE='com.Bad-Pkg' "$S/run_mlc_bench.sh"
assert_refused "mlc package digit-led segment" env MLC_APP_PACKAGE='1abc.def' "$S/run_mlc_bench.sh"
assert_refused "mlc package empty segment"     env MLC_APP_PACKAGE='com..pkg' "$S/run_mlc_bench.sh"
assert_refused "mlc package metachars"         env MLC_APP_PACKAGE='com.pkg;id' "$S/run_mlc_bench.sh"
assert_refused "mlc package space"             env MLC_APP_PACKAGE='com.pkg id' "$S/run_mlc_bench.sh"
# mlc: RUN_ID allowlist
assert_refused "mlc RUN_ID traversal"          env MLC_APP_PACKAGE=com.test.mlc RUN_ID='../evil' "$S/run_mlc_bench.sh"
assert_refused "mlc RUN_ID slash"              env MLC_APP_PACKAGE=com.test.mlc RUN_ID='sub/dir' "$S/run_mlc_bench.sh"
assert_refused "mlc RUN_ID newline"            env MLC_APP_PACKAGE=com.test.mlc RUN_ID=$'x\ny' "$S/run_mlc_bench.sh"
assert_refused "mlc RUN_ID metachars"          env MLC_APP_PACKAGE=com.test.mlc RUN_ID='x;y' "$S/run_mlc_bench.sh"
# mlc: numeric bounds
assert_refused "mlc samples zero"              env MLC_APP_PACKAGE=com.test.mlc MLC_SAMPLES=0 "$S/run_mlc_bench.sh"
assert_refused "mlc samples garbage"           env MLC_APP_PACKAGE=com.test.mlc MLC_SAMPLES=abc "$S/run_mlc_bench.sh"
assert_refused "mlc samples over bound"        env MLC_APP_PACKAGE=com.test.mlc MLC_SAMPLES=1001 "$S/run_mlc_bench.sh"
assert_refused "mlc interval zero"             env MLC_APP_PACKAGE=com.test.mlc MLC_SAMPLE_SECONDS=0 "$S/run_mlc_bench.sh"
assert_refused "mlc interval garbage"          env MLC_APP_PACKAGE=com.test.mlc MLC_SAMPLE_SECONDS=abc "$S/run_mlc_bench.sh"
# collect_metrics: label and out path
assert_refused "metrics label wrong case"      "$S/collect_metrics.sh" BEFORE /tmp/g1-x.log
assert_refused "metrics label unknown"         "$S/collect_metrics.sh" evil /tmp/g1-x.log
assert_refused "metrics out relative"          "$S/collect_metrics.sh" before x.log
assert_refused "metrics out traversal"         "$S/collect_metrics.sh" before ../g1-x.log
assert_refused "metrics out control char"      "$S/collect_metrics.sh" before "$TMP/..$(printf '\n')x.log"
# verify-model-license: MODEL_ID allowlist before any network call
assert_refused "license id no slash"           bash "$S/verify-model-license.sh" no-slash-id
assert_refused "license id traversal"          bash "$S/verify-model-license.sh" ../etc/passwd
assert_refused "license id two slashes"        bash "$S/verify-model-license.sh" a/b/c
assert_refused "license id space"              bash "$S/verify-model-license.sh" 'org/na me'
assert_refused "license id metachars"          bash "$S/verify-model-license.sh" "org/n';touch x"
assert_refused "license id empty segment"      bash "$S/verify-model-license.sh" org/

# positive controls: allowlisted values still work
if RUN_ID=ok-1.2_3 LLAMA_BENCH_BIN="$TMP/fakebin2" MODEL_FILE="$TMP/fake.gguf2" G1_SAMPLE_INTERVAL=0.05 \
     "$S/run_llamacpp_bench.sh" >"$TMP/pos1.out" 2>&1 \
   && [ -s "$SAND/results/llamacpp/ok-1.2_3.raw.txt" ]; then
  ok "llamacpp positive control: allowlisted RUN_ID runs to completion"
else
  bad "llamacpp positive control"; cat "$TMP/pos1.out"
fi
if bash "$S/verify-model-license.sh" 'org/name.v2_1-x' >"$TMP/pos2.out" 2>&1 \
   && grep -q "cardData.license : apache-2.0" "$TMP/pos2.out"; then
  ok "license positive control: allowlisted id reaches (mocked) HF and reports the license"
else
  bad "license positive control"; cat "$TMP/pos2.out" 2>/dev/null
fi

echo "== comparison assembler (repo-only, no adb) =="
mkdir -p "$SAND/results/llamacpp" "$SAND/results/mlc"
cat > "$SAND/results/llamacpp/r1.metrics.log" <<'FIX'
label=before
battery_level=85
battery_charge_counter_uah=4820000
thermal_before_c=41.25
---
label=after
battery_level=83
thermal_after_c=44.10
---
run_id=r1
exit_code=0
peak_rss_kb=2000
peak_rss_source=/proc/<pid>/status VmHWM, sampled live while the benchmark ran
crash_lines=0
FIX
cat > "$SAND/results/mlc/m1.metrics.log" <<'FIX'
label=before
battery_level=85
thermal_before_c=40.9
---
label=after
battery_level=81
thermal_after_c=42.3
---
run_id=m1
peak_pss_kB_max=95000 kB (max of 3 samples)
crash_excerpt: none
FIX
cat > "$TMP/checkasm.py" <<'CHKPY'
import sys
text = open(sys.argv[1]).read()
assert "no device measurement is claimed" in text.lower()
r1 = "| r1 | 0 | 2000 | null | 85 | 41.25 | 44.10 | llamacpp |"
m1 = "| m1 | null | null | 95000 kB (max of 3 samples) | 85 | 40.9 | 42.3 | mlc |"
assert r1 in text, r1
assert m1 in text, m1
print("ok")
CHKPY
calls_before=$(wc -l < "$STATE/calls.log" 2>/dev/null || echo 0)
"$S/assemble_comparison.py" --results "$SAND/results" --out "$SAND/results/comparison.auto.md" > "$TMP/asm2.out" 2>&1
asm_rc=$?
calls_after=$(wc -l < "$STATE/calls.log" 2>/dev/null || echo 0)
if [ "$asm_rc" -eq 0 ] && python3 "$TMP/checkasm.py" "$SAND/results/comparison.auto.md" >/dev/null 2>&1 && [ "$calls_after" = "$calls_before" ]; then
  ok "comparison assembler: fixtures assembled verbatim, missing values null, no adb call"
else
  bad "comparison assembler"; cat "$TMP/asm2.out" 2>/dev/null; python3 "$TMP/checkasm.py" "$SAND/results/comparison.auto.md" 2>&1 | head -3
fi
"$S/assemble_comparison.py" --results "$TMP/empty-results" --out "$TMP/empty-cmp.md" >/dev/null 2>&1
if [ $? -eq 0 ] && grep -q "No run outputs found yet" "$TMP/empty-cmp.md"; then
  ok "comparison assembler: empty results render the no-runs note"
else
  bad "comparison assembler empty case"
fi
if grep -nE "import (requests|urllib|socket|http)" "$S/assemble_comparison.py" >/dev/null; then
  bad "assembler must not use network libraries"
else
  ok "comparison assembler: no network libraries"
fi

echo "== result =="
if [ "$FAIL" -eq 0 ]; then echo "SELFTEST PASS"; exit 0; else echo "SELFTEST FAIL"; exit 1; fi
