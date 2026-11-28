# Gate 1 benchmark POC - Android on-device inference (llama.cpp vs MLC)

**STATUS: UNVERIFIED SCAFFOLD. No device run has happened. Nothing in this
directory is a measurement.** Results exist only after the OnePlus 12R owner
executes the runbook below and commits the recorded outputs.

**NON-PRODUCTION.** This experiment is deliberately outside the production
app. No production source file is touched by this scaffold. Gate 1 decisions
may cite only the recorded results under `results/`, never these scripts'
expectations.

## Purpose

Produce measured numbers (tokens/s, memory, thermals, battery, stability) for
two candidate Android inference runtimes on the OnePlus 12R, so the Android
local-inference architecture is decided from data, not expectation. Per the
roadmap, no Android AI architecture is committed until these numbers exist.

## Fairness rules (read before running anything)

1. **Same exact model for both runtimes only when both support it.** The two
   runtimes use different weight formats (GGUF vs MLC-converted), so a
   byte-identical artifact is generally not possible. Where formats differ,
   use the same base model repo and the closest equivalent quantization and
   record BOTH artifacts (`model_id`, `model_quant`, sha256) in every result
   row. Never present different models as equivalent.
2. **If a candidate model is unsupported by one runtime, document the gap** in
   `comparison-matrix.md` and benchmark each runtime's best supported
   candidate, clearly labeled. Do not fake equivalence.
3. **Licenses are verified, never inferred.** Before any model download, run
   `scripts/verify-model-license.sh <org/model-id>` and archive its output
   under `results/`. Runtime licenses were verified 23 Nov 2026 via the
   GitHub API (see `comparison-matrix.md`) and the re-verify commands are in
   that file.

## Model policy (hard rules)

- **No script downloads model weights. Ever.** Weight downloads happen only
  as manual commands run by the device owner after they see the verified
  license and explicitly approve.
- **No weights in the repo.** `models/` and all weight/build artifacts are
  gitignored. Check `git status` before committing; nothing over ~1 MB goes
  in from this directory.
- Model shortlist (licenses verified via the HF model-card API on 23 Nov
  2026, all Apache-2.0, not gated; re-verify before use):
  - `Qwen/Qwen2.5-0.5B-Instruct` (Apache-2.0)
  - `HuggingFaceTB/SmolLM2-360M-Instruct` (Apache-2.0)
  - `HuggingFaceTB/SmolLM2-135M-Instruct` (Apache-2.0)
  The exact GGUF repo (llama.cpp) and MLC-converted weights source must be
  verified at run time per model; see `comparison-matrix.md`.

## Metrics and how each is captured

| Field | Capture |
|---|---|
| model_id / license / quant / sha256 | the artifact files themselves (`sha256sum`), license from `verify-model-license.sh` |
| cold start | first benchmark run after pushing the binary/model (llama-bench `t_load` on first run; approximate - noted in results) |
| warm start | subsequent runs' `t_load` |
| time-to-first-token | NOT measured by llama-bench; recorded as `null` for CLI runs. Precise TTFT is an optional Phase B app measurement. Never fill it with an estimate. |
| prompt tokens/s, generation tokens/s | llama-bench `pp` / `tg` columns directly |
| peak RSS | `/proc/<pid>/status` VmHWM, live-sampled while the benchmark runs in the background on the device. The pid comes from a device-side pid file written as `$!` of the backgrounded llama-bench itself (never pidof, which could match an unrelated process). `null` only when sampling never observed the process, noted in `notes` |
| peak PSS | `dumpsys meminfo` sampling while an app runtime runs (null for CLI runs) |
| thermal before/after | max zone temperature in Celsius, recorded before and after each run block. A zone value >= 1000 is treated as millidegrees and converted (the `thermal_units` field records the conversion); the raw value and source zone are always recorded too; `null` when no zone is readable |
| battery before/after | `dumpsys battery` level + charge counter, before and after each run block; screen state and brightness fixed |
| crashes | process exit code + a timestamp-windowed `adb logcat -d -b crash -T <start>` excerpt. Scripts never clear device-wide logs (`logcat -c` is not used anywhere) |
| device / API / ABI / SoC | `getprop` via `scripts/collect_device_info.sh` |

## Input validation (review, 23 Nov 2026)

Every env/string input is strict-allowlisted BEFORE any adb call or network
call; a refused value exits 2 with a reason and touches nothing.

- run_llamacpp_bench.sh: the model's final filename component and RUN_ID must
  match the anchored ERE `^[A-Za-z0-9][A-Za-z0-9._-]*$`; G1_SAMPLE_INTERVAL is
  a plain number with 0 < interval <= 60; G1_MAX_SECONDS an integer 1..86400;
  the device-sourced PID must be purely numeric before it is used in /proc
  paths or the kill command. Host paths are still refused on space/quote.
- run_mlc_bench.sh: MLC_APP_PACKAGE must be Android package syntax (segments
  matching `[A-Za-z][A-Za-z0-9_]*` joined by dots, at most 200 chars); RUN_ID
  the same anchored ERE; MLC_SAMPLES an integer 1..1000; MLC_SAMPLE_SECONDS a
  number 0 < s <= 3600.
- verify-model-license.sh: MODEL_ID must be exactly org/name with both
  segments matching `[A-Za-z0-9][A-Za-z0-9._-]*`; a refused id never touches
  the network. The manual download flow is unchanged and still owner-gated.
- collect_metrics.sh: the label must be exactly `before` or `after`; the
  caller-supplied out path must be absolute with no `..` or control
  characters; the script only ever appends.

Implementation note: the allowlists are anchored `[[ =~ ]]` checks, not
`case` globs. A `case`-glob allowlist of the same shape was found to accept
`sub/dir` and `mal;semi.gguf` while rejecting `x'y` (glob semantics are not
full-string anchored), so it was replaced; do not reintroduce `case`-glob
allowlists here.

The mocked-adb selftest covers 33 malicious-input cases (path traversal,
slashes, newlines, shell metacharacters, invalid and out-of-bound numbers,
wrong labels, bad package and model ids). Each must exit non-zero, print a
reason, and produce NO adb/curl call and NO file anywhere in the tree.
Positive controls prove allowlisted values still run: RUN_ID `ok-1.2_3`
completes under the mocked adb and `org/name.v2_1-x` reaches the mocked HF
endpoint and reports its license.

## Results assembly (repo-only, runs anywhere)

`scripts/assemble_comparison.py` reads whatever `*.metrics.log` files the two
drivers have already written under `results/llamacpp/` and `results/mlc/` and
renders `results/comparison.auto.md` with one row per run. It claims nothing
about any device: an empty table means no runs exist yet, every value is
carried verbatim from the run's own log, and missing values stay null. It
makes no adb calls and no network calls (the selftest proves both, and
asserts it imports no network libraries).

## Results validation (repo-only, runs anywhere)

`scripts/validate_results.py` checks collected result records against
`results/schema.md` before they can enter a Gate 1 decision: every documented
field must be present (a field is never omitted), types are enforced strictly
(integers are integers, booleans are booleans, never 0/1 standing in for
true/false), `runtime` is the documented enum, `run_id` and `timestamp_utc`
must match their documented shapes, a nullable field may be `null` only when
`notes` explains why (the schema's own rule), and unknown fields are refused.
Usage: `python3 scripts/validate_results.py FILE [FILE...]` or
`python3 scripts/validate_results.py --dir results/`. It reads only the files
it is given, writes nothing, and makes no adb or network calls. The selftest
covers a valid record, six refusal cases each naming the offending field,
directory mode, and a two-way sync guard asserting the validator's field
table and `results/schema.md` stay identical, so the schema cannot drift
silently.

## Acceptance criteria (Gate 1 data is valid only when ALL hold)

1. Both runtimes measured on the OnePlus 12R with full device metadata, OR a
   specific documented reason in `comparison-matrix.md` (e.g. a runtime
   unsupported on this device). Never silent.
2. Model identity recorded per rule 1 above; any deviation stated in the
   results and matrix.
3. Every result record contains every schema field (see
   `results/schema.md`); a field that was not measured is `null` with a
   note in `notes`, never omitted.
4. Raw benchmark stdout archived per run (`results/<runtime>/<ts>.raw.txt`)
   next to the parsed record.
5. A crash is a recorded result (exit code + logcat excerpt), not a silent
   retry.
6. No weights or large binaries in the repo (rule above, checked before each
   commit).
7. License verification output for the chosen model archived under
   `results/`.
8. The Gate 1 decision paragraph is written only after at least 3 repeat
   runs per runtime per configuration, medians reported, raw outputs kept.

## Runbook (owner-executed; Mac M1 host + OnePlus 12R)

All commands run on the Mac unless marked `(device)`. Nothing here uploads
anything anywhere; every script writes only inside this directory (and
`/tmp`).

**Phase 0 - host and device prep.**

1. Install Android SDK platform-tools (adb) and the NDK on the Mac
   (`brew install --cask android-platform-tools`, and the NDK via Android
   Studio or `sdkmanager`).
2. On the phone: enable Developer options and USB debugging.
3. Connect USB, confirm `adb devices` lists the 12R, and run
   `scripts/collect_device_info.sh` once to record the baseline row.

**Phase 1 - llama.cpp build (host).**

1. Clone llama.cpp at a pinned tag (record the tag in every result row) and
   verify its license:
   `gh api repos/ggml-org/llama.cpp --jq .license` (expected MIT; verified
   23 Nov 2026).
2. Build for arm64-v8a per the official Android instructions
   (https://github.com/ggml-org/llama.cpp/blob/master/docs/build.md):
   ```
   cmake -B build-android-arm64 \
     -DCMAKE_TOOLCHAIN_FILE=$NDK/build/cmake/android.toolchain.cmake \
     -DANDROID_PLATFORM=android-28 -DANDROID_ABI=arm64-v8a \
     -DCMAKE_BUILD_TYPE=Release
   cmake --build build-android-arm64 --config Release -j
   ```
3. Verify the produced binary list includes `llama-bench`.

**Phase 2 - model (owner-approved download).**

1. `scripts/verify-model-license.sh <chosen-model-id>` - read the output.
2. Download the chosen artifact MANUALLY into `models/` (gitignored), e.g.
   `huggingface-cli download <repo> <file> --local-dir models/`. Only after
   explicit approval of the license shown in step 1.
3. Record `sha256sum models/<file>`.

**Phase 3 - llama.cpp on-device run.**

1. `adb push` the `llama-bench` binary and the model to
   `/data/local/tmp/` (device).
2. Capture battery/thermal before; run
   `scripts/run_llamacpp_bench.sh` (it drives adb, fixes threads/prompt/gen
   lengths, repeats, and captures raw output + VmHWM); capture battery/
   thermal after. Screen on, fixed brightness, no other apps, device off
   charger during the run block.

**Phase 4 - MLC on-device run.**

1. Build the MLC Android app per the official docs
   (https://llm.mlc.ai/docs/deploy/android): requires Android Studio + NDK
   + CMake + Rust on the host and the physical phone (MLC's GPU path cannot
   be meaningfully tested in an emulator). Verify the mlc-llm license the
   same way (`gh api repos/mlc-ai/mlc-llm --jq .license`; expected
   Apache-2.0, verified 23 Nov 2026).
2. Model weights: prebuilt MLC weights if available for the chosen model,
   else `mlc_llm convert_weight` on the Mac per official docs - again a
   manual, owner-approved download/step; nothing scripted.
3. Install the app on the 12R, run the model, and run
   `scripts/run_mlc_bench.sh` to capture battery/thermal before/after,
   PSS sampling, and the app's benchmark logcat for the run window.

**Phase 5 - record.** Convert raw outputs to the schema
(`results/schema.md`), fill one JSON record + one CSV row per run, commit
results (small files only) and any comparison-matrix updates.

**Phase 6 - decide.** Write the Gate 1 decision summary (medians, anomalies,
crashes, thermal behavior) into `results/RESULTS.md`, then the roadmap Gate 1
section cites it. No architecture commitment happens before that.

## Limitations (read before trusting anything here)

- These scripts are verified ONLY by the mocked-adb self-test
  (`scripts/selftest.sh`, a mandatory part of `npm test`, so every CI
  workflow runs it) and syntax checks. That proves the capture and parsing
  logic, not that any real device produced real numbers.
- shellcheck runs only when it is installed; it was not available at
  scaffold time, which the self-test records as a skipped step.
- No device run has happened. Every output this scaffold will ever produce
  is UNVERIFIED until the owner executes the runbook on the OnePlus 12R and
  commits the recorded results.

## Out of scope for this scaffold

- Any production app change, any Capacitor plugin, any release.
- Model downloads, weight hosting, or any large binary in the repo.
- Any network upload of results: results stay local and are committed as
  plain files by the owner.
