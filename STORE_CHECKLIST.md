# Store-readiness checklist (status Oct 23, 2026)

Legend: [x] done locally, [~] prepared locally, [ ] blocked on owner/account/fee.

## Both stores

- [x] Working, tested codebase (19/19 unit tests green).
- [x] Mobile-compatible app path (dual-mode core + web bridge + Capacitor config).
- [~] App name, description, category copy (drafted below).
- [~] Privacy policy draft (PRIVACY_POLICY.md; needs hosting at a public URL).
- [x] Data collection statement: the app collects nothing; no accounts, no
      analytics, no telemetry. Model calls go only to the provider the user
      configures (local Ollama, or Google Gemini with a key they supply).
- [ ] Screenshots on real devices (needs a built app on a device).
- [ ] Content rating questionnaires (Play) / age rating (App Store).
- [ ] Export/compliance answers (App Store) — no encryption beyond HTTPS.

## Google Play

- [~] Package name: app.companiondesk.assistant.
- [~] Store listing copy (drafted in PRIVACY_POLICY.md's sibling section below).
- [ ] Signed .aab: needs keystore generation + Android build tooling.
- [ ] Google Play Console developer account: one-time USD 25 fee (owner).
- [ ] Data safety form, target API level compliance (Android SDK build).
- [ ] Internal testing track before any production release (recommended).

## Apple App Store

- [~] Bundle id: app.companiondesk.assistant.
- [ ] macOS with Xcode + iOS Capacitor shell (cannot be built from Linux).
- [ ] Apple Developer Program: USD 99/yr (owner).
- [ ] App icons/splash in Xcode asset catalog (draft icon: assets/icon.png).
- [ ] Privacy nutrition labels, review notes, screenshots.

## Draft store listing (both stores)

Title: CompanionDesk — Local Study Assistant
Subtitle: Your syllabi, deadlines and briefs, all on your device.
Description: CompanionDesk reads your syllabi and keeps every deadline on your
device. No accounts, no subscriptions, no cloud requirement: your data lives
in a database and a markdown folder you own and can delete. Bring your own AI:
runs on a local model (Ollama) when available, or a free-tier Gemini key you
add yourself for harder documents. Nothing is uploaded by us, ever.
Category: Productivity / Education.
