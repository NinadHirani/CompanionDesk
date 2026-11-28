# M9 packaged-app smoke checklist

STATUS: PREPARED ONLY. This is the physical-run checklist for the packaged
CompanionDesk app. Nothing in it has been run against a packaged build: the
physical/device lanes stay excluded and are the owner's to run. Every item is
written as something the owner performs; no item may be recorded as passed
until the owner runs it.

## Before you start

- Build locally with `npm run pack` (a directory bundle, no publish step) or
  `npm run dist:mac` (a dmg, still `--publish never`). Never publish anything.
- Confirm the build came from a clean clone with no secrets in the
  environment and no network access required during the build.
- Note the commit the bundle was built from (the version/commit shown in
  About or the app menu).

## First-run privacy defaults

- On a fresh profile the app starts with cloud off, voice off and proactive
  delivery off, with nothing captured and no OS permission prompt at startup.
- The first-run interview applies nothing beyond name, tone and brevity, and
  closes with the privacy step that explains the standing defaults.
- After a restart with no interaction, the app still requests no permission.

## Models dir

- The app creates or points at the models directory only on an explicit model
  action; nothing downloads automatically at startup.
- A whisper model selected through the voice_model setting loads only when
  speech output is explicitly used, and the model files stay in the models
  directory (never in the bundle).

## Secure storage

- Credentials are stored as opaque keychain/vault references, never plaintext.
- No stored secret is ever displayed back in a settings surface.

## Notification paths

- Notification permission is only requested from an explicit user action, not
  at startup.
- A notification that arrives identifies the app and never contains content
  the user has not seen in-app first.

## Settings

- Every settings surface shows the current value before it changes anything.
- Changing a permission-bearing setting asks once, states exactly what it
  enables, and reverting it removes the grant.

## Update surfaces

- The in-app version display shows the current version; no auto-update feed
  runs, and no update download starts without an explicit user action.

## Recording results

- Record pass/fail per item with the build's commit hash. Any failed item
  blocks a release candidate; a release note may claim only what a passing
  item on the tagged commit backs.
