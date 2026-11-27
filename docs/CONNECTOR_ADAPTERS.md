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
