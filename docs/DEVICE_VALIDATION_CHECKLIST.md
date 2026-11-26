# CompanionDesk physical-device validation checklist

Owner: Ninad Hirani. Prepared by Fo, 26 Nov 2026 (docs-only, no code changed).
Devices: MacBook Air M1 (macOS, 8 GB) and OnePlus 12R (Android).

Purpose: a precise manual pass that turns the shipped M4/M5/M6/M8 features
from "unit-tested, never seen on hardware" into "verified on device". Every
item below maps to a landed, roadmap-documented behavior; nothing here opens
a closed lane. Wake-word validation is excluded per the owner's standing
closure, the floating-companion toggle (m84) is already verified and is not
re-tested, and the capture engine does not exist yet, so there is nothing to
validate there.

Ground rules:

- Record pass/fail per item with the app commit (`git log -1` at test time)
  and the OS version, then send the results back to Fo.
- Nothing here needs an account, but the chat/AI items need a working model
  path: on the Mac that is local Ollama (on-device, no network, no account);
  on Android, AI answers require the opt-in Gemini fallback you configure
  yourself, which does use the network. With no model path configured,
  record the chat/AI items as unreachable with what the app showed.
- If an item cannot be reached in the build you have, record "unreachable"
  with what the UI showed. That is a result, not a failed pass.

## A. macOS (MacBook Air M1)

Setup: build or run the app from the current main commit (`git log -1` in
the repo, or the packaged app). Chat items assume Ollama is installed with a
local model picked; install it first if it is missing.


1. Launch. The app opens to a usable window, no crash. Nothing requests an
   OS permission at launch (Device Access rule: no startup blanket
   permission prompts).
2. Chat core. Send a normal message. The answer streams progressively and
   completes without a truncated tail (regression target: the m85
   tail-buffer fix).
3. Voice defaults. Voice/mic features are off until you enable them, and no
   mic indicator exists before that.
4. Mic permission flow. Enabling voice triggers the OS microphone prompt at
   the moment of use, not before; grant it. While listening, a visible
   indicator shows the honest listener state.
5. Mic race guard. Rapidly start/stop the mic several times, and press
   Escape while a mic start is still in flight. Each session cancels
   cleanly, the indicator clears, nothing stays stuck, and the next start
   works first try.
6. Spoken replies. Trigger a reply with speech output on. Audio plays using
   the OS voice (macOS speechSynthesis). The app bundles no TTS engine
   (26 Nov decision: OS-native only, piper deferred and unbundled).
7. Proactive scheduler. Create a reminder in About > Proactive reminders /
   the schedules panel. With delivery off (the default) nothing notifies,
   and the panel says so in plain language.
8. Delivery and quiet hours. Turn delivery on. Create a schedule due inside
   the quiet-hours window (default 22:00-08:00). Confirm it is not dropped:
   it notifies when the window ends, and the panel states that contract.
   Confirm a due schedule fires exactly once, with no duplicate
   notifications.
9. Per-scope controls. Toggle the reminder and deadline scope switches off
   and on; the panel's per-scope state lines match what settings say.
10. Editing schedules. Edit an active schedule's title and due time in the
    panel; the change saves, and the scope field stays fixed while editing.
11. Memory view. Add a memory, see it listed, forget it, confirm the list
    updates. The view reflects in-session state.
12. Sensitive marks are session-only. In-session, mark an entry sensitive
    and refresh the view: the mark survives within the session. Quit and
    relaunch: the sensitive content is not on disk (session-only, no
    on-disk format). Attempting to persist sensitive content is refused,
    never silently saved.
13. Workspace views. Open each wired view: tasks, memory, tools,
    permissions, activity, integrations. Each renders rows from its owning
    module; integrations shows an honest empty registry (no placeholder
    connectors).
14. Device Access Centre. In the permissions view, enable one non-sensitive
    capability, grant it, then revoke it. Revocation takes effect
    immediately and an audit entry appears in the activity view.
15. Window resize. Resize across narrow and wide; the layout adapts, and
    nothing clips or overlaps.

Optional, same session (Gate 1 groundwork): the roadmap's Gate 1 device
benchmarking wants local-model numbers measured on this exact machine. If
you want that unlocked, run `npm run test:benchmark` while you are set up
and keep the output.

## B. Android (OnePlus 12R)

Get the APK from the repo's Android CI artifact for the same main commit.

1. Install and launch. With a model path configured (on Android that is the
   opt-in Gemini fallback, per the README), core chat works and streamed
   answers complete without truncation; without one, record chat as
   unreachable and continue with the rest.
2. Settings render; voice stays off until enabled; record exactly what the
   Android build offers for mic and speech. Feature parity on Android is a
   finding either way.
3. Rotate and resize; no clipped layout.
4. Memory and workspace views render, or degrade honestly if a surface is
   desktop-only; record what ships.
5. No background mic or capture without explicit enablement and a visible
   indicator; no OS permission requested at launch.

## Memory panel checks (landed 26 Nov 2026, commit a0e69fc)

The desktop app mounts a memory panel with the main window. On macOS:

1. The list shows every bullet with a status: [saved] or [session-only,
   not saved]; sensitive entries show [sensitive]; a sensitive mark on a
   saved bullet says the mark itself is session-only (a restart drops it).
2. Mark a plain bullet sensitive, then unmark it; the status line reports
   each outcome and the list re-renders.
3. Add a bullet with "keep session-only (sensitive, not saved)" ticked: it
   appears labelled session-only; press its "try to save" button and record
   the refusal text the status line shows.
4. Search once with the consent box off and once with it on: record the
   budget line ("task budget: chat keeps 12"), the matched terms, and that
   a sensitive entry appears in results only with consent.

## Results template (copy, fill, send back)

- macOS (version, chip):
  - launch + core chat (model path used):
  - streamed answer completes without truncation:
  - settings render + companion toggle positions:
  - voice: mic permission prompt timing, speech output works:
  - memory panel: list labels / mark-unmark / session-only add + refusal
    text / search consent behaviour:
  - schedules panel, notifications, activity views:
  - anything clipped or broken:
- Android (OnePlus 12R, OxygenOS version):
  - APK commit + install result:
  - chat reachable (model path used) or unreachable:
  - settings render; mic/speech features offered:
  - rotate/resize clipping:
  - memory/workspace views render or degrade honestly:
  - permissions requested at launch (should be none):
- Overall: how long the pass took; anything blocking.

## What this unlocks

- Honest "verified on device" claims for every item above. Until then, such
  claims stay out of docs and READMEs.
- Mic-validation data recorded per platform (the wake-word lane itself
  stays closed regardless of this checklist).
- Direct input for the M9 release-readiness phase once defined.

## The single missing input

Nothing in the repo, CI, or the build environment blocks this gate. The one
missing input is physical: the owner running this checklist on the two
devices (about 30-60 minutes) and sending the results back.
