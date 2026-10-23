# CompanionDesk

A free-first, local-models student assistant: drop in your syllabi, get a
local AI that tracks every deadline and briefs you. A NŪS-style assistant
that keeps everything on your machine.

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

## Status / runs on your Mac as

Unsigned build: the first `npm run dist:mac` dmg asks for one **Open
Anyway** confirmation (System Settings → Privacy & Security). Builds target
both Apple Silicon (M1 onward) and Intel Macs; no arm-only dependencies.

## License

MIT. Portions adapted from [potlakai/nus](https://github.com/potlakai/nus)
and [potlakai/nus-desktop](https://github.com/potlakai/nus-desktop)
(MIT, © 2026 Pranav Desu) — see LICENSE.
