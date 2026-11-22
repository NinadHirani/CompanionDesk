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
8. **Personal context stays off the cloud by default.** The local prompt may
   include the user's name, about-me lines and habits; the cloud fallback gets
   a minimal prompt through `cloudArgs` (deadlines + question only) unless the
   user turned on `cloud_personal`. Memory suggestions use `ai.chat` (local
   only), never `ai.complete`.
9. **Nothing is remembered without a yes.** `_about-me.md` is the source of
   truth for what the user told us; the app edits single lines, never rewrites
   the file. Model-proposed memories wait in `memory_proposals` until approved.
10. **Device access is narrow.** Only the overlay page may use the microphone,
    audio only (`permissions.js`). whisper's binary and model are found from
    fixed paths or env vars, never from renderer input. A screenshot covers ONE
    window the user picked, is taken only on a click, is kept in memory, never
    written to disk, and NEVER sent to the cloud: screen questions use `ai.chat`
    (Ollama only), not `ai.complete`. The overlay stays visible and shows what is
    being sent. Title-based sensitive-window checks are NOT complete protection;
    never claim otherwise.
11. **General first.** The app is a general assistant. Student tools are one
    optional skill (`skills.js`): active only with real course data and unless the
    user set `student_module` to `off`. A fresh install must contain no student
    framing in prompts or UI. Dates the model writes carry the weekday and year.

## Repo map

```
src/main.js        Electron entry; window and IPC wiring only (logic is in services/personal)
src/preload.js     Sandboxed bridge; inlined channel list
src/ipc-channels.js  The allowlist (source of truth); tests/ipc-sync.test.js enforces all three agree
src/db.js          sql.js persistence; schema, CRUD, settings, activity events, proposals
src/ai.js          Provider chain: Ollama (default) -> Gemini (opt-in key); cloudArgs overrides the cloud prompt
src/ingest.js      PDF/txt -> text -> model JSON -> validate -> db
src/vault.js       Markdown export: <class>.md + semester-overview.md
src/brief.js       Pure daily brief: top deadlines, crunch weeks, unconfirmed bucket (fails closed)
src/services.js    getBrief, setDone (testable handler logic)
src/personal.js    Settings, about-me, suggestions, onboarding, hand-added deadlines, ask()
src/memory.js      The user's _about-me.md: line-level add/remove, sanitized, atomic writes
src/persona.js     Per-user prompt: fixed rules + settings + relevant memories + habits; minimal cloud prompt
src/patterns.js    Local habit maths (days before due); silent under 3 samples
src/proposals.js   Approve-first memory suggestions (local model only, grounded, no dates)
src/onboarding.js  Six fixed, skippable first-run questions (no model needed)
src/settings.js    Typed, validated personal settings
src/dates.js       Local-day helpers; clock is always a parameter
src/grades.js      Pure grade standing + needed-on-the-rest maths (never guesses weights)
src/gradebook.js   Scores, targets, per-course projections (service layer)
src/ics.js         Pure .ics parser: TZID/DST, repeat rules (flags what it cannot expand)
src/calendar.js    Calendar import/upcoming/remove (service layer)
src/hotkey.js      Overlay shortcut validation; overlay-layout.js: window placement maths
src/overlay.js     Electron overlay window + global shortcut controller
src/voice.js       Voice service: validate, energy gate, trim, whisper; wav.js, vad.js, whisper.js
src/permissions.js Which page may use which device permission (overlay audio only)
src/screen*.js     Screen Q&A: guard + sizing (screen.js), capture (screen-capture.js), flow (screen-service.js)
src/docs.js        Reads the shipped privacy policy and terms for the About me page
src/skills.js      Optional skills: student tools are active only with course data and unless switched off
src/health.js      Setup check: what works, what is missing, the exact fix (pure builder + collector)
prompts/syllabus-extract.md  Extraction prompt (adapted from Nūs, MIT)
renderer/          Vanilla JS: dom, app (Today), ask, about, onboarding, boot; format.js shared with tests
tests/             node:test suites + generated fixture syllabus PDF (needs python3)
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
Oct 24, 2026: M2 done and verified in the real app (brief card, crunch
weeks, filters, mark done with undo, CSP). Personal layer done: about-me file,
settings, approve-first suggestions, onboarding, local habit patterns,
hand-added deadlines (stored under a Personal course as 'manual'), exact-match
grade weights shown on deadlines, and a Grades tab (scores, targets, needed
average on the rest; refuses to project when weights do not add up). Fixed a latent bug: `LocalDb.open()` never
applied SCHEMA to a loaded database, so tables added later would be missing for
existing users. 186 tests green; headless Electron walkthroughs of the real app passed
20 checks (setup, deadlines, ask, about-me) and 7 (grades). M3 to M7 built (see Milestones). The app is now general-first (student tools
are an optional skill) and window capture is user-picked. Not built: a
cross-course GPA, quests, smart tasks, map. Model-dependent paths (ask, suggestions) are covered
with fake models; they have not been run against a real Ollama in CI.

## Milestones

All of M2 to M7 are BUILT and tested. "Built" is not "validated on your Mac":
the items under "Needs the owner" cannot be checked in CI or a Linux container.

- **M2 due view + daily brief.** DONE.
- **M3 companion overlay.** BUILT. Frameless always-on-top window, global
  shortcut (Cmd/Ctrl+Shift+Space, rebindable, validated), streaming answer with
  the per-user prompt, Esc hides, stays alive with the dashboard closed on macOS
  (elsewhere closing the dashboard quits: no tray yet).
- **M4 local voice.** BUILT. AudioWorklet 16 kHz capture, energy gate, temp WAV,
  whisper.cpp via execFile, transcript auto-asks, audio deleted. Needs the owner:
  install whisper-cli and a model; measure the "10 s in under 5 s" target on the
  real Mac; accept the macOS microphone prompt.
- **M5 window Q&A.** BUILT. The user picks ONE window; only it is captured, on a
  click, with the overlay staying visible and previewing what is sent. Local
  vision model only (default `gemma3:4b`). Windows titled like password managers
  or sign-in forms are unavailable; the title is re-checked between the title
  step and the pixel step. Needs the owner: `ollama pull` a vision model; allow
  Screen Recording; confirm macOS captures an occluded window's real contents.
- **M6 calendar.** BUILT. `.ics` import, TZID/DST-safe expansion, flagged
  unsupported repeat rules, shown on Today and given to the local model only.
- **M7 packaging.** BUILT. Icon (`scripts/make_icon.py`), mic usage string,
  Terms and Privacy readable in About me, `npm run pack` verified on Linux
  (asar contents, packaged smoke boot, voice from inside the asar). The mac dmg
  has not been built here. Auto-update stays deferred (notarization is paid).

## Since M7

- **Setup check** (About me, and the status chip links to it): Ollama and the
  model are `needed`; shortcut, voice, vision model and the macOS permissions are
  `optional`. The chip refreshes with it and on window focus.
- **CI** (`.github/workflows/ci-macos.yml`): tests and smoke boot on macOS 14 and
  Ubuntu, plus an unsigned macOS package check. NOT yet run on GitHub: it was
  parsed and its properties pinned in `tests/ci.test.js`, nothing more.

## Open decisions for the owner

- `package.json` has no `author`; electron-builder warns. Set it.
- Screen privacy is a window-title check, not a pixel check. Native secure-field
  detection would need a native module (rule 5). Accept, or decide otherwise.
- The handoff asks for read-only guidance via the macOS Accessibility API and for
  the FOCUSED window. Both need native access (rule 5). Instead the user picks a
  window, which is stricter but not the same. Confirm that is acceptable.
- No computer actions exist (nothing clicks or types for the user). If added,
  they must be propose-then-confirm only.
- Default vision model `gemma3:4b` and default hotkey: confirm or change.
- The Terms are a plain draft and need a lawyer's eye before any public release.
- A custom domain costs money, so it is out under rule 1 until you decide.
- Pushing to GitHub: nothing has been pushed; the remote is empty.

## Not built (deliberately out of this list)

A cross-course GPA (needs a grade-scale choice), daily quests, smart-task
breakdowns, a map view, a tray icon, auto-update.

## Environment notes

- Local model speed/quality scale with the Mac: 8 GB RAM -> 4B-class models
  (Gemma 3 4B), 16 GB -> 8B (Qwen3 8B), 24 GB+ -> Qwen3-30B-A3B. The shipped default is
  llama3.2:latest (3B, modest hardware).
  Extraction on a small local model is weaker than a cloud frontier model;
  that is expected. For stubborn syllabi the user can add a Gemini free-tier
  key as fallback — never required.
- Model choice lives in env (`LOCAL_MODEL`) until Settings UI lands.
