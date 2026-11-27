# Connector adapters (27 Nov 2026, Ninad's go-ahead, batch 1)

Real request builders for the highest-value connectors. The adapter layer is
pure (`src/connector-adapters.js`): it BUILDS method/url/headers/body and the
executor in `src/main.js` performs the HTTPS call. `src/connector-actions.js`
is the action engine: it re-runs the full consent chain before any request
exists and never lets credential material into results, errors or the audit
trail. Definition-only catalog entries have no adapter and stay refused at
`authorizeCall` — nothing fakes a working integration.

## Consent model (unchanged and enforced)

1. Connection is always an explicit user action in the panel with exact
   declared scopes and a credential reference. Nothing connects by itself.
2. `read_only` actions run after connect (scope must be granted at connect).
3. `write` / `send` actions additionally need a single-use approval the user
   grants per connector + scope (`approve` returns an approval id; the
   engine consumes exactly one call with it).
4. Disconnect and revoke end the authorization and delete the stored
   credential. Connections persist only until the user disconnects.
5. Credentials live in the OS credential vault (Keychain/DPAPI/libsecret),
   encrypted at rest, never rendered, logged or returned. The user enters
   them in the app; they never travel through chat or logs.

## Credential wiring fix shipped with this batch

The credential vault keys files by `companiondesk-<id>` but the panel
handlers passed the plain catalog id, so every credential entry was silently
refused (`bad_request`) and no real credential could ever be saved. All vault
call sites in `main.js` now normalize ids first (fixed in this batch).

## Batch 1: implemented adapters (14 providers)

API-key / bot-token providers — setup is the user's own key or token:

| id | auth | read-only actions | approval-gated actions | setup |
| --- | --- | --- | --- | --- |
| github | PAT | repo_read, list_issues (issues.read added) | none yet | personal access token with matching read scopes |
| notion | integration token | search, get_page | none yet | internal integration secret |
| slack | bot token (xoxb) | auth_test, list_channels | post_message | own Slack app + bot token |
| discord | bot token | list_guilds | send_message | own bot application token |
| telegram | bot token | get_me | send_message | own bot via @BotFather |
| openai | API key | list_models | chat | own API key (paid per token) |
| anthropic | API key | list_models | message | own API key (paid per token) |
| google-gemini | API key | list_models | generate | own API key from AI Studio |

OAuth2 providers — the user creates their OWN client; no shared client
exists or will be created by this app:

| id | provider | read-only actions | approval-gated actions | setup |
| --- | --- | --- | --- | --- |
| google-drive | Google | list_files | none yet | own OAuth client in Google Cloud Console (Drive API) |
| gmail | Google | list_messages | send_message | own OAuth client (Gmail API) |
| google-calendar | Google | list_events | create_event | own OAuth client (Calendar API) |
| microsoft-onedrive | Microsoft Graph | list_files | none yet | own Azure app registration (Files.Read) |
| microsoft-outlook | Microsoft Graph | list_messages | send_message | own Azure app registration (Mail.Read, Mail.Send) |
| microsoft-calendar | Microsoft Graph | list_events | create_event | own Azure app registration (Calendars.Read, Calendars.ReadWrite) — new catalog entry |

OAuth flow (implemented, no panel UI yet): `workspace:connectorOAuthAuthorizeUrl`
builds the authorize URL from the user's own client id (redirect locked to
https or loopback, no query, no userinfo), the user completes the consent
screen in their browser, then `workspace:connectorOAuthExchange` trades the
code for tokens and stores the blob (client id/secret + access/refresh token
+ expiry) straight into the OS vault. Only `ok/hasCredential` leaves main.
The explicit panel Connect with exact scopes remains the only thing that
creates a connection. Tokens refresh via the adapter `refreshRequest`
builders; the automatic refresh loop is a follow-on.

## Transport safety

HTTPS-only, 15 s timeout, 256 KiB response cap. Providers whose secret rides
the URL (Telegram, Gemini) are flagged `urlContainsSecret`; failures reject
with a bare `transport_error` and never a URL or header. Results are
truncated at 20,000 chars and scrubbed of credential-shaped URL parameters
(`key=`, `token=`, ...) before they leave the engine.

## Still definition-only (pending, honestly refused)

Zapier and Make need their own OAuth applications (no simple API-key path);
their catalog entries stay definition-only until that is built. Dropbox,
YouTube, Spotify, Zoom and the rest of the expanded tier have no adapters
yet. Custom webhook connectors are not executed in this batch: their consent
surface differs from the catalog gate and needs its own design before any
send. The panel has no action-invocation UI yet (the engine is reachable
through IPC); that UI and an AI action-calling surface with the same gates
are the next batches.

## Batch 2 (27 Nov 2026): action surfaces, AI calling, OAuth refresh

**Panel action surfaces.** Every implemented adapter's actions render on
its connected row as explicit Run buttons (kind + scope travel in the
button label). Read-only actions with no required parameters run with one
click; anything with parameters or a send/write kind opens a small form
with one labelled input per required parameter, and sends/writes need a
second explicit Confirm click. That confirm click is the per-action
approval gesture: main mints the single-use approval for exactly that
connector + scope right before the engine consumes it. Refusals surface
verbatim; ok results show a bounded preview (300 chars) of the scrubbed
data. Discovery-state rows render no action buttons.

**AI action calling.** The `connector_status` agent tool gained a `run`
action: read-only connector actions run through the SAME engine and gate
chain the panel uses (connected, scope granted, single-use approval for
sends/writes). The tool validates ids and bounds params (max 20 keys,
2000 chars JSON) before the engine is called. It never mints approvals:
a send/write comes back `approval_required` with a pointer to the panel,
where the user's confirm click is the approval. The list action now
carries each implemented adapter's runnable actions so the AI names only
what exists.

**OAuth token refresh (Google/Microsoft).** New pure module
`src/connector-tokens.js`: parse the stored blob, decide refresh need
(expires_at inside a 60s skew, never guessed when expiry is unknown),
refreshability (refresh token + the user's own client credentials), merge
a provider token response (refresh-token rotation honoured: a new refresh
token replaces the old; otherwise the old is kept; expires_at recomputed
from expires_in or kept, never guessed), and classify failures
(400/401 = reauth_required, anything else = transient refresh_failed).

The engine refreshes an expired oauth blob BEFORE the action and writes
the rotated blob straight back to the OS vault through an injected
credentialWriter. If the rotation cannot be persisted, the action fails
with `refresh_persist_failed` rather than gambling on a possibly-dead
refresh token. A provider 401 on the action itself earns exactly ONE
refresh-and-retry; a second 401 is reported as-is. A 400/401 from the
token endpoint classifies as `reauth_required`: the injected
`onReauthRequired` hook disconnects the connector and drops its stored
credential (the same lifecycle as the panel's Disconnect), so nothing
stale masquerades as a live connection; the user reconnects explicitly.
Refresh audit entries carry status and duration only, never URLs, tokens
or bodies. The connectors payload carries a token-state LABEL (ok /
expiring / expired / unreadable) for oauth rows; the credential itself
never leaves the main process.

**New read actions (scope already declared on each entry).** GitHub
`get_issue`, Slack `get_channel`, Google Drive `get_file_meta`, Gmail
`search_messages`, Google Calendar `get_event`, Microsoft OneDrive
`get_file_meta`, Microsoft Outlook `search_messages`, Microsoft Calendar
`get_event`. `listActions` now also passes each action's required
parameter names through so the panel and the AI tool can name what an
action needs.

Still the user's: real API keys, own OAuth clients, actual connections,
per-connector activation, and device validation.

## Batch 3 (27 Nov 2026): low-risk write actions

Four new write actions ship behind the same per-action approval and
two-step panel confirm every send/write already goes through. All are
create-only: nothing updates in place and nothing deletes.

- **GitHub `create_issue`** (issues.write): opens an issue with a
  required title and optional body on owner/repo.
- **Notion `create_page`** (pages.write): creates a page under a parent
  page id, required title, optional first paragraph as content.
- **Google Drive `create_file`** (files.write): multipart upload of a
  small text file (name required, content required, 20,000 chars cap).
- **Microsoft OneDrive `create_file`** (files.write): Graph simple
  upload to the OneDrive root (PUT; buildRequest now allows PUT).

Two honest scope corrections so the sign-in matches what the actions
need: the Google Drive OAuth sign-in now requests the full Drive scope
(it was read-only) and the OneDrive sign-in requests Files.ReadWrite
(it was Files.Read). Both setup notes state this.

Engine ordering improvement: parameter validation now runs BEFORE the
consent gate, so an invalid parameter set can never burn a single-use
approval (the adapters module exposes validateOnly for this).

Catalog notes for the implemented Gmail, Outlook, Calendar and Drive
entries now say honestly what runs after connect ("read and send/write
actions... need a per-action approval") instead of read-only wording.

Tests: write build behaviour (URL encoding, optional-body omission,
multipart boundary, PUT shape), write declarations, validateOnly without
credential parsing, write approval lifecycle (refuse, run once, dead),
write scope/connected gates, param refusal before approval consumption,
the AI tool never passing an approvalId for a write, and the panel's
write-kind two-step confirm with confirmWrite. Suite 1465/1465 green.

Still the user's: real credentials, own OAuth clients, actual
connections, per-connector activation, and device validation.
