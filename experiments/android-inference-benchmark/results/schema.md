# Result record schema

One JSON record per run (one file per run under `results/<runtime>/`), plus
one CSV row per run in `results/runs.csv` with the same flattened fields.
A field that was not measured is `null` with an explanation in `notes` -
never omitted, never estimated.

| Field | Type | Notes |
|---|---|---|
| run_id | string | `<runtime>-<YYYYMMDD-HHMMSS>-<n>` |
| timestamp_utc | string | RFC3339 |
| runtime | string | `llamacpp` or `mlc` |
| runtime_version | string | pinned tag/commit of llama.cpp, or MLC package version |
| runtime_license | string | verified license string + verification date |
| model_id | string | HF repo id of the artifact actually used |
| model_artifact | string | filename |
| model_artifact_sha256 | string | sha256sum of the artifact |
| model_quant | string | e.g. `q4_K_M` / `q4f16_1`; record BOTH runtimes' quant when formats differ |
| model_license | string | from verify-model-license.sh output |
| device_model | string | getprop ro.product.model |
| device_manufacturer | string | getprop ro.product.manufacturer |
| android_api | integer | getprop ro.build.version.sdk |
| abi_list | string | getprop ro.product.cpu.abilist |
| soc_model | string | getprop ro.soc.model |
| soc_manufacturer | string | getprop ro.soc.manufacturer |
| threads | integer | benchmark thread count |
| context_tokens | integer | benchmark context size |
| repeats | integer | number of runs in this record |
| cold_start_ms | number/null | first run load time (llama-bench t_load, first run) |
| warm_start_ms | number/null | median of subsequent load times |
| ttft_ms | number/null | null for llama-bench CLI runs (never estimated); app-phase measurement only |
| prompt_tokens_per_s | number | llama-bench pp, or app-reported |
| prompt_eval_ms | number/null | as reported |
| gen_tokens_per_s | number | llama-bench tg, or app-reported |
| peak_rss_kb | number/null | /proc/<pid>/status VmHWM (CLI runs) |
| peak_pss_kb | number/null | dumpsys meminfo peak sample (app runs) |
| thermal_before_c | number | max zone temp before the run block |
| thermal_after_c | number | max zone temp after the run block |
| thermal_source | string | zones used |
| battery_before_pct | number | dumpsys battery level |
| battery_after_pct | number | dumpsys battery level |
| battery_charge_counter_before | number/null | dumpsys battery ChargeCounter (uAh) |
| battery_charge_counter_after | number/null | same, after |
| crash | boolean | process/app crashed during the run window |
| crash_excerpt | string/null | logcat -b crash excerpt |
| screen_state | string | e.g. "on, fixed brightness, off charger" |
| raw_output_path | string | relative path of the archived raw stdout/logcat |
| notes | string | deviations, anomalies, null-field explanations |
