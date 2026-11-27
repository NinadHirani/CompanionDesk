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

## Batch 4 (27 Nov 2026): calendar create_event write parity

Verified both calendar adapters already carry the same gated write the
other providers got in batch 3, with nothing new to build: Google
Calendar and Microsoft Calendar each expose `create_event` as kind
write on scope events.write, behind the per-action approval and the
panel's two-step confirm, and their OAuth sign-ins already request the
write access (calendar.events / Calendars.ReadWrite). Both build
create-only POSTs (Google: /calendars/primary/events; Microsoft:
/me/events, times pinned to UTC) with no update or delete actions
anywhere. No other calendar provider has an implemented adapter
(Cal.com is definition-only), so no further calendar writes were added.

This lane stays strictly on the external-provider connector adapters;
the app's ICS/calendar-generator files remain closed and untouched.

Docs: CONNECTOR_CATALOG.md rows already say "read and write actions ...
per-action approval" for both providers from batch 3.

Tests added: create-only build shapes for both providers (URL, JSON
body, UTC pinning, invalid/missing datetimes), identical write
declarations across both providers, validateOnly with no credential,
write approval lifecycle on a calendar event (refuse, run once, dead),
scope/connected refusals for events.write, param refusal before
approval burn, the AI tool never passing an approvalId for a calendar
write, and the panel's calendar-write two-step confirm. Suite 1471/1471.

## Batch 5 (27 Nov 2026): reads for the thin messaging adapters

Discord and Telegram carried only two actions each, so the batch
widens the useful read surface of the three messaging adapters while
keeping every send exactly where it was:

- **Slack `list_users`** (users.read): lists people in the workspace
  with an optional limit capped at 100 (default 50). A new read-only
  users.read scope joins Slack's catalog row.
- **Discord `list_channels`** (guilds.read): lists channels in a guild;
  snowflake ids validated. **`get_channel`** and
  **`list_channel_messages`** (new read-only channels.read scope,
  added to Discord's catalog row): read one channel and its recent
  messages with the limit capped at 100 (default 20).
- **Telegram `get_updates`** (chats.read): reads recent messages and
  updates sent to the bot, optional numeric offset and limit capped at
  100 (default 20); deliberately no long-poll timeout so a call can
  never hold. **`get_chat`** (chats.read): reads one chat by numeric
  id, negative group ids allowed.

All new actions are read-only: they run after connect once their scope
is granted, need no approval, and every existing send still needs the
per-action approval and panel two-step confirm. The new Discord scope
means a future reconnect grants channel reads; existing connections
keep their old grant until the user reconnects.

AI adapters (OpenAI, Anthropic, Gemini) stay at their two actions:
list_models plus one send. A second generate variant would duplicate
the same call shape, so nothing was added there.

Tests: builds and validation for all five new reads (limits, snowflake
and numeric-id rules, no long-poll), declarations, reads running with
no approval, and scope_not_granted when the new scope was not granted.
Suite 1478/1478.

## Batch 6 (27 Nov 2026): practical reads + one new API-key provider

- **GitHub `list_pull_requests` and `list_commits`** (repos.read):
  open pull requests and recent commits for a repository, plain GETs
  with a 20-per-page cap.
- **Notion `get_page_blocks`** (pages.read): reads a page's content
  blocks, page_size capped at 100.
- **Slack `get_channel_history`** (channels.read): recent messages in a
  channel, limit capped at 100 (default 20). The bot needs the matching
  upstream scope (channels:history) as the setup note already says.
- **New adapter: Hugging Face** (token auth): `whoami` checks the token
  and `list_models` searches the Hub, both read-only under models.read.
  Setup is honestly documented: create a read access token at
  huggingface.co/settings/tokens and paste it. The catalog row is now
  marked implemented and states no write actions exist yet; the
  datasets.upload scope stays listed but unused until a real write
  action ships.

All new actions are read-only behind the same connect/scope gates;
sends and writes keep their per-action approval and panel confirm.
No duplicate or no-op actions were added for count.

Tests: builds and validation for all six additions, declarations, the
registry-parity set updated for Hugging Face, reads running with no
approval, and the new adapter refusing without its scope. Suite 1484/1484.

## Batch 7 (27 Nov 2026): public research connectors (arXiv, Crossref, OpenAlex)

Three read-only adapters for public scholarly APIs, all keyless. Their catalog entries already existed as definition-only rows in the expanded tier; batch 7 implements them in place and marks the rows implemented:

- **arXiv** (`papers.read`): `search_papers` (query + optional limit,
  max_results capped at 100, default 20) and `get_paper` (one arXiv id,
  charset-validated). The API returns Atom XML, which the executor keeps
  as raw text when it is not JSON.
- **Crossref** (`works.read`): `search_works` (query, rows capped at
  100, default 20) and `get_work` (DOI validated against the
  `10.registrar/suffix` shape before it is URL-encoded).
- **OpenAlex** (`works.read`): `search_works` (search, per-page capped
  at 100, default 20) and `get_work` (accepts an OpenAlex id `W...` or a
  DOI, optionally `doi:`-prefixed, charset-validated).

Architecture change, kept explicit and small: a new `public` authShape.
These APIs need no account, no key and no vault entry, so

- `connect` accepts a missing `credentialRef` only for catalog entries
  with `auth: 'none'` (a passed ref is still validated);
- the action engine skips credential resolution for `public` adapters;
  the connect + scope gate stays the whole consent story;
- no Authorization header is ever built for these calls, and no secret
  is requested in chat or stored.

Politeness is documented, not encoded as a shared secret: arXiv asks
for about one request every 3 seconds; Crossref and OpenAlex offer an
optional polite-pool `mailto` parameter which this build does not send.
Rate limits live on each catalog row. No write actions exist for any
of the three; sends and writes elsewhere keep their per-action approval
and panel confirm. No duplicate or no-op actions were added for count.

Tests: builds and validation for all six actions, DOI and id shape
checks, declarations, the registry-parity set extended, keyless connect
(no ref, invalid ref refused, valid ref accepted), the engine running
public actions with no credential reader, and the connect gate still
refusing an unscoped or non-user-initiated connect. Suite 1491/1491.

## Batch 8 (27 Nov 2026): Open-Meteo weather + OpenStreetMap Nominatim

Two more keyless public adapters on the batch 7 `public` authShape. Both
catalog rows already existed as definition-only entries and were upgraded
in place.

- **Open-Meteo** (`weather.read`): `get_current_weather` and
  `get_daily_forecast`, both taking strict decimal coordinates
  (latitude within +/-90, longitude within +/-180, no exponent form,
  re-serialized from the parsed number so the URL can only ever carry a
  plain number). Forecast days capped at 16 (default 7).
- **OpenStreetMap** (`places.read`): Nominatim `search_places` (query,
  limit capped at 50, default 10) and `reverse_geocode` (same strict
  coordinate validation). Every call sends the descriptive User-Agent
  the Nominatim usage policy requires; the policy's one-request-per-
  second limit is documented on the catalog row rather than silently
  ignored. No API key exists to request, and none is asked for.

Provider terms honored in documentation and headers: Open-Meteo is free
for non-commercial use within its daily fair-use quota; Nominatim's
polite-use rules live on the catalog row. Nothing auto-connects, no
write actions exist, no external side effects beyond the reads
themselves, and no user-controlled host: both adapters pin their own
API hosts.

Tests: coordinate validation (bounds, non-numeric, exponent form,
missing required params), limit caps, no Authorization header,
descriptive User-Agent on Nominatim, declarations, the registry-parity
set extended, keyless runs behind the connect gate, and the
definition-only counts updated (147 curated+expanded, 143 expanded-only).
Suite 1494/1494.

## Batch 9 (27 Nov 2026): Wikipedia + Open Library keyless reads

Two more keyless public adapters on the batch 7 `public` authShape. Both
catalog rows already existed as definition-only entries and were upgraded
in place; no new rows, so the tier counts are unchanged.

- **Wikimedia** (`search.read`): `search_pages` (MediaWiki
  action=query&list=search against the pinned host en.wikipedia.org,
  srlimit capped at 50, default 10) and `get_page_summary` (Wikipedia
  REST v1 page summary, title URL-encoded, same pinned host). Every
  call sends the descriptive User-Agent Wikimedia's policy requires.
- **Open Library** (`books.read`): `search_books` (search.json, limit
  capped at 100, default 20) and `get_book`, which accepts an ISBN-10,
  ISBN-13, or an Open Library id (edition `OL...M` -> /books/,
  work `OL...W` -> /works/) and refuses everything else, so the path
  can never be shaped by user input. Both actions pin openlibrary.org.

No user-controlled host anywhere: both adapters build their URLs from
their own constants plus encoded, validated parameters. No write
actions, no credentials requested or stored, nothing auto-connects.
Rate limits (Wikimedia polite use, Open Library polite use) live on the
catalog rows.

Tests: pinned-host build shapes for all four actions, identifier
validation (ISBN-10/13, OL...M, OL...W, traversal and junk refused),
limit caps, missing params, no Authorization header, descriptive
User-Agent, declarations, the registry-parity set extended, and keyless
runs behind the connect gate. Suite 1497/1497.

## Batch 10 (27 Nov 2026): Brave Search + Tavily key-auth web search

Two practical web-search adapters on the existing `token` authShape.
Both are new catalog entries (no prior rows existed); both are
read-only single-action adapters.

- **Brave Search** (`search.read`, API key): `web_search` (GET
  api.search.brave.com/res/v1/web/search, count capped at 20, default
  10). The key rides only in the `X-Subscription-Token` header; the URL
  carries the encoded query and nothing credential-shaped.
- **Tavily** (`search.read`, API key): `web_search` (POST
  api.tavily.com/search with a JSON body of query + max_results,
  max_results capped at 20, default 5). The key rides only in the
  `Authorization: Bearer` header, never the URL or body.

Both pin their API host as a build constant, so no user input can shape
the request URL. Credentials flow through the existing vault path:
connect requires a credentialRef, the engine resolves it at run time,
no key is ever requested or echoed in chat, and audit entries keep
carrying status only. Cost and limit notes are honest (free tier with
a monthly allowance; paid plans beyond).

Tests: request construction for both adapters (header placement, body
shape, key never in URL/body), parameter validation (missing query,
count/max_results caps), no-arbitrary-host SSRF checks with hostile
query strings, the registry-parity set extended to both, and the gate
ladder (not_connected before connect, credential_ref_required without
a vault ref, credential_missing when connected but the vault is empty,
and secret-shaped response text scrubbed to REDACTED). Catalog count
pin 183 -> 185 and the category pin gains `search` (27 categories).
Suite 1501/1501.

## Batch 11 (27 Nov 2026): Google Docs + Google Sheets read-only adapters

Both rows existed as definition-only entries in the expanded tier and
were upgraded in place (definition-only counts: expanded 143 -> 141,
overall 147 -> 145). Both run on the existing `oauth_json` shape and
the Google token endpoint the Drive/Gmail adapters already use, so
refresh and rotation behaviour is shared and unchanged.

- **Google Docs** (`documents.read`): `get_document_content` (GET
  docs.googleapis.com/v1/documents/{id}?fields=documentId,title,body,
  document id validated to [A-Za-z0-9_-]+, engine truncation bounds
  the payload). The consent URL requests ONLY the exact least-privilege
  scope `https://www.googleapis.com/auth/documents.readonly`.
- **Google Sheets** (`spreadsheets.read`): `get_values` (GET
  sheets.googleapis.com/v4/spreadsheets/{id}/values/{range},
  spreadsheet id validated to [A-Za-z0-9_-]+, range validated to the
  A1-notation character set and URL-encoded; engine truncation bounds
  the payload). Consent requests ONLY
  `https://www.googleapis.com/auth/spreadsheets.readonly`.

No reconnection is needed for existing accounts: neither entry was
previously connectable, so no old grant exists, and the consent screen
requests only the readonly scopes. The Sheets write scope stays
declared in the catalog but no write action is implemented. No writes
anywhere in this batch; no credentials are requested or shown in chat;
nothing connects or activates by itself.

Tests: exact-scope assertions on both consent URLs, pinned token
endpoint, pinned action hosts, id/range validation (hostile strings
refused), key never in a URL, the gate ladder (not_connected,
credential_ref_required without a vault ref), refresh-before-action
with rotation persisted, and secret-shaped response text scrubbed to
REDACTED. Suite 1504/1504.
