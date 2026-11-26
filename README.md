# CompanionDesk

A free-first, local-models student assistant: drop in your syllabi, get a
local AI that tracks every deadline, warns you about heavy weeks, and learns
how you work. Everything stays on your machine.

- **No billing, no accounts, no cloud requirement.** No Supabase, no Stripe,
  no telemetry.
- **Local by default.** Answers come from Ollama running on your Mac.
- **Honest about hardware.** Local model speed and quality depend on your
  Mac's RAM and the model you pick: 8 GB → 4B-class (Gemma 3 4B), 16 GB →
  8B (Qwen3 8B), 24 GB+ → Qwen3-30B-A3B. Small local models are weaker than
  frontier cloud models at reading messy syllabi; for a stubborn document
  you can add a free Gemini API key as an opt-in fallback. The cloud is a
  fallback for harder tasks, never required: the app boots, stores data, and
  answers "what's due" with zero network.
- **Your data is yours.** One SQLite file plus a markdown vault you can open
  in any editor. Delete the folder and it is gone.

## Download / Install

**Android, direct download (no sign-in needed):** [Download app-debug.apk](https://github.com/NinadHirani/CompanionDesk/releases/download/v0.1.0-android-preview.2/app-debug.apk)
from release [v0.1.0-android-preview.2](https://github.com/NinadHirani/CompanionDesk/releases/tag/v0.1.0-android-preview.2).
It is a **debug-signed preview for testing only** (not Play-Store-ready; sha256
`bc312b53e3f7170a895c27710ce91716e53f88e6c11698e62960105122acb988`), and
install/run on real hardware is not yet verified — read the release notes for
install and update caveats. Desktop Ollama does not run on Android: AI answers
there need the opt-in Gemini fallback you configure yourself, or a companion
desktop. Everything else (deadlines, syllabus import, calendar) is local.
**What this preview contains:** it was built from main on 24 Nov 2026 (commit
`83dbcda`, workflow run 45344402037) and includes the run-driver Stage A
foundation; Stages B and C are not implemented. The previous preview
([v0.1.0-android-preview.1](https://github.com/NinadHirani/CompanionDesk/releases/tag/v0.1.0-android-preview.1),
sha256 `d99d267a56416b0d021ee39040be4fcb4003a3b7b8263352301ee3866f8e0830`)
remains available. Because each CI run signs with a fresh debug key,
**uninstall any previously installed preview before installing this one**. The newest build of main exists only as
a workflow artifact (below), which needs a GitHub sign-in and changes URL
with every run. A newer public release is published only after an explicit
review.

Real-hardware validation: before trusting any install/run claim, run the
manual pass in [docs/DEVICE_VALIDATION_CHECKLIST.md](docs/DEVICE_VALIDATION_CHECKLIST.md)
on a Mac and an Android phone, and record the results.

**Desktop one-click local AI setup:** the app walks you through Ollama in one click
(see [docs/OLLAMA_SETUP.md](docs/OLLAMA_SETUP.md)). It opens the official installer
for *you* to run, then downloads the recommended model in-app with a progress bar,
a disk-space check and cancel. It never installs software or downloads a model in
the background, and never sends anything to the cloud unless you add a key.

Desktop builds (macOS / Windows / Linux) remain **GitHub Actions artifacts, not
GitHub Releases**: desktop release publishing is still switched off, so the
[Releases page](https://github.com/NinadHirani/CompanionDesk/releases) holds
the Android preview only. To get a desktop build (or a newer Android build
than the pinned preview):

1. Open the workflow's Actions page (stable link, latest runs on top):
   - **Android APK:** [Actions · Android APK](https://github.com/NinadHirani/CompanionDesk/actions/workflows/android-apk.yml)
   - **macOS / Windows / Linux desktop builds:** [Actions · Continuous releases](https://github.com/NinadHirani/CompanionDesk/actions/workflows/release-continuous.yml)
2. Click the latest green run, expand the **Artifacts** section, and download
   the artifact for your platform. GitHub requires you to be **signed in to
   GitHub** to download artifacts, even on a public repository. The download is
   a **ZIP**: unzip it to get the installer/APK inside.
3. Artifact retention varies by workflow: the desktop builds are kept for
   **7 days** (that workflow sets it explicitly), while the Android APK artifact
   uses GitHub's default **90-day** retention (the current one expires
   about 22 Feb 2027). Either way, grab one from a recent run.

**Installing the Android APK (sideload):** download the APK (a workflow
artifact arrives as a ZIP: unzip it first), open it on the phone, tap it, and
allow installs from unknown sources if Android asks. **Debug vs release:**
every APK in this repo so far is a **debug build**, meant for testing, not
store distribution; there is no release-signed APK yet, and no release
signing key exists. Because each CI run signs with a fresh debug key,
installing a newer build over an installed one requires uninstalling the old
one first (Android refuses to update across different debug signatures).

**Artifacts and their filenames:**

| Artifact (workflow) | Contains | For |
| --- | --- | --- |
| `companiondesk-android-debug-apk` (Android APK) | `app-debug.apk` | Android phones |
| `dist-macos-latest` (Continuous releases) | `CompanionDesk-<version>-arm64.dmg`, `CompanionDesk-<version>-x64.dmg` | macOS Apple Silicon (M1 and later) / Intel |
| `dist-windows-latest` (Continuous releases) | `CompanionDesk-Setup-<version>.exe` | Windows |
| `dist-ubuntu-24.04` (Continuous releases) | `CompanionDesk-<version>.AppImage` | Linux (`chmod +x`, then run) |

The version is `0.1.0-ci.N`, where N is the run number, so filenames differ
per run.

**Recent verified runs (examples; each link expires with its artifacts):**

- Android APK: [run 45344402037](https://github.com/NinadHirani/CompanionDesk/actions/runs/45344402037),
  artifact `companiondesk-android-debug-apk` (4.7 MB, sha256
  `bc312b53e3f7170a895c27710ce91716e53f88e6c11698e62960105122acb988`),
  built from main on 24 Nov 2026 (artifact expires about 22 Feb 2027).
  Debug-signed only: every run signs with a fresh debug key, so installing a
  newer APK over an installed one requires uninstalling first. Install/run on
  a real device is not yet verified.
- macOS: [run 45012671571](https://github.com/NinadHirani/CompanionDesk/actions/runs/45012671571),
  artifact `dist-macos-latest` (about 303 MB) containing
  `CompanionDesk-0.1.0-ci.3-arm64.dmg` (Apple Silicon) and
  `CompanionDesk-0.1.0-ci.3-x64.dmg` (Intel).

**Limitations:** the macOS/Windows/Linux builds are **unsigned** (see the
Gatekeeper and SmartScreen notes under "GitHub Releases (once publishing is enabled)" below); the
Android APK is **debug-signed** and untested on a device. Nothing is signed
with a Developer ID / release key yet, and the only GitHub Release is the
Android preview above.

**Agent capabilities are staged.** The app's agent features roll out in
reviewed stages. Stage A (complete, 24 Nov 2026) builds the run driver's
foundation with an **empty tool registry**: the app can account for agent
runs in its ledger, but no tool can execute, nothing can start a run, and
nothing happens automatically. Stage B (real tools plus an explicit approval
mechanism) and Stage C (in-app run controls) are designed but **not
implemented**, and none of it will be enabled without a separate explicit
review. The agent layer has no model-driven execution, no scheduling, and no
network access.

## GitHub Releases (once publishing is enabled)

Two **Android preview releases** (debug APKs for testing) have been
published (preview 1 and preview 2); desktop installers have not. Release publishing stays otherwise switched off
until it is approved (see [docs/DISTRIBUTION.md](docs/DISTRIBUTION.md) for
exactly how that works). Once it is on, installers live on the
[GitHub Releases page](https://github.com/NinadHirani/CompanionDesk/releases);
until then, the builds described above are the only desktop installable
artifacts:

- **macOS, Apple Silicon (M1 and later):** `CompanionDesk-<version>-arm64.dmg`
- **macOS, Intel:** `CompanionDesk-<version>-x64.dmg`
- **Windows:** `CompanionDesk-Setup-<version>.exe`
- **Linux:** `CompanionDesk-<version>.AppImage` - `chmod +x` it, then run it

Two channels share that page:

- **Continuous prerelease** (tag `continuous`): a fresh build for every
  approved push to the `distribution` branch. Versions look like
  `0.1.0-ci.N`. Newest features, least testing; marked "Pre-release".
- **Stable releases** (tags `v*`): built from tagged commits and held as a
  draft for a person to review before they are published.

The app checks for updates itself and never installs one without your
click. Per platform:

- **macOS:** the build is currently unsigned, so Gatekeeper stops the
  first launch. Control-click the app and choose Open, or approve it under
  System Settings > Privacy & Security ("Open Anyway"). Updates stay
  manual on macOS too: an unsigned build cannot be replaced in place, so
  "Check for updates" tells you a new version is out and you download it
  from the Releases page. Real automatic updates on macOS need Developer
  ID signing plus notarization, which requires a paid Apple Developer
  account; that setup is documented in
  [docs/DISTRIBUTION.md](docs/DISTRIBUTION.md).
- **Windows:** the installer is unsigned, so SmartScreen may show a
  warning; choose "More info" then "Run anyway". In-app updates work
  normally once installed.
- **Linux:** AppImage updates are checked and applied in-app after your
  confirmation, same as the flow above.

## Made to fit one person

Two people using CompanionDesk get two different assistants.

- **A file you own.** What it knows about you lives in one markdown file
  (`_about-me.md` in the vault folder). Open it, edit it, or delete a line to
  make it forget. The app only adds or removes single lines, so your edits
  are never overwritten.
- **Nothing is remembered without a yes.** If you mention something about
  yourself while asking a question, it may offer to remember it. It saves
  only what you accept, only wording close to what you said, and never dates.
- **It learns from what you do, locally.** Mark items done and, after three,
  it can tell how early you usually finish. That is plain arithmetic on this
  computer. Switch it off or clear it any time in About me.
- **Your voice, your rules.** Name, tone, length and language are settings.
  The one rule nothing can change: it will not make up a deadline or a grade
  weight, and it says so when it does not know.
- **Life beyond the syllabus.** Add applications, hackathons and registered
  exams yourself; they count in the brief and in heavy-week warnings.
- **Grades without guessing.** Enter scores and a target to see what the rest
  of a course needs. If the syllabus weights do not add up to 100% it says
  so instead of guessing.
- **Private by default.** The optional cloud fallback only ever receives your
  deadlines and your question. Your notes, name and habits go to it only if
  you turn that on.

## Setup (once)

1. Install [Node.js](https://nodejs.org) 18+ and [Ollama](https://ollama.com).
2. Pull a model (one-time download, runs offline after):
   the shipped default is `llama3.2:latest`, which runs on modest hardware:
   `ollama pull llama3.2` (larger Macs can point `LOCAL_MODEL` at Qwen3 8B or 30B).
3. In this folder:
   ```
   npm install
   npm test        # should be all green, no network needed
   npm start
   ```
4. Click **Import syllabus** and pick a PDF. Deadlines land in the app and
   in the vault folder (Application Support → CompanionDesk → vault on macOS).

## Setup check

Open **About me** (or click the status chip at the top) for a setup check. It
shows what is working, what is missing, and the exact command to fix each item,
with a Copy button: Ollama and the model are needed; voice, window questions and
the overlay shortcut are optional. On a Mac it also shows the Screen Recording
and Microphone permissions. Click **Check again** after fixing something.

## The overlay: ask from anywhere

Press **Cmd/Ctrl + Shift + Space** (change it in About me) for a small window
that floats above your other apps. Type a question and the answer streams in.
On a Mac it keeps working with the dashboard closed.

### Speak instead of typing (optional, fully local)

Voice uses [whisper.cpp](https://github.com/ggml-org/whisper.cpp) on your own
machine; no audio leaves it. One-time setup:

1. `brew install whisper-cpp` (this provides `whisper-cli`).
2. Download a model such as `ggml-base.en.bin` from the whisper.cpp project
   and put it in the app's `models` folder (Application Support, then
   CompanionDesk, then `models`). To use other locations, set `WHISPER_BIN`
   and `WHISPER_MODEL`.
3. Click **Speak** in the overlay. macOS asks for microphone access once.

Until that is set up, the Speak button tells you what is missing.

### Wake phrase ("Hey <companion name>", optional, default off, fully local)

Before the overlay listens, it can wait for a spoken wake phrase built from
your companion name, for example "Hey CompanionDesk" with the default
settings name. How it works, stated plainly:

- The phrase follows the companion name in About me; it is not hard-coded.
  Changing the name makes the old model invalid and the engine refuses to
  start until a model for the new phrase exists. It never silently reuses a
  model trained for a different phrase, and invalid names are refused.
- Detection is a small local model trained on fully synthetic speech from a
  permissively licensed voice, verified from primary sources
  (docs/WAKE_PROVENANCE.md). No pretrained wake model from another project
  is bundled: none was shippable under its license.
- Training a model for a name is one local, free command:
  `bash scripts/wake/train_for_name.sh --name "Nova"`. The trainer writes a
  held-out false accept / false reject report next to the model; those
  numbers are measured on synthetic clips, so real-microphone performance
  is not yet validated and wake stays default-off (`wake_enabled` false)
  until it is, with the microphone opened only on your explicit action.
  The recorded run is reproducible: `scripts/wake/repro_eval.py` rebuilds
  the held-out split from the same corpus and scores the saved model, and
  matched the report's numbers exactly on 24 Nov 2026.
- Wake runs in the desktop app only (macOS, Windows, Linux). On Android or
  the web build the engine refuses with a plain reason and the About card
  says so instead of offering a Start button. A refused microphone maps to
  a plain reason too (permission denied, or no microphone), and a failure
  always lands wake off again.
- While it listens, the wake card in About shows the live state, including
  when the microphone is open; Stop closes the microphone immediately.

### Ask about a window (optional, fully local)

Type a question, click **Screen**, and pick one window from the list. Only that
window is captured, and the overlay stays visible showing a preview and its
title while the question is sent. The picture goes to a local vision model, is
never saved, and never leaves your computer. It happens only when you click:
never in the background.

1. `ollama pull gemma3:4b`, or set `COMPANIONDESK_VISION_MODEL` to another
   vision model you have.
2. macOS asks you to allow **Screen Recording** the first time. Restart the
   app after allowing it.

Windows whose title looks like a password manager or a sign-in form are listed
as unavailable and cannot be chosen. That is a title check only. It cannot see
inside a web page, so it is not complete protection: close anything private
before using it.

## Calendar

**Import .ics** on the Today screen reads a calendar file you exported from
your calendar app. No account, no sign-in; it stays on this computer. Repeating
events are expanded, except a few unusual repeat rules, which show once and
are labelled.

## Build a Mac app

`npm run dist:mac` builds the dmg. `npm run pack` makes an unpacked build for
the machine you are on, which is a quick way to check packaging.

## Status / runs on your Mac as

Unsigned build: the first `npm run dist:mac` dmg asks for one **Open
Anyway** confirmation (System Settings → Privacy & Security). Builds target
both Apple Silicon (M1 onward) and Intel Macs; no arm-only dependencies.

## License

MIT. Portions adapted from [potlakai/nus](https://github.com/potlakai/nus)
and [potlakai/nus-desktop](https://github.com/potlakai/nus-desktop)
(MIT, © 2026 Pranav Desu) — see LICENSE.
