# CompanionDesk on mobile and in the stores

Honest scope: CompanionDesk today is an Electron desktop app for macOS. This
document describes the mobile-compatible path built in this repo and what is
still needed before anything can be published to Google Play or the App Store.

## What exists (built and unit-tested in this repo)

- **Dual-mode core.** `src/extraction-core.js`, `src/ai.js` and `src/db.js`
  load both from Node/Electron (require) and from a plain browser `<script>`
  (window.CompanionCore / CompanionAi / CompanionDb). The Electron desktop
  app is functionally untouched.
- **Pluggable persistence.** `LocalDb.open({ storage })` accepts any
  `{ load, save }` backend. Desktop keeps the single SQLite file; the web
  build keeps the same database in IndexedDB. Covered by
  `tests/storage.test.js`.
- **Web bridge.** `src/web/bridge.js` exposes the exact `window.companiondesk`
  API the Electron preload exposes (`state_get`, `syllabus_import`, `ai_ask`),
  so `renderer/app.js` runs unchanged in a browser or WebView. File picking is
  a native `<input type=file>`; PDF text extraction is pdfjs-dist in the
  browser; storage is IndexedDB; the model layer is the same provider chain
  (local Ollama first, opt-in Gemini key as fallback). The web/Android build cannot install software or download models on its own: if
  Ollama is missing, the Local AI setup card says so plainly and points to the
  desktop app (see docs/OLLAMA_SETUP.md); if Ollama is already reachable at
  127.0.0.1:11434, the web build detects it and tells you to run
  `ollama pull <model>` yourself.
- **Build script.** `bash scripts/build-web.sh` assembles the self-contained
  bundle in `web/` (the Capacitor `webDir`).
- **`capacitor.config.json`.** appId `app.companiondesk.assistant`, appName
  CompanionDesk, webDir `web`.

Try the web build on any machine with Node and the npm dependencies installed:

```
bash scripts/build-web.sh
python3 -m http.server 8123 --directory web   # then open http://localhost:8123
npm test                                       # 19 tests, no network needed
```

Notes: a desktop browser can talk to local Ollama at 127.0.0.1:11434 (start
Ollama with `OLLAMA_ORIGINS='*'` or your page's origin if the browser blocks
the request). A phone WebView cannot reach your Mac's Ollama, so on-device
extraction uses the opt-in Gemini free-tier key — exactly the fallback the
desktop app already supports. The markdown vault export is desktop-only in
this milestone.

## Verified vs not verified (as of Nov 22, 2026)

- Verified locally: `npm test` green on Node 22 (full suite); the web bundle
  assembles and every script parses; the server serves it (HTTP 200). On
  Oct 23, 2026 the web UI was additionally exercised headlessly in Chromium
  (dashboard renders, IndexedDB-backed sql.js opens, correct no-Ollama
  status) and a Capacitor Android debug APK was built once and
  signature-verified locally.
- Verified in CI: since Nov 22, 2026, `npx cap sync android` plus
  `gradlew assembleDebug` runs on every main push that touches mobile files
  (and on manual dispatch); the resulting debug APK is uploaded as a
  workflow artifact named `companiondesk-android-debug-apk`.
- Not verified: installing or running the APK on a real Android device;
  release signing (the artifact is debug-signed, and each CI run signs with
  a fresh debug key, so installing an update over a previous install needs
  an uninstall first); store accounts, fees, and store assets (see below).

## Android (Google Play) — what remains

1. DONE (Nov 22, 2026): `@capacitor/core`, `@capacitor/cli` and
   `@capacitor/android` are pinned dev dependencies, and the generated
   `android/` Capacitor project is committed at
   `app.companiondesk.assistant` (min SDK 22, target/compile SDK 34,
   INTERNET only).
2. DONE (Nov 22, 2026) for CI: `.github/workflows/android-apk.yml` builds a
   debug APK on GitHub Actions (no local Android tooling needed) and uploads
   it as the `companiondesk-android-debug-apk` workflow artifact. A local
   Gradle build still needs JDK 17 + the Android SDK on your own machine.
3. A generated upload keystore and signing config (kept out of git).
4. A Google Play developer account (one-time USD 25 fee) — the owner's.
5. Store listing assets, Data safety form, content rating, and a privacy
   policy URL (draft text: `PRIVACY_POLICY.md`; checklist:
   `STORE_CHECKLIST.md`).

## iOS (App Store) — what remains

Requires a Mac with Xcode, an Apple Developer Program membership (USD 99/yr),
signing certificates/provisioning, and App Store Connect setup. None of that
can be produced from a Linux workspace; the web bundle is the part that
carries over (`npx cap add ios` happens on the Mac).

## What we will not do

No billing, no accounts, no telemetry, no cloud requirement — on any platform.
Publishing or changing repository visibility only happens on the owner's
explicit instruction.
