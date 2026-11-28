# M9 coordinated-release brief

STATUS: PROPOSAL ONLY. The governing roadmap (`docs/IMPLEMENTATION_ROADMAP.md`)
defines no M9; per its numbering note, a coordinated-release phase becomes M9
only when Ninad explicitly defines it. GROUNDWORK 25 Nov 2026: proposed items
1 and 5 are landed without defining the phase - a CHANGELOG.md and
`tests/first-run-defaults.test.js` (the first-run privacy-defaults acceptance
pin), and the first-run interview now closes with a privacy step that
explains the standing defaults and applies nothing (src/onboarding.js,
question 7 of 7; a no-auto-enable test pins that no interview answer can
set anything beyond name, tone and brevity). Nothing else here is
implemented, scheduled, wired, or promised; no signing, no distribution,
no update feed.

## What the phase would be

Ship the first coordinated desktop release: one versioned, installable macOS
build of the already-landed M0-M5 and Gate 2 slices, with the release
engineering around it (versioning, packaging, update story, first-run
experience, release checklist). It coordinates what exists; it adds no new
product capability.

## Proposed scope

1. Versioning and changelog discipline: one version source, a changelog, and
   the preview-tag precedent already in use.
2. Desktop packaging (macOS first): the electron-builder target already used
   for dist builds produces the app bundle; a smoke checklist runs the
   packaged app (models dir, secure storage, notification paths, settings).
3. Signing and notarization decision (Ninad's, with a real cost): macOS
   Developer ID plus notarization is an Apple Developer Program spend
   (US$99/yr at the last check); Windows signing is a separate cost. Without
   signing, the app ships unsigned with Gatekeeper/SmartScreen warnings -
   an explicit, documented tradeoff, never a silent one.
4. Update story: the free-first default is manual download plus an in-app
   version display; an auto-update feed only follows a signing decision, and
   never updates silently.
5. First-run experience: the standing privacy defaults verified on a fresh
   install (cloud off, voice off, proactive delivery off, nothing captured,
   no permission requested at startup).
6. Release checklist and acceptance (below).

## Dependencies and gates (why this cannot start alone)

- Gate 2 remaining gates (agent scheduling, file output) and run-driver
  Stage B/C: separate explicit reviews; run-driver work is paused at the
  proposal per Ninad's 24 Nov direction.
- M4 memory v2 store-contract wiring: a later reviewed slice.
- Gate 1 device measurements: physical device time. No performance claim
  appears in any release note without measured numbers.
- Any signing spend, or any public distribution: Ninad's explicit approval
  (standing rule: nothing public before review).

## Proposed acceptance criteria

- A tagged release candidate builds from a clean clone with no secrets and
  no network access during the build.
- The packaged app passes the smoke checklist on macOS; the CI matrix stays
  as it is (Windows/Linux CI-only).
- Every default-privacy claim in the release notes is backed by a test that
  passes on the tagged commit.
- Nothing in this phase enables execution capability, capture, wake word, or
  cloud by default.

## Software preparation status (28 Nov 2026)

Under the 28 Nov standing authorization the software/checklist lane of this
brief is prepared, spend-free and signature-free: the release engineering is
draft-gated end to end (scripts/build-dist.js defaults DISTRIBUTION_PUBLISH to
'never', the npm dist scripts carry --publish never, a stable publish is
draft:true so nothing becomes publicly visible until a person publishes it,
and mac.identity stays null), pinned by tests/ci-release.test.js and
tests/m9-release-readiness.test.js; the packaged-app smoke checklist is
prepared as docs/M9_SMOKE_CHECKLIST.md. Still owner-gated and NOT prepared:
any signing purchase, any notarization run, any public distribution, any
tagged release candidate, and the physical smoke run itself, which only the
owner performs. No performance claim may appear in a release note without
measured numbers from the Gate 1 device pass.

## Explicitly out of scope until decided

Public distribution, any app-store presence, and any signing purchase. The
brief records the tradeoffs; Ninad decides.
