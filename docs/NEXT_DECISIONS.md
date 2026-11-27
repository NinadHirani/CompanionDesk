# CompanionDesk next decisions sheet

Prepared by Fo, 26 Nov 2026 evening (docs-only, no code changed). The morning
decision sheet is fully executed: items 1, 2, 3, 5, 6 and 7 landed and are
CI-verified (run-driver Stage B, the schedule_create enable, the file-output
gate, M8 slice 4 schemas, the M4 sidecar, the M6 TTS decision); items 4 (M7
capture engine) and 8 (M9 release readiness) were deferred by Ninad.

Every remaining roadmap item is gated on one decision below or on the
physical device pass, with one exception: item 7 (the sensitive-memory UI)
is RESOLVED as of 26 Nov 2026 evening, commit `a0e69fc` -- Ninad reopened
the M2/M4 UI paths for that scoped slice and the memory panel landed.
Reply in chat with item numbers and choices; each approved item is
implemented red-first with targeted tests, the full suite plus selftest,
commit/push and exact-head CI verification, exactly as the morning sheet's
items were.

## 1. Physical device pass (no decision needed, only the pass)

docs/DEVICE_VALIDATION_CHECKLIST.md is ready and linked from the README.
Status: STILL PENDING as of 26 Nov 2026, 4:14 PM IST. Nothing in the repo,
CI, or build environment blocks it; the only missing input is the pass itself
(about 30-60 minutes on the MacBook Air M1 and OnePlus 12R, results back to
Fo). It unlocks device-verified claims, doubles as Gate 1 benchmarking
groundwork (`npm run test:benchmark` in the same session), and feeds M9
later.

## 2. M8 connectors -- RESOLVED (26 Nov 2026 evening)

Ninad approved (22:10 IST): build the Connector Settings/catalog with
free-first worldwide discovery and extensible integrations, and the
settings to manage connections. Prioritize free/open-source/free-tier/
self-hostable; surface paid requirements, costs and limits BEFORE
activation; secure credential storage (opaque references only); explicit
per-connector permission scopes; the full connection lifecycle
(connect/disconnect/reconnect/revoke/test); local-first where possible;
approval gates for sensitive/write/send/delete/external actions; NO
blanket auto-connect and NO connector or permission granted without his
explicit choice. Architecture is connector-ready and the catalog is
broad, but nothing is activated automatically. Implemented 26 Nov 2026
evening as src/connectors.js (pure policy core, 12 red-first tests,
AUTO_CONNECT false, unregistered in main.js, nothing connected).
Connecting a real service still needs a named service and an explicit
per-connector activation by Ninad. FOLLOW-ON APPROVED (26 Nov 2026 late
evening): commit 25990f5 accepted; proceed with the connector settings
UI and its integration within this approved scope (management UI for
the lifecycle, still nothing activated without his choice).

FOLLOW-ON APPROVED AND IMPLEMENTED (27 Nov 2026, ~4:45 PM IST): Ninad
decided the Connectors section is accessible by BOTH the user and the AI;
the AI may ask him to connect an app/website when a task requires it; a
connection is one-time and persistent until he disconnects; he can
disconnect/manage it. Implemented within the existing gates: the agent's
connector_status tool (third registration) only lists states and raises a
user-facing connect request (src/connector-requests.js, bounded queue, one
open request per connector, resolve requires userInitiated); approving a
request in the panel runs the SAME explicit connect gate as his own pick
(exact declared scopes, credential reference), so AUTO_CONNECT stays false
and a request is never a grant. Connections persist in the settings table
(ids, states, exact scopes only, never credential material) through a new
strict snapshot/restore pair on the catalog. No service is connected and
no credential exists yet, so nothing is granted today.


Follow-on (27 Nov 2026 evening, marketplace slice, same authorization):
Ninad asked for a real Connector Catalog/Marketplace UI on main. Landed:
the Connectors section gained a client-side search box and category filter,
and CUSTOM CONNECTORS - the user may add a connector for an app/website
outside the built-in catalog via an explicit form (safe auth-type allowlist
api_key/access_token/oauth2/webhook/website, https-only URLs with loopback
http only, no userinfo/query strings so secrets never ride in a URL, exact
name:class scopes, 50-entry bound). Every custom row carries an honest
readiness label and authorizeCall refuses custom entries with
integration_not_implemented, so no custom connector can fake a working
integration; connect still runs the unchanged explicit gate and removal
drops the credential. New channels workspace:connectorCustomAdd /
connectorCustomRemove (renderer gestures, main builds userInitiated), 14
core tests + 5 panel tests, suite 1391/1391 and selftest PASS. Nothing is
activated automatically; naming a real service and approving its scopes
remain the owner's calls. (docs/CONNECTOR_CATALOG.md has the full rules.)

Follow-on (27 Nov 2026, credential-store slice, landed under Ninad's
continuous implementation authorization): the service-agnostic credential
store exists (src/connector-credential-store.js, OS credential vault,
fail-closed) and the connect gate reads its deterministic references, so the
approval flow and the storage layer are now wired end to end. Connecting a
REAL service still needs exactly what it needed before: Ninad names the
service, enters its credential in the Connectors panel, and approves the
scopes. Nothing is connected, nothing is granted.

## 3. Workspace renderer UI -- RESOLVED (26 Nov 2026 late evening)

Settings-view wiring, owner hard stop (27 Nov 2026, 00:27 IST): Ninad ruled the settings view stays UNWIRED. Do not reopen settings.js (m84 checkpoint-closed) and do not create a new settings row-store category without owner approval. This closes the last renderer-wiring candidate; the five row-store views (files, databases, appdata, workflows, models) remain the complete wired set, exactly as the c94dbb4 slice shipped them.

Ninad approved (a) FULL: implement the Workspace UI end to end --
functional interactions, responsive layouts, settings, wiring to the
existing architecture -- with the scoped renderer paths (overlay.js,
main.js, index.html) reopened for exactly this work. The m84 float
toggle's verified behavior in those files stays untouched; its existing
tests keep guarding it. Unwired views render an honest not-wired state.

## 4. file_write / filesystem access (Gate 2) -- RESOLVED (26 Nov 2026 late evening)

Ninad chose C, the broader path: filesystem access is authorized wherever
the OS allows it, implemented with safeguards -- the real target path is
always visible before any action, overwrite and delete require explicit
confirmation, the OS sandbox and permissions are respected and never
bypassed, and nothing destructive ever happens silently. Registration
mirrors the schedule_create enable step (guardrails tested); any scoped
root starts unset by default. Implemented as the file-access policy core
plus its Gate 2 enable step.

Follow-on (26 Nov 2026 night, f239a93): the EXECUTION slice landed the same
evening under this approval - real filesystem operations run through the
policy core (injected io adapter, main.js wires the fs-backed one), the
executor probes real existence before refusing a write as an overwrite,
OS errors surface verbatim, and file_access is now the registry's second
tool with the two-registration-literal guardrail. Nothing auto-runs:
requestRun still has no caller and the sensitive class still demands a
fresh one-time approval per call.

## 5. M7 capture engine (deferred item 4)

Decision: (a) green-light now (it brings the real permission flows and
device-testing needs with it), or (b) keep deferred.

## 6. M9 release readiness (deferred item 8)

A docs-only proposal exists (docs/M9_RELEASE_BRIEF.md); it is not a
definition. Decision: (a) define the phase now (say what M9 must contain),
or (b) keep deferred.

## 7. Sensitive-memory UI -- RESOLVED (26 Nov 2026 evening)

Done, not open: Ninad reopened the M2/M4 UI paths for this scoped slice and
the memory panel landed at `a0e69fc`: explicit mark/unmark with visible
status lines, session-only/nonpersistent labels from `persisted()`
provenance, the fail-closed persistSensitive refusal surfaced verbatim, and
consent-gated retrieval with the budget and matched-terms header. No
on-disk sensitive format was created and none is proposed.

## 8. Workspace row stores -- RESOLVED (26 Nov 2026 late evening)

Ninad approved (a) FULL extensible support: owning row stores for
files/folders, local databases, structured app data, workflow/task data,
model/AI views, and searchable/index views. Configurable permissions; NO
auto-exposure and NO auto-connection. The stores are pure, bounded,
fail-closed rows their views mirror exactly; schemas in
src/workspace-views.js wire once the stores exist.

Not on this sheet: the wake-word lane stays closed per the owner's standing
closure; reopening it is always the owner's call and no question about it is
asked here.

Follow-on to the Gate 8 row-store decision (26 Nov 2026 night, c923013): Ninad confirmed Gate 8 A covered local databases and structured app data, so the two remaining categories landed as bounded row stores (databases prefix db, appdata prefix ad) with view adapters in workspace-views.js, same EMPTY/no-auto-exposure contract. Update 27 Nov 2026 00:00 IST: Ninad confirmed in chat that Gate 3 full Workspace UI + Gate 8 A cover renderer wiring (the later-lane note was outdated), and the five row-store views went wired true the same hour (c94dbb4): the panel fetches through the existing pure rows provider, shapes fail-closed, and shows an explicit empty state; settings stays the only unwired view. Still owner-gated: any persistence design for the stores (not clearly covered by Gate 8 A; M2/M4 sensitive persistence and the canonical markdown format stay untouched).
