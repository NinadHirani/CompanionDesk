# Device Access Centre: architecture

Requirement from Ninad (24 Nov 2026): broad device/app access, not a narrow integration set, achieved without ever holding "access to everything", and without bypassing operating-system controls.

## What the operating systems make impossible (stated plainly)

CompanionDesk cannot access everything on the device, and no normal app can:

- **macOS** gates mic, camera, screen recording, contacts, calendar, and full-disk file access behind per-permission TCC prompts; **accessibility** powers UI automation but is its own explicit grant; **keychain contents and other apps' private data** are simply not reachable to a sandboxed or non-privileged app, period.
- **Android** gates mic, camera, contacts, notifications, location and storage behind runtime permissions; screen capture needs MediaProjection with a per-session user tap; **scoped storage** means broad filesystem reads are not granted by Play-Store policy at all; other apps' private databases are sandboxed away; accessibility service access is scrutinized and restricted.
- Anything requiring OS-level bypass (reading private app databases, capturing other apps' screens on locked-down Android, hidden listening) is out of scope permanently, not "not yet".

## The architecture

1. **One control surface**: the Device Access Centre is the only place device capabilities are enabled, granted, revoked, and audited (`src/device-access.js` policy core, landed 24 Nov 2026; UI shell comes later behind its own gate).
2. **Capability catalog**: fixed, per-platform. Each capability names the OS permission it needs (the app surfaces that ask at the right moment; it never bypasses it), its class, and its indicator requirement.
3. **Explicit enable, then explicit grants**: sensitive capabilities (mic, screen, UI automation) need an explicit enable first, then per-app grants. UI automation is desktop-only, needs its own enable, and exists only where the OS permits it.
4. **Least privilege**: grants are per app id, per capability, with exact scopes. No wildcards, no bulk grants, no startup blanket permission prompt.
5. **Approvals**: reversible_write and sensitive classes additionally require a one-time approval digest bound to the exact action (same vocabulary as Gate 2 approvals) for writes, sends, deletes, and purchases.
6. **Revocation and audit**: revocation is immediate and per app; grants, revocations, and approval requests land in an audit log (ids and scopes only).
7. **Visible indicators**: mic, screen, and UI automation show a visible-while-active indicator; local-only processing, no raw retention or upload defaults carry over from the voice and screen policies.
8. **Extensible app-integration catalog**: official OAuth/API connectors for services (Google apps and others) join the same center: per-app grants, least-privilege scopes, revocation, audit. No connector is connected without Ninad selecting it; no capability is invented.
9. **The OS stays the boundary**: this is an app-side policy layer. It cannot and does not claim unrestricted access; `UNRESTRICTED_DEVICE_ACCESS` is a constant false in code.

## Open decisions (Ninad's calls, not to be made silently)

- Which capabilities ship first and in what order.
- The exact UI for the center and its indicators.
- Which third-party services the integration catalog lists first.
