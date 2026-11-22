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

Installable builds exist today, but they are **GitHub Actions artifacts, not
GitHub Releases**. The repository is private and release publishing is still
switched off, so the [Releases page](https://github.com/NinadHirani/CompanionDesk/releases)
has nothing behind it yet; see "GitHub Releases (once publishing is enabled)"
below for what that page will hold. No public download links exist.

**How to get a build now:**

1. Open the workflow's Actions page (stable link, latest runs on top):
   - **Android APK:** [Actions · Android APK](https://github.com/NinadHirani/CompanionDesk/actions/workflows/android-apk.yml)
   - **macOS / Windows / Linux desktop builds:** [Actions · Continuous releases](https://github.com/NinadHirani/CompanionDesk/actions/workflows/release-continuous.yml)
2. Click the latest green run, expand the **Artifacts** section, and download
   the artifact for your platform. You must be **signed in to GitHub**, since
   the repository is private. The download is a **ZIP**: unzip it to get the
   installer/APK inside.
3. Artifacts are kept for **7 days**, so grab one from a recent run.

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

- Android APK: [run 45011456647](https://github.com/NinadHirani/CompanionDesk/actions/runs/45011456647),
  artifact `companiondesk-android-debug-apk` (4.4 MB, sha256
  `d99d267a56416b0d021ee39040be4fcb4003a3b7b8263352301ee3866f8e0830`).
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
with a Developer ID / release key yet, and no GitHub Release exists.

## GitHub Releases (once publishing is enabled)

**Nothing has been published here yet.** Release publishing stays switched
off until it is approved (see [docs/DISTRIBUTION.md](docs/DISTRIBUTION.md)
for exactly how that works). Once it is on, installers live on the
[GitHub Releases page](https://github.com/NinadHirani/CompanionDesk/releases);
until then, the builds described above are the only installable artifacts:

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
