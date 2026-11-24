# M7 screen observation: decision and implementation status

## Decided by Ninad (24 Nov 2026)

Screen observation is three user-selectable modes, shown as a picker in
settings. Nothing is enabled until the user selects a mode and explicitly
starts it; the default is manual/off.

- **A. Manual look** (default): a look happens only when the user
  explicitly asks. No session, no background anything.
- **B. Active session**: the user explicitly starts and stops a visible
  session; CompanionDesk observes only during that session.
- **C. Background assist**: available ONLY on laptops and desktops,
  never on Android or any mobile platform. It requires a separate
  explicit opt-in consent, shows a persistent indicator while on, can be
  paused or stopped at any time, requires at least one configured app
  exclusion, runs a conservative cadence (30 s interval floor), processes
  locally only, uploads nothing, and retains no screen content by
  default.

## Implemented in the policy slice (capture engine still disabled)

- `src/screen-mode.js`: the pure mode policy. Start is refused unless the
  source is an explicit user action (capture never autostarts), manual
  mode can never start, background is refused on mobile platforms at
  selection AND at start even with consent stored, background without its
  consent record is refused, one observation runs at a time, stop/pause
  are always available, the indicator contract is pinned (persistent for
  background), and a screen permission may be requested only as part of
  an explicit user action.
- `src/settings.js`: `screen_mode` (manual/session/background, default
  manual) and `screen_background_consent` (default false) join
  `screen_observation_enabled` (master switch, still false by default).
- Settings UI: a mode picker with the three options and, for background,
  a separate consent checkbox that is visible only when background is
  selected.
- Deterministic tests pin every rule above; full suite green.

## Still a boundary

The capture engine itself remains disabled and unbuilt: it needs real
screen-capture permission flows, device testing on each desktop platform,
and the engine wiring (sessions through src/screen-observation.js, the
interval/exclusion config, the visible indicator in the overlay). No
capture, permission request, or indicator runs from this slice alone.
