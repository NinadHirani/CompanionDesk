# Distribution and automatic updates

How CompanionDesk gets from this repository onto a person's machine, and how
installed copies stay current.

## Download UX

Downloads live on GitHub Releases. Two doors:

| Door | URL | What it is |
| --- | --- | --- |
| Stable | https://github.com/NinadHirani/CompanionDesk/releases/latest | Tagged releases, published manually after review |
| Continuous | https://github.com/NinadHirani/CompanionDesk/releases/tag/continuous | One prerelease, updated on every commit to the `distribution` branch |

Each release carries:

- `CompanionDesk-<version>-arm64.dmg` (macOS Apple Silicon; an x64 DMG is built alongside)
- `CompanionDesk-Setup-<version>.exe` (Windows x64, NSIS installer)
- `CompanionDesk-<version>.AppImage` (Linux x64)
- the update-feed YAML files (`latest-mac.yml`, `latest.yml`, `latest-linux.yml`), which are what installed apps read

Inside the app, the update banner sits under the top bar: it checks, shows
progress, and offers exactly one action at a time (Download, Restart to
update, Open download page, or Try again after an error). Nothing downloads
or installs without that click, and the About screen shows the running
version and channel.

## Channels and versioning

- Stable builds check the stable feed only. Continuous builds (version
  `x.y.z-ci.N`) automatically follow prereleases, so they keep tracking the
  `continuous` release without any setting.
- Continuous versions are `package.json`'s version plus `-ci.<run number>`,
  applied by `scripts/set-ci-version.js`; run numbers only increase, so every
  commit produces a strictly newer version.

## What is automatic, per platform

| Platform | Artifact | Auto-update in-app | Why |
| --- | --- | --- | --- |
| macOS Apple Silicon | DMG arm64 | Check + notify + open download page | Squirrel.Mac refuses to replace an app whose signature is missing or invalid. `identity: null` means the DMG is unsigned, so in-place updates would fail. Once a Developer ID certificate signs the builds (see below), the same code switches to full in-app updates with no further changes. |
| Windows | NSIS exe | Full in-app update | electron-updater verifies the sha512 checksum in the feed. Unsigned installers show a SmartScreen warning on first install; that is cosmetic, not a failure. |
| Linux | AppImage | Full in-app update | Same checksum mechanism. |

This table is the honest position: secure, seamless macOS auto-updates
require code signing and notarization, and until those Apple credentials
exist, macOS users get a check-and-notify flow that opens the download
page. The app will never claim to self-update on an unsigned Mac.

## Enabling the pipeline

1. Push commits to the `distribution` branch. The `Continuous releases`
   workflow builds artifacts on macOS, Windows and Linux (serialized so the
   three jobs never race on the release).
2. When ready to actually publish, set the repository variable
   `ENABLE_CONTINUOUS_RELEASES` to `true` (Settings > Secrets and variables >
   Actions > Variables). Until then every run is a dry run: artifacts build
   and upload as workflow artifacts, nothing reaches Releases.
3. Stable releases: create a tag `vX.Y.Z` matching `package.json`'s version.
   The workflow builds and creates a DRAFT release. Review it, then publish.
   Nothing goes public by itself.

## Required secrets and costs

Set once in Settings > Secrets and variables > Actions. No secret is ever
committed to the repository.

| Secret | Needed for | Required? |
| --- | --- | --- |
| `GITHUB_TOKEN` | Publishing releases and feed files | Automatic; no setup |
| `CSC_LINK` + `CSC_KEY_PASSWORD` | macOS signing (Developer ID Application certificate as a base64 .p12) | Optional; unlocks full macOS auto-update |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | macOS notarization after signing | Optional; same unlock |

Costs: GitHub Actions is free for public repositories. On a private
repository the free tier includes 2,000 minutes/month, and macOS runners are
billed at a 10x multiplier, so one continuous build (a macOS job of roughly
15-20 minutes) consumes 150-200 charged minutes on its own. A public repo
removes that cost entirely. Apple's Developer ID certificate requires the
Apple Developer Program at USD 99/year. Releases on a private repo count
against GitHub storage; on a public repo they are free.

## Rollback, errors, safety

- A failed or corrupted download is thrown away; the running version is
  never touched. Checksum mismatches and signature failures surface in the
  banner with an explicit "nothing was installed" message.
- Installing is always user-initiated: Download is a click, Restart to
  update is a click. `autoInstallOnAppQuit` is off, so quitting never
  upgrades behind the user's back.
- Rollback is manual by design: reinstall an older DMG/EXE/AppImage from its
  release page. The app stores data in one SQLite file and a vault folder,
  both untouched by reinstalling.
- Windows SmartScreen and macOS Gatekeeper will warn on unsigned first
  installs; users click through knowingly. Notarization removes the macOS
  warning once set up.

## Local development

- `npm run pack` builds an unpacked app (no feed, no publish).
- `node scripts/build-dist.js --linux` with `DISTRIBUTION_PUBLISH=never`
  builds real artifacts without publishing anything.
- In a development build the updater is disabled by policy; the banner never
  appears.
