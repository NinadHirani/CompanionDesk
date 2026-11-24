# Wake-word training verification memo (third-party centre + training path)

Docs-only verification research, 24 Nov 2026, 10:25-10:50 PM IST.
Primary/official sources only; every claim below carries its source link
and what was actually read. No downloads, no dataset acquisition, no code
changes, no training run, no activation, and no wake-phrase choice: this
memo records evidence only. Wake word stays disabled and the feature
stays gated, exactly as before.

## Scope

The two items left undecided in docs/M6_VOICE_DECISIONS.md that this
research feeds: (1) the third-party training centre's actual terms and
data handling, (2) the self-training path's licensing chain and dataset
provenance. Our current wake-word implementation (scripts/wake/,
docs/WAKE_PROVENANCE.md) is the self-training path, so the centre's
terms are evaluated against it as an alternative, not a dependency.

## Finding 1 (MATERIAL, corrects an earlier recorded assumption): the
third-party training centre's default outputs are NON-COMMERCIAL

openwakeword.com/train ("the Service") Terms & Conditions, last updated
February 2025, Section 5 "Model Ownership & Licensing", read this run
via a rendered-page capture of https://openwakeword.com/terms:

> "Wake word models generated through the Service are licensed for
> personal and non-commercial use only by default. You may not use them
> in commercial products, services, or applications without a
> commercial license (see below)."

Consequence for CompanionDesk: the app is Ninad's product and may be
commercialized, so centre-generated models are NOT usable by default.
Commercial use of centre outputs requires their paid commercial license
(Terms Section 5 callout: "View tiers, FAQ, and request a quote on the
Commercial License page, or email dev@openwakeword.com"), which is a
paid service and therefore blocked by Ninad's standing rule unless he
explicitly approves it. The earlier note that the centre "claims
Apache-2.0-licensed outputs" is superseded by this reading of the terms
themselves: I found no primary source this run claiming Apache-2.0 for
outputs, and the terms say the opposite by default.

Also read from the same terms page, quoted exactly:
- Section 4: "Generated audio samples may be stored temporarily on our
  servers during training and may be deleted after job completion."
  ("may be deleted" is not a deletion guarantee; a privacy consideration
  if the centre were ever used.)
- Section 5 (Piper voices): "Piper voice models (custom text-to-speech
  voices trained or fine-tuned through the Voice Center, together with
  any audio they generate) are licensed for personal and non-commercial
  use only, and no commercial license is offered for them." Note: our
  pipeline uses Piper voices as TRAINING DATA, not Voice Center
  outputs; this clause covers only centre-generated voices.
- Section 3: credits "purchased via Stripe ... non-refundable and
  non-transferable".
- Section 1: "The Service is operated by an independent developer and
  is provided on an 'as is' basis." No legal entity is named anywhere I
  could read; contact is only dev@openwakeword.com.
- Site footer (https://openwakeword.com/train): "openwakeword.com is an
  independent training service. It is not affiliated with the
  open-source openWakeWord project or its author, David Scripka."

## Finding 2: the self-training path's chain is verified permissively,
with named residuals

Per-claim citations (all read this run, 24 Nov 2026):

| # | Claim | Source (primary) | Verdict |
| - | ----- | ---------------- | ------- |
| 1 | openWakeWord repo CODE is Apache-2.0 | LICENSE file, raw.githubusercontent.com/dscripka/openWakeWord/main/LICENSE (full Apache-2.0 text read); README License section: "All of the code in this repository is licensed under the Apache 2.0 license." | VERIFIED |
| 2 | ALL included pretrained wake-word models are CC BY-NC-SA 4.0 "due to the inclusion of datasets with unknown or restrictive licensing as part of the training data" | README License section (same raw file) | VERIFIED; confirms the earlier refusal: not shippable |
| 3 | The shared feature extractor is a re-implementation of Google's speech_embedding TFHub module, "provided by Google as a TFHub module under an Apache-2.0 license" | README Model Architecture section (same raw file); our own conversion chain documented in docs/WAKE_PROVENANCE.md | VERIFIED as a basis; our implementation ships OUR converted artifact, not upstream's (upstream's shipped ONNX files stay refused; issues #338/#346/#348/#357 still open) |
| 4 | Upstream's example synthetic-data generator (dscripka/synthetic_speech_dataset_generation): generate_clips.py Apache-2.0; uses NVIDIA WaveGlow and VITS; "The included TTS models (and the associated code from the source repos) have their own licenses, and you are strongly encouraged to review the original repositories" | Repo README, raw.githubusercontent.com/dscripka/synthetic_speech_dataset_generation/main/README.md | VERIFIED (and it delegates the hard question to the user) |
| 5 | WaveGlow code is BSD 3-Clause (NVIDIA Corp, 2018); VITS code is MIT (Jaehyon Kim, 2021) | raw LICENSE/README files of both repos, read this run | VERIFIED for CODE; the pretrained CHECKPOINTS' license terms are not stated in what I read (see unknowns) |
| 6 | LibriTTS corpus is CC BY 4.0 | www.openslr.org/60/ ("License: CC BY 4.0") | VERIFIED |
| 7 | VCTK corpus license | datashare.ed.ac.uk/handle/10283/3443 returned no readable text this run | UNVERIFIED this run; not needed by our pipeline (see #9) |
| 8 | Included openWakeWord models were trained with ~30,000 hours of third-party negative data (speech/noise/music) | README Training New Models section | VERIFIED; this is the provenance surface that forced the NC license, and the reason we do not copy that recipe |
| 9 | OUR pipeline uses NO third-party speech dataset: positives from license-verified Piper voices, negatives from other verified voices reading common words plus synthetic noise and silence | scripts/wake/generate_training_data.py header: "No third-party speech dataset is used at all, so no dataset license question can arise"; the script hard-refuses any voice not recorded as license-verified (ensure_voice_verified) | VERIFIED in code; one voice verified so far (en_US-amy-medium, CC BY-SA 4.0 chain, recorded in docs/WAKE_PROVENANCE.md), other candidates refused |

## Verified / unknown / residual risk

VERIFIED this run from primary sources: repo code Apache-2.0 (#1);
included models non-commercial (#2); centre outputs non-commercial by
default (Finding 1); centre is unaffiliated and unnamed (#Finding 1);
our pipeline's no-third-party-dataset design and per-voice gate (#9);
toolchain licenses already recorded in docs/WAKE_PROVENANCE.md.

UNKNOWN / not readable this run:
- The centre's Terms sections after Section 7 (the rendered page fades
  and the capture cut at Section 7); no privacy policy text was
  readable; the "Commercial License" page's tier contents did not
  render at https://openwakeword.com/commercial-license (it returned
  the homepage). If the centre path is ever wanted, its full terms and
  the commercial tiers must be read first, in a signed-in session if
  needed.
- The pretrained WaveGlow/VITS checkpoint files' own license terms
  (upstream's download_tts_models.py pulls them from a Backblaze bucket
  without stated weights licensing). Relevant only to the upstream
  example pipeline, which our pipeline does not use.
- VCTK's license (#7). Irrelevant to our pipeline but listed for
  completeness since upstream's VITS checkpoint is VCTK-trained.
- The centre's runtime/data-retention behavior behind the sign-in gate
  (models saved "to your personal library" per the gate page).

RESIDUAL RISKS even for the self-training path (unchanged and gated):
1. Feature-extractor ambiguity: upstream's shipped embedding ONNX is
   contested (open issues); we ship our own conversion of Google's
   Apache-2.0 module instead, per WAKE_PROVENANCE.md, and that artifact
   must carry its checksum and provenance in any release.
2. Per-voice licensing is a standing obligation: every future Piper
   voice must be verified from its own model card before use; the
   script enforces this mechanically.
3. Technical performance (false-accept/false-reject in real rooms,
   on-device latency on M1 and Android) is UNVALIDATED: nothing has run
   on a device; wake stays default-off pending that validation.
4. The centre's terms are "Last updated: February 2025" and can change;
   this memo's quotes are point-in-time reads of 24 Nov 2026.

## Conclusion

- The third-party centre path is CLOSED for CompanionDesk by default:
  its outputs are non-commercial, and the only route to commercial use
  is a paid license Ninad has not approved. No evidence of a compliant
  free centre path was found this run.
- The self-training path remains the compliant route and its licensing
  chain is verified as permissive, with the residuals above recorded.
- Wake word stays disabled and gated: no model is trained, no voice is
  added beyond the one verified, no phrase is chosen, nothing is
  downloaded, and nothing activates until Ninad picks the phrase and
  approves a training run.
