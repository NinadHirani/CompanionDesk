# CompanionDesk — implementation handoff

You are Claude Code working on CompanionDesk: a free-first, local-models student
assistant + desktop companion for macOS (Apple Silicon M1 onward, Intel where
feasible). M0 (shell) and M1 (syllabus ingestion) are done and tested; your
job is the scoped tasks below. Read this file fully before changing anything.

## Hard rules (never break)

1. **Free-first, no billing, ever.** No Supabase, no Stripe, no accounts, no
   telemetry. A cloud provider (Gemini free tier today) is an OPT-IN fallback
   the user configures; the core app must boot, store data, and answer
   "what's due" with zero network and zero keys.
2. **Ollama-first.** The provider chain in `src/ai.js` tries local Ollama
   (OpenAI-compatible API at localhost:11434) first; cloud only fires when a
   key exists AND the local call failed. Do not invert this.
3. **Never invent a deadline.** Extraction goes through
   `prompts/syllabus-extract.md` and `validateExtraction()` in
   `src/ingest.js`: malformed or missing dates become null + a warning,
   never a guess. Keep that property in every new extraction path.
4. **IPC allowlist.** The renderer reaches main only through channels listed
   in `src/ipc-channels.js`, mirrored inline in `src/preload.js` (sandboxed
   preloads cannot require local modules — keep both lists in sync).
   Renderer context: `contextIsolation: true`, `sandbox: true`.
5. **No native modules without discussion.** sql.js (WASM) and pdfjs-dist (legacy build) are
   pure JS on purpose, so arm64 and x64 Mac builds are trivial. A native dep
   breaks one of the two architectures and needs a rebuild story first.
6. **Data stays on the machine.** SQLite via sql.js + user-owned markdown in
   the vault folder. Deletion of the data dir erases everything.
7. **Universal-friendly builds.** `npm run dist:mac` targets arm64 AND x64
   dmg (see `build.mac` in package.json, `identity: null` = unsigned).

## Repo map

```
src/main.js        Electron entry; window, IPC handlers, context pack
src/preload.js     Sandboxed bridge; inlined channel list
src/ipc-channels.js  The allowlist (source of truth)
src/db.js          sql.js persistence; schema + CRUD + due-window query
src/ai.js          Provider chain: Ollama (default) -> Gemini (opt-in key)
src/ingest.js      PDF/txt -> text -> model JSON -> validate -> db
src/vault.js       Markdown export: <class>.md + semester-overview.md
prompts/syllabus-extract.md  Extraction prompt (adapted from Nūs, MIT)
renderer/          Vanilla JS Today view (status chip, due list, courses)
tests/             node:test suites + fixture syllabus PDF
scripts/make_fixture_pdf.py  Regenerates the fixture PDF
```

## Commands

```
npm install          # dev deps pull Electron; tests do not need it
npm test             # node --test tests/  (no network, no Ollama needed)
npm start            # run the app (needs Electron from npm install)
npm run smoke        # boots and exits; prints smoke-ok
npm run dist:mac     # unsigned arm64 + x64 dmg into dist/
OLLAMA_URL=... LOCAL_MODEL=llama3.2:latest npm start   # override defaults via env
```

## Status

M0 done: shell, window, smoke, allowlisted IPC, sqlite persistence.
M1 done: ingestion pipeline + vault export, all tested green.
Oct 23, 2026: renamed to CompanionDesk (package/app identity, window, vault
docs). The desktop Electron app is untouched functionally. Default local
model is now `llama3.2:latest` (matches the target Mac; env `LOCAL_MODEL`
still wins). Import failures are actionable: `src/import-errors.js` maps
error codes to plain next-step messages; a failed import still writes
nothing.

## Next scoped tasks (M2+)

- **M2 — due view + daily brief.** Renderer: sort/filter due list; a
  "morning brief" IPC channel (`brief:today`) that renders top-3 deadlines +
  crunch-week warning (>=3 deliverables or >=2 exams in any 7-day window)
  computed LOCALLY in pure JS (no model call needed for the math).
  Acceptance: brief renders from fixture data with zero network calls;
  unit test for the crunch-week detector with a synthetic week.
- **M3 — companion overlay.** Second BrowserWindow: frameless, always-on-top,
  skip-taskbar, hidden from capture where macOS allows; global hotkey
  show/hide (Cmd+Shift+Space default, rebindable); text ask -> ai.complete
  with the same context pack. Acceptance: overlay toggles from any app;
  answer streams; works with the dashboard closed; Esc hides instantly.
- **M4 — local voice.** whisper.cpp via child_process spawn (reference the
  pattern in potlakai/nus-desktop src/stt-local.js, MIT): capture 16 kHz
  Int16 -> temp WAV -> whisper-cli -> transcript -> ai.complete. Acceptance:
  10 s utterance transcribes < 5 s on the target Mac; no audio leaves the
  machine; VAD gate skips silence.
- **M5 — screen-aware Q&A.** desktopCapturer screenshot -> vision-capable
  model (Gemma 3 via Ollama, or Gemini opt-in). Refuse password/secure text
  fields. Acceptance: round-trip works; sensitive-field refusal tested.
- **M6 — calendar read.** Parse local .ics (pattern: nus-desktop src/smart.js
  parseIcs, MIT). Acceptance: parsed events appear on Today; no OAuth.
- **Handoff note.** Heavy follow-on work (mobile/store packaging, signing,
  notarization) is handed to Claude Code via this file; do not publish or
  change repo visibility without the owner's explicit say-so.
- **M7 — packaging polish.** README honest about unsigned dmg ("Open
  Anyway"); auto-update stays deferred (notarization is $99/yr, paid, out of
  scope for free-first).

## Environment notes

- Local model speed/quality scale with the Mac: 8 GB RAM -> 4B-class models
  (Gemma 3 4B), 16 GB -> 8B (Qwen3 8B), 24 GB+ -> Qwen3-30B-A3B. The shipped default is
  llama3.2:latest (3B, modest hardware).
  Extraction on a small local model is weaker than a cloud frontier model;
  that is expected. For stubborn syllabi the user can add a Gemini free-tier
  key as fallback — never required.
- Model choice lives in env (`LOCAL_MODEL`) until Settings UI lands.
