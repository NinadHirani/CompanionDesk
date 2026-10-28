# CLAUDE_HANDOFF - CompanionDesk (generated Oct 28, 2026)

## Current revision and GitHub reconciliation (UPDATED Oct 28, 2026)

- CORRECTION: `NinadHirani/CompanionDesk` IS accessible via Fo's own GitHub
  connection (OAuth MCP). The earlier 404 came from the SEPARATE fine-grained
  PAT in the coding workspace (a connector token), which lacks this repo's
  scope. Use Fo's GitHub connection for this repo, not that PAT.
- Remote state verified Oct 28: private repo
  https://github.com/NinadHirani/CompanionDesk, branch `main`, HEAD
  `2160cfa1343ff3674a939ca3cc2463a0ebe2c0ba` ("Update CI workflow
  configuration"), 4 commits total. Remote's post-initial commits added:
  `.github/workflows/ci.yml` + a `build:web` npm script (18046f3), a
  Promise.withResolvers polyfill in `src/ingest.js` and `src/web/bridge.js`
  (61da7ab), and a CI config tweak (2160cfa).
- Local working copy: `/workspace/local-desk-assistant`. Local history
  (a51554e + the Oct 28 foundation commit 9ed07c7 + a reconciliation commit)
  is UNRELATED to the remote history (the remote "intial" commit is not an
  ancestor of the local tree). Both trees contain the same app with
  independently-applied fixes; do NOT merge histories blindly.
- Reconciliation applied: a new branch
  `fo/general-companion-foundation` was created FROM remote `main`
  (`2160cfa`) and the Oct 28 foundation changes were pushed onto it in
  sequential commits, with the remote's withResolvers polyfill preserved
  inside `src/web/bridge.js` and remote's `build:web` npm script preserved in
  `package.json`. A PR to `main` was opened. No force-push, no history
  rewrite, nothing on `main` was overwritten.
- Local-only leftovers NOT pushed (still uncommitted in the local tree):
  `src/db.js`, `src/ingest.js`, `src/import-errors.js`,
  `scripts/build-web.sh`, `STORE_CHECKLIST.md`, `src/uint8-hex.js`,
  `android/`, `verification/`. These overlap with remote's own fixes
  (remote patched `src/ingest.js` its own way); merge them deliberately on a
  machine with git access, do not copy them over remote files wholesale.

### HOW CLAUDE SHOULD START (required reading order)

1. Download the reference ZIP `CompanionDesk-src-9ed07c7.zip`
   (53 files, 958,861 bytes,
   sha256 f2e64b0bf7ab810ff9ecfe01e348e63023c51f4f96173d9af176bc12c94827e8)
   - it is the verified local snapshot including all Fo changes.
2. BEFORE editing anything, fetch the GitHub latest on the relevant branch
   (`main`, or `fo/general-companion-foundation` after the PR merges) and
   DIFF the two. Neither is automatically newer: the ZIP carries Fo's
   foundation work plus local-only fixes; the GitHub branch carries the
   remote-side CI and pdfjs-compat fixes. Reconcile file by file.
3. Then follow the Recommended implementation order below.

## What changed Oct 28 (general-companion foundation)

- NEW `src/skills.js`: minimal skill registry. `general` (always on,
  general-purpose voice), `student` (auto-active only when course data
  exists). Contract documented in `docs/SKILLS.md`.
- `src/main.js`: persona now comes from the skill registry; `SYSTEM_VOICE`
  (student chief-of-staff) removed; `buildContextPack` emits the context
  header plus skill-contributed lines, so a fresh install sends no student
  context at all. `ai:ask` uses `skills.system(db)`.
- `src/web/bridge.js`: mirrored general-default voice
  (`composeVoice()`: student framing appended only when courses exist);
  `buildContextPack` rewritten so student lines appear only when student
  data exists. Still a hand-mirrored copy of the contract (documented).
- `renderer/index.html`, `web/index.html`: tagline states the
  general-purpose default and the optional student module.
- `package.json` description updated; `README.md` intro updated.
- NEW `tests/skills.test.js` (5 tests). NEW `docs/SKILLS.md`.
- `web/` regenerated with `scripts/build-web.sh` (14 files).

Pre-existing local changes (from earlier sessions, also in the working
tree/last commit): CompanionDesk rename, llama3.2:latest default,
`src/import-errors.js`, `src/uint8-hex.js`, web bridge/mobile work,
`scripts/build-web.sh`, `STORE_CHECKLIST.md`.

## Setup and test (Linux workspace where this was developed)

    export PATH="/workspace/tools/node-v22.14.0-linux-x64/bin:$PATH"
    npm install          # node_modules already present (230 MB); skip if so
    npm test             # node --test tests/*.test.js
    npm start            # Electron UI (needs a display)
    bash scripts/build-web.sh   # regenerate web/ bundle

Verified test output, Oct 28, 2026, Node v22.14.0, Linux:

    # tests 24
    # pass 24
    # fail 0

(19 pre-existing tests kept passing; 5 new skills tests added. Electron was
NOT booted in this pass; `npm start`/smoke behavior on macOS is unverified.)

## Recommended implementation order for Claude Code

1. Read `docs/SKILLS.md`, `src/skills.js`, `src/main.js` (small files).
2. Add a settings toggle to disable the student module explicitly (currently
   auto-active only when data exists; no UI toggle yet).
3. Phase 1 of `COMPANIONDESK_ROADMAP.md`: floating companion window, then
   local memory, then push-to-talk voice. Keep every piece local-first.
4. Port the skill contract into the web build properly (bundle `src/skills.js`
   with a UMD wrapper instead of the mirrored constants in
   `src/web/bridge.js`).
5. Only then touch screen awareness (Phase 2), respecting its constraints.

## macOS / Apple Silicon validation steps

1. `npm install && npm test` on macOS (Node >= 18; tests ran on Linux only).
2. `npm start` with Ollama running (`ollama pull llama3.2:latest`): ask a
   general question; confirm no student lines in behavior and that the
   answer is general-purpose.
3. Import a syllabus PDF; confirm the student module activates and existing
   academic behavior is unchanged; delete the DB and confirm fresh-install
   general behavior.
4. `npm run dist:mac` (arm64 first). Unsigned build: Gatekeeper right-click
   open path applies.

## Security / privacy constraints (binding)

- Local-first; Ollama default; no required cloud key; no billing, no
  Supabase, no Stripe, no telemetry.
- No always-on screen capture or listening without explicit opt-in and a
  visible indicator.
- No unrestricted computer control; propose-then-confirm only.
- Do NOT claim title-based sensitive-window checks provide complete
  protection; they do not.
- Secrets: none are stored in the repo (secret scan run Oct 28, clean of
  API-key patterns outside node_modules/vendor).

## Known gaps / unverified

- Electron smoke run not re-executed this pass (Linux, no display claim
  beyond the earlier session's verification).
- No student-module settings toggle yet; auto-activation only.
- Web bridge mirrors the skill contract rather than bundling it.
- The uploaded CompanionDesk-local.zip was not accessible to Fo this session;
  work is based on the workspace tree. If that zip contains newer files,
  diff it against this tree before continuing.
