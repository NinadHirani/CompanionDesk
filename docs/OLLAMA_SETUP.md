# Local AI setup (Ollama)

CompanionDesk answers with a model that runs entirely on your computer. The
one piece it needs is [Ollama](https://ollama.com). This document describes
exactly what the app does during setup, what it never does, and what works on
each platform.

## What the app does

When no local model is available, the Today view shows a "Local AI setup"
card with exactly one next step for the state you are in:

1. **Ollama is not installed or not running.** The card shows the official
   install route for your platform. Clicking the button opens the official
   ollama.com download page. It is a guided setup: *you* install and open
   Ollama; the app never runs an installer itself and never installs
   anything in the background. When Ollama appears, the card finishes on its
   own (it re-checks when the window regains focus).
2. **Ollama runs but the recommended model (`llama3.2:latest`, about 2 GB)
   is not downloaded.** The card shows the size, checks free disk space
   (with headroom), and waits for your click. The download shows a progress
   bar streamed from Ollama, and you can cancel at any moment; a cancelled
   download is retried only by you. Nothing is downloaded without your
   click, and nothing is sent anywhere during the download.
3. **Model ready.** The card disappears; the status chip shows "Local model
   ready".

## What the app never does

- It never executes an installer, never spawns a process, and never pipes a
  script from the network (`curl ... | sh` is displayed for *you* to review
  and run on Linux; the app will not run it).
- It never downloads a model or any other file on its own; every download
  starts with an explicit click.
- It never sends a prompt, file, or any data to a cloud service unless you
  have added your own API key as the opt-in fallback.

## Platforms

| Platform | Install route | Model pull | Notes |
| --- | --- | --- | --- |
| macOS | Guided: official download page opens | In-app, one click | Primary target; the only platform the team has hands-on tested |
| Windows | Guided: official download page opens | In-app, one click | Same code path as macOS; installer behavior is Ollama's own |
| Linux | Displayed command (`curl -fsSL https://ollama.com/install.sh | sh`) + official page | In-app, one click | The command is never executed by the app |
| Android / web build | Not available | Not available | Android cannot run desktop Ollama. AI answers come only from the opt-in cloud fallback (your own Gemini key); otherwise nothing leaves the device. The desktop app is the route to a local model. |

## Limitations (verified facts)

- The on-device AI flow was verified on macOS development; the Windows and
  Linux guided plans reuse the same code path but were not exercised on real
  Windows/Linux machines.
- Model size is the published Ollama library size for `llama3.2:latest`
  (about 2 GB); the disk check adds 20% headroom and blocks the download
  button until there is room.
- Ollama itself must be started once after install (it then runs in the
  background); the app re-checks when you return to the window.
- The web/Android build cannot install software or download models. If
  Ollama is already running on the same machine (port 11434), the web build
  detects it on reload.
