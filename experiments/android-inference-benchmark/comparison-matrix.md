# Runtime comparison matrix (Gate 1 POC)

Verified 23 Nov 2026 from source APIs; anything not verified is marked
**TO VERIFY (owner run)** with the exact command to check it. This matrix is
the anti-equivalence document: it records where the two runtimes differ
instead of assuming they match.

## Runtimes

| Property | llama.cpp | MLC LLM |
|---|---|---|
| License | MIT (verified via `gh api repos/ggml-org/llama.cpp --jq .license`, 23 Nov 2026) | Apache-2.0 (verified via `gh api repos/mlc-ai/mlc-llm --jq .license`, 23 Nov 2026) |
| Android support (official docs) | Yes: arm64-v8a, NDK CMake build, `examples/llama.android` app; docs/build.md Android section (owner-verified 23 Nov 2026) | Yes: official Android SDK path requires Android Studio + NDK + CMake + Rust; GPU path needs the physical phone, not an emulator (owner-verified 23 Nov 2026 from https://llm.mlc.ai/docs/deploy/android) |
| On-device measurement path | `llama-bench` CLI binary pushed to the device via adb (no app needed) | MLC Android app (built per official docs); logcat + dumpsys capture |
| Weight format | GGUF | MLC-converted weights (MLC format) |
| Byte-identical shared model | Generally NOT possible (format conversion) - fairness rule 1 in README applies | Same |
| Host toolchain for build | cmake + Android NDK | Android Studio + NDK + CMake + Rust |
| GPU acceleration on 12R (Adreno) | TO VERIFY (owner run): llama.cpp upstream has Vulkan/OpenCL backends; whether they are enabled/beneficial in this build is measured, not assumed | TO VERIFY (owner run): MLC uses TVM-based GPU codegen; official demo devices listed (Samsung S23 Snapdragon 8 Gen 2, Redmi Note 12 Pro, Pixel) - the 12R's exact SoC is read from getprop during the run, never asserted |
| Emulator viability | CPU-only CLI bench: partially viable (not a Gate 1 substitute) | Not viable per official docs (physical GPU required) |

## Candidate models (license verified via HF model-card API, 23 Nov 2026)

| Model | HF license | llama.cpp GGUF availability | MLC prebuilt weights | Verdict |
|---|---|---|---|---|
| Qwen/Qwen2.5-0.5B-Instruct | Apache-2.0 (verified) | TO VERIFY: check the official GGUF repo and ITS license at run time (`huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF` tree; conversion repos can carry different licenses) | TO VERIFY: MLC prebuilt weight list for qwen2 family, 0.5B | candidate |
| HuggingFaceTB/SmolLM2-360M-Instruct | Apache-2.0 (verified) | TO VERIFY (same procedure) | TO VERIFY (same procedure) | candidate |
| HuggingFaceTB/SmolLM2-135M-Instruct | Apache-2.0 (verified) | TO VERIFY (same procedure) | TO VERIFY (same procedure) | fallback (smallest) |

Selection rule: prefer the largest candidate supported by BOTH runtimes with
a clean, verified license on both artifacts. If no candidate is supported by
both, benchmark each runtime's best supported candidate and label the
comparison explicitly (fairness rule 2). A 1B+ model (e.g. Llama, Gemma
families) is NOT in the shortlist: their licenses carry additional terms the
project owner must review separately before any consideration.
