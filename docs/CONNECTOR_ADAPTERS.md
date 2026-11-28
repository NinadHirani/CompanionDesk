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
## Batch 12 (27 Nov 2026): Microsoft Excel + Microsoft Word read-only (Graph)

- `microsoft-excel` (new curated row): `get_workbook_range` reads one range of one worksheet of one workbook by OneDrive item id via `GET https://graph.microsoft.com/v1.0/me/drive/items/{item}/workbook/worksheets/{worksheet}/range(address='{range}')`. Workbook id, worksheet name and A1-style range are validated (path and query are URL-encoded; no slashes, path separators or query injection); the request is session-less (no `workbookSession` persistence) and stays on the pinned `graph.microsoft.com` host. Consent requests only the exact least-privilege Microsoft scope `Files.Read` (plus `offline_access` for refresh tokens), never `Files.ReadWrite`.
- `microsoft-word` (new curated row): `get_document_properties` reads one Drive item's metadata (`id,name,size,lastModifiedDateTime,webUrl`) by id on the same pinned host. Stated limitation: the Graph content endpoint returns Word file content only as binary (.docx) and Microsoft Graph offers no text-extraction endpoint for Word documents, so this adapter reads metadata only; text extraction is not implemented and is not silently approximated.
- Both use the shared Microsoft OAuth template (`login.microsoftonline.com/common/oauth2/v2.0/token`, refresh-token flow) already proven by microsoft-onedrive; token/refresh values come only from the credential vault reference resolved at run time, and refresh-before-action is enforced by the same expired-token path batch 11 tested.
- Catalog count is now 187 (22 legacy + 15 curated + 149 expanded + microsoft-calendar); both new rows are in the curated tier in alphabetical position after microsoft-outlook, and the `microsoft-*` host-pinning suites cover them.
- Tests (batch 12 sections in connector-adapters and connector-actions suites): exact scope equality, consent URL naming only Files.Read, pinned authorize/token endpoints, request-construction shape and encoding, param validation for ids/worksheet/range, missing-param and validateOnly paths, read-only action declarations; engine gates: `not_connected` refusal, `credential_ref_required` before a vault-backed connect, connect on the declared minimal scope, refresh-before-action with the fresh bearer used by the action, no token in URLs, secret-shaped response text redacted.
## Batch 13 (27 Nov 2026): Microsoft Teams read-only (Graph)

- `microsoft-teams` (existing definition-only row upgraded in place, no duplicates): two read-only actions on the pinned `graph.microsoft.com` host. `list_chats` reads the 20 most recent chats via `GET /v1.0/chats?$top=20`; `get_chat_messages` reads the 20 most recent messages of one chat via `GET /v1.0/chats/{chat_id}/messages?$top=20`. Chat ids are validated against the Graph chat-id charset (colons, @, dots, dashes, underscores allowed; no slashes, path separators or query injection) and are URL-encoded into the path. Message pagination beyond the first page is not implemented, stated here rather than approximated.
- Consent requests only the exact least-privilege delegated Microsoft scope `Chat.Read` (plus `offline_access` for refresh tokens), replacing the old definition-only `meetings.read`/`meetings.write` pair: no writes are implemented. Admin-consent limitation documented: `Chat.Read` delegated needs no admin consent in most tenants, but a tenant that blocks user consent needs its admin to approve the app registration once; the setup note and catalog row say so.
- Reuses the shared Microsoft OAuth template and refresh flow proven by microsoft-onedrive (pinned `login.microsoftonline.com/common/oauth2/v2.0/token`, refresh-before-action), with token/refresh values only ever resolved from the credential-vault reference at run time.
- Catalog counts: 187 total unchanged; definition-only curated+expanded is now 144 (the marker test counts 140 still-definition-only expanded entries).
- Tests (batch 13 sections): exact scope equality, consent URL naming only Chat.Read, pinned authorize/token endpoints, request construction for both actions, chat-id validation and URL encoding, missing-param and validateOnly paths, read-only declarations; engine gates: `not_connected` refusal, `credential_ref_required` before a vault-backed connect, connect on the declared minimal scope, refresh-before-action with the fresh bearer, no token in URLs, secret-shaped response text redacted.
## Batch 14 (27 Nov 2026): GitLab read-only on gitlab.com (vault token)

- `gitlab` (existing legacy-tier row upgraded in place, no duplicates): three read-only actions on the pinned `https://gitlab.com/api/v4` host. `search_projects` searches permitted projects (`GET /projects?search=...&per_page=20`), `get_project` reads one project by numeric id or namespace/project path, `list_recent_commits` lists the 20 most recent commits of one project (`GET /projects/{id}/repository/commits?per_page=20`). Search queries are charset-validated and URL-encoded; project identifiers accept only `[A-Za-z0-9_./-]` with `..` rejected, then are URL-encoded into the path. Results are capped at 20 per call.
- Auth is secure-vault token auth: the user pastes their own GitLab personal access token with the least-privilege `read_api` scope, stored only in the app vault, never requested or shown in chat, sent only as the `Authorization: Bearer` header (never in a URL), with the engine redacting secret-shaped response text. The row's auth shape is now `access_token` and its scope list is the single read-only `read_api`, replacing the old definition-only `projects.read`/`projects.write` pair; no writes are implemented.
- Honest limitations stated in the row and setup note: this build talks to gitlab.com only, not a self-hosted instance (the catalog row keeps its self_hostable hosting note, the adapter is pinned); project members/visibility depends on what the token's scope permits.
- The two existing catalog tests that connect gitlab now use the `read_api` scope name.
- Tests (batch 14 sections): pinned host, request construction and URL encoding, identifier and query validation, missing-param and validateOnly paths, read-only declarations; engine gates: `not_connected` refusal, `credential_ref_required` before a vault-backed connect, the vault token reaching only the Authorization header, no token in the URL, `credential_missing` when the vault ref resolves to nothing.
## Batch 15 (27 Nov 2026): Jira Cloud read-only (vault JSON + tenant host validation)

- `jira` (existing expanded-tier row upgraded in place, no duplicates): two read-only actions. `get_issue` reads one issue by key (`GET {tenant}/rest/api/3/issue/{KEY}?fields=summary,status,issuetype,assignee,created,updated`); `search_issues` runs a capped JQL search (`GET {tenant}/rest/api/3/search?jql=...&maxResults=20`). Issue keys are validated against `PROJECT-NUMBER`; JQL is printable-ASCII-validated and fully URL-encoded.
- Tenant host validation (SSF-safe): because every Jira Cloud tenant has its own host, the vault stores a structured credential payload `{host, email, token}` (JSON). Before every request the adapter validates the host strictly: HTTPS only, exactly one subdomain label ending `.atlassian.net` (case-insensitive), no port, no path, no query, no fragment, no embedded credentials, no bare host without a scheme. Any failure refuses with `credential_invalid` rather than pointing the request anywhere else. The validated host is read from the vault payload per run; nothing non-secret is persisted elsewhere.
- Auth: Atlassian API-token basic auth is built per request as `Authorization: Basic base64(email:token)`; the token and email never appear in a URL, log, audit entry or result (the engine redacts secret-shaped response text). Honest scope note: Atlassian API tokens are account-level (Atlassian offers no per-scope API tokens), so least privilege is enforced as a strictly read-only adapter; the row's scope list is the single read-only `issues.read`, replacing the old definition-only `issues.read`/`issues.write` pair; no writes are implemented.
- Setup honesty: in the app the user enters their Atlassian email, API token and tenant site address; all three are stored only in the app vault, never requested or shown in chat.
- Count pins: definition-only curated+expanded is now 143; the marker test counts 139 still-definition-only expanded entries. Catalog total unchanged at 187.
- Tests (batch 15 sections): host-validator accept/refuse matrix (scheme, port, path, query, fragment, userinfo, multi-label subdomain, wrong TLD), credential-payload validation (malformed JSON, missing/short token, bad email, evil host), Basic-auth construction matched byte-for-byte against the RFC encoding, no token in URLs, param validation (issue keys, JQL control chars, missing params), validateOnly paths, read-only declarations; engine gates: `not_connected` refusal, `credential_ref_required` before a vault-backed connect, connect on the declared minimal scope, token only in the Authorization header, `credential_invalid` for an off-tenant host, `credential_missing` when the vault ref resolves empty.
## Batch 16 (27 Nov 2026): MusicBrainz keyless public read-only

- `musicbrainz` (existing expanded-tier row upgraded in place, no duplicates): three keyless public read-only actions. `search_artists` and `search_recordings` (`GET https://musicbrainz.org/ws/2/{artist|recording}?query=...&fmt=json&limit=N`, results capped at 25, printable-ASCII query validation) and `get_artist` (one lookup by MBID, UUID shape validated, `fmt=json`).
- No credentials anywhere: the API is public and free, so the adapter is authShape `public`; requests carry only the pinned `CompanionDesk` User-Agent and an Accept header, and the row stays keyless (`auth: none`). The MusicBrainz one-request-per-second rate limit is documented in the row and the setup note for callers; no writes are implemented.
- Count pins: definition-only curated+expanded is now 142; the marker test counts 138 still-definition-only expanded entries. Catalog total unchanged at 187.
- Tests (batch 16 sections): pinned-host URL construction for both searches and the MBID lookup, limit caps (0 and 26 refused), control-character query refusal, MBID shape validation, validateOnly paths, read-only declarations; engine gates: `not_connected` before connect, keyless connect on the declared scope, pinned user agent on the wire, and the pass-through check that a keyless connector holds no secret to redact (redaction applies to stored credentials, which this adapter never holds).
## Batch 17 (27 Nov 2026): PyPI keyless public read-only (row auth corrected to none)

- `pypi` (existing expanded-tier row upgraded in place, no duplicates): two keyless public read-only actions. `get_package` reads the latest-release metadata (`GET https://pypi.org/pypi/{package}/json`) and `get_release` reads one release (`GET https://pypi.org/pypi/{package}/{version}/json`). Package names are validated against PyPI's name shape (no leading/trailing separators, no path separators, so no traversal); versions allow only PEP-440-style characters and are URL-encoded.
- Honest auth correction: the row previously claimed `api_key`, but the PyPI JSON read API is public and keyless; the row is now `auth: none` with a note that uploading packages is a different, authenticated API this build never touches. Requests carry only the pinned `CompanionDesk` User-Agent; no writes, no credentials.
- Count pins: definition-only curated+expanded is now 141; the marker test counts 137 still-definition-only expanded entries. Catalog total unchanged at 187.
- Tests (batch 17 sections): pinned-host URL construction for both actions, package-name and version validation including path-traversal refusals, validateOnly paths, read-only declarations; engine gates: `not_connected` before connect and keyless connect on the declared scope with the pinned host on the wire.
## Batch 18 (27 Nov 2026): Internet Archive keyless public read-only (row auth corrected to none)

- `internet-archive` (existing curated-tier row upgraded in place, no duplicates): two keyless public read-only actions. `search_items` (`GET https://archive.org/advancedsearch.php?q=...&fl%5B%5D=identifier&fl%5B%5D=title&fl%5B%5D=mediatype&rows=N&output=json&page=1`, results capped at 50, printable-ASCII query validation) and `get_metadata` (`GET https://archive.org/metadata/{identifier}`, identifier charset validated against path-safe characters and URL-encoded).
- Honest auth correction: the row previously claimed `api_key`, but the Internet Archive advanced search and metadata APIs are public and keyless for public items; the row is now `auth: none` with a note that uploading items is an authenticated API this build never touches. The row's `items.upload` write scope is removed accordingly; the scope list is the single read-only `metadata.read`. Requests carry only the pinned `CompanionDesk` User-Agent; no writes, no credentials.
- Count pins unchanged (the row never claimed implementation, so the definition-only totals do not move); catalog total 187.
- Tests (batch 18 sections): pinned-host URL construction for both actions, result caps, control-character query refusal, path-traversal identifier refusal, validateOnly paths, read-only declarations; engine gates: `not_connected` before connect and keyless connect on the declared scope with the pinned host on the wire.
## Batch 19 (27 Nov 2026): Docker Hub keyless public read-only (row auth corrected to none)

- `docker-hub` (existing expanded-tier row upgraded in place, no duplicates): three keyless public read-only actions. `search_repositories` (`GET https://hub.docker.com/v2/search/repositories/?query=...&page_size=N`, results capped at 25, printable-ASCII query validation), `get_repository` (`GET https://hub.docker.com/v2/repositories/{namespace}/{repository}/`) and `get_tags` (same path plus `/tags?page_size=20`, tag list capped at 20). Namespace and repository names are validated against lowercase Docker name shape (no path separators, so no traversal) and URL-encoded.
- Honest auth correction: the row previously claimed `access_token`, but public repository reads on the Hub v2 API are keyless; the row is now `auth: none` with a note that private repositories need authentication this build never requests and that image pulls stay out of scope (the adapter reads metadata only). Requests carry only the pinned `CompanionDesk` User-Agent; no writes, no credentials.
- Count pins: definition-only curated+expanded is now 140; the marker test counts 136 still-definition-only expanded entries. Catalog total unchanged at 187.
- Tests (batch 19 sections): pinned-host URL construction for all three actions, result caps, control-character query refusal, namespace/repository shape validation including path-traversal refusals, validateOnly paths, read-only declarations; engine gates: `not_connected` before connect and keyless connect on the declared scope with the pinned host on the wire.
## Batch 20 (27 Nov 2026): npm registry

Upgraded `npm` from definition-only to a keyless public read-only adapter (`auth: none`, `authShape: public`).

Actions (both read-only, scope `packages.read`, pinned to `registry.npmjs.org` with a `CompanionDesk` user agent):
- `get_package`: full registry metadata for one package, scoped or unscoped; strict name regex (lowercase, `@scope/name` allowed, no slashes beyond the scope separator), name percent-encoded with the `%40` restored to `@` for the registry's path form.
- `search_packages`: capped package search (`size` 1-25) via `/-/v1/search`.

No credentials are collected; the row and this doc say the row is honestly keyless because public package reads are keyless (publishing and private packages need authentication this build never requests). No writes, no registry publish, no npm account access.

Tests: adapter build/validation (13 assertions incl. uppercase-name and unscoped-slash rejection, limit cap), public-gate engine test (not_connected refusal before connect, keyless connect, live read on the pinned host). Catalog count pins updated: 135 still-definition-only expanded rows, 139 definition-only total.
## Batch 21 (27 Nov 2026): Todoist

Upgraded `todoist` from definition-only to a key-bound adapter (`auth: api_key`, `authShape: token`).

Actions:
- `get_projects` (read_only, `tasks.read`): list the user's projects.
- `get_tasks` (read_only, `tasks.read`): list active tasks with optional project_id (alnum-validated), free-text filter, and a 1-100 limit cap.
- `create_task` (write, `tasks.write`): create one task with content (required), optional project_id, due_string and priority 1-4.

The token is the user's own Todoist API token pasted into the app vault; requests carry only `Authorization: Bearer`, pinned to `api.todoist.com` with a CompanionDesk user agent. The write action is single-use approval gated by the policy engine (refused without an approval, dead after one use). No updates, no deletes, no completion writes: the write surface here is create-only by design.

Tests: adapter build/validation (15 assertions incl. priority bounds, project-id charset, limit cap), engine gates (not_connected refusal, credential rides the read, write refused without an approval, approved write runs once, spent approval is dead). Catalog count pins: 134 still-definition-only expanded rows, 138 definition-only total.
## Batch 22 (27 Nov 2026): Airtable

Upgraded `airtable` from definition-only to a key-bound adapter (`auth: api_key`, `authShape: token`).

Actions:
- `list_bases` (read_only, `records.read`): list the bases the token can reach (metadata endpoint).
- `list_records` (read_only, `records.read`): capped table records; base_id strictly validated as 17 alphanumeric chars, table name percent-encoded, maxRecords 1-100.
- `create_record` (write, `records.write`): create one record from a strictly validated fields JSON. Validation rejects anything but an object of at most 20 string keys (max 100 chars) with primitive values (string/number/boolean/null); the body is rebuilt from the parsed values so nothing passes through raw.

The token is the user's own Airtable personal access token pasted into the app vault; requests carry only `Authorization: Bearer`, pinned to `api.airtable.com` with a CompanionDesk user agent. The write action is single-use approval gated by the policy engine (refused without an approval, dead after one use). No updates, no deletes, no schema writes.

Tests: adapter build/validation (16 assertions incl. base-id length, cap bounds, JSON shape and primitive-value rejection), engine gates (not_connected refusal, credential rides the read, write refused without an approval, approved write runs once, spent approval is dead). Catalog count pins: 133 still-definition-only expanded rows, 137 definition-only total.
## Batch 23 (27 Nov 2026): Linear

Upgraded `linear` from definition-only to a key-bound adapter (`auth: api_key`, `authShape: token`).

Actions (all GraphQL POSTs to the pinned `api.linear.app/graphql`; user input travels in GraphQL variables, never interpolated into the query text):
- `list_issues` (read_only, `issues.read`): recent issues, limit 1-25.
- `get_issue` (read_only, `issues.read`): one issue by id (charset-validated).
- `create_issue` (write, `issues.write`): create an issue with team_id (charset-validated), title (required) and optional description.

The key is the user's own Linear personal API key pasted into the app vault; requests carry only `Authorization: <key>` per Linear's documented header form, plus a CompanionDesk user agent. The write action is single-use approval gated by the policy engine (refused without an approval, dead after one use). No updates, no deletes, no status changes.

Tests: adapter build/validation (12 assertions incl. variable-based bodies, charset rejects, limit cap), engine gates (not_connected refusal, credential rides the read, write refused without an approval, approved write runs once, spent approval is dead). Catalog count pins: 132 still-definition-only expanded rows, 136 definition-only total.
## Batch 24 (27 Nov 2026): Trello

Upgraded `trello` from definition-only to a key+token adapter (`auth: api_key` row, `authShape: url_token`).

Actions (pinned to `api.trello.com/1`; the power-up key and token ride the query string under the url_token scheme, never a log-safe header):
- `list_boards` (read_only, `boards.read`): your boards, fields name/url, limit 1-100.
- `get_board_lists` (read_only, `boards.read`): one board's lists, board id charset-validated, limit 1-100.
- `get_cards` (read_only, `boards.read`): one list's cards, fields name/url, limit 1-100.
- `create_card` (write, `boards.write`): create a card in a list (list_id charset-validated, name required, optional desc, all percent-encoded into the query).

The credential is one vault string the user pastes in the documented format `key=YOURKEY&token=YOURTOKEN` (their own Trello power-up key and token); a malformed string refuses with `credential_invalid` before any request is built, and both halves are charset- and length-validated. The write action is single-use approval gated by the policy engine (refused without an approval, dead after one use). No updates, no deletes, no moves.

Tests: adapter build/validation (10 assertions incl. malformed-credential refusal, key/token in the query string, charset rejects, limit cap), engine gates (not_connected refusal, key/token ride the url on a read, write refused without an approval, approved write runs once, spent approval is dead). Catalog count pins: 131 still-definition-only expanded rows, 135 definition-only total.
## Batch 25 (27 Nov 2026): Coda

Upgraded `coda` from definition-only to a key-bound adapter (`auth: api_key`, `authShape: token`).

Actions (pinned to `coda.io/apis/v1`, Bearer token):
- `list_docs` (read_only, `docs.read`): your docs, limit 1-100.
- `get_doc` (read_only, `docs.read`): one doc by id (charset-validated).
- `create_doc` (write, `docs.write`): create a doc with a required title; the body is a rebuilt `{ title }` object.

The token is the user's own Coda API token pasted into the app vault. The write action is single-use approval gated by the policy engine (refused without an approval, dead after one use). No edits to existing docs, no deletes, no rows or table writes.

Tests: adapter build/validation (9 assertions incl. charset reject, title requirement, limit cap), engine gates (not_connected refusal, credential rides the read, write refused without an approval, approved write runs once, spent approval is dead). Catalog count pins: 130 still-definition-only expanded rows, 134 definition-only total.
## Batch 26 (27 Nov 2026): CircleCI

Upgraded `circleci` from definition-only to a key-bound READ-ONLY adapter (`auth: api_key`, `authShape: token`).

Actions (pinned to `circleci.com/api/v2`, auth rides the `Circle-Token` header):
- `get_me` (read_only, `pipelines.read`): token check against the authenticated user.
- `list_projects` (read_only, `pipelines.read`): your projects, page-size 1-100.
- `get_pipeline` (read_only, `pipelines.read`): one pipeline by id (charset-validated).

The token is the user's own CircleCI personal API token pasted into the app vault. The row declares no write scope, so there is no approval-gated action: the adapter is read-only end to end. No writes, no triggers, no cancels.

Tests: adapter build/validation (7 assertions incl. charset reject, id requirement, limit cap, read-only sweep), engine gates (not_connected refusal, credential rides the Circle-Token header). Catalog count pins: 129 still-definition-only expanded rows, 133 definition-only total.
## Batch 27 (27 Nov 2026): SendGrid, Mailgun, Postmark stats reads

Upgraded three mailer connectors to key-bound READ-ONLY adapters (each `auth: api_key`, `authShape: token`); their `mail.send` scope stays NOT implemented in this build: nothing sends.

Actions:
- SendGrid (pinned `api.sendgrid.com/v3`, Bearer): `get_scopes` token check; `get_stats` with required start_date (validated YYYY-MM-DD), optional end_date, aggregated_by day/week/month (defaults day, invalid values refuse).
- Mailgun (pinned `api.mailgun.net/v3`, Basic auth as user `api` with the key as password): `list_domains` limit 1-100; `get_domain` by name (charset-validated domain).
- Postmark (pinned `api.postmarkapp.com`, `X-Postmark-Server-Token` header): `get_bounces` count 1-100 from offset 0; `get_bounce` by numeric id.

The credentials are the user's own keys/tokens pasted into the app vault. No send, no writes anywhere; the adapters expose only the read actions above.

Tests: adapter build/validation per mailer (date and bucket validation, basic-auth header shape, numeric-id validation, caps, read-only sweeps), engine gates (each refuses before connect and rides its credential on a read; Mailgun's header asserted against the computed Basic value). Catalog count pins: 126 still-definition-only expanded rows, 130 definition-only total.
## Batch 28 (27 Nov 2026): Render, Supabase

Upgraded two developer connectors to key-bound READ-ONLY adapters (each `auth: api_key`, `authShape: token`).

Actions:
- Render (pinned `api.render.com/v1`, Bearer): `list_services` limit 1-100; `get_service` by id (charset-validated).
- Supabase (pinned `api.supabase.com/v1`, Bearer management token): `list_projects` limit 1-100 with offset 0; `get_project` by ref (lowercase alnum + dash only).

The credentials are the user's own keys pasted into the app vault. No writes, no deploys, no restarts, no table reads of user data, no key retrieval anywhere.

Tests: adapter build/validation per connector (charset rejects, id requirements, limit caps, read-only sweeps), engine gates (each refuses before connect and rides its credential on a read). Catalog count pins: 124 still-definition-only expanded rows, 128 definition-only total.
## Batch 29 (27 Nov 2026): Heroku

Upgraded Heroku to a token-bound READ-ONLY adapter (`auth: api_key`, `authShape: token`).

Actions (pinned `api.heroku.com`, Bearer plus the Heroku API v3 `Accept: application/vnd.heroku+json; version=3` header):
- `list_apps` limit 1-100;
- `get_app` by name or id (charset-validated);
- `get_app_dynos` for one app.

The credential is the user's own API token pasted into the app vault. No writes, no scaling, no restarts, no config changes anywhere.

Jenkins stays definition-only deliberately: it is self-hostable, so it has no single pinned host; an adapter for it would need each user's own server address, a different setup shape.

Tests: adapter build/validation (v3 Accept header, charset rejects, id requirement, limit cap, read-only sweep), engine gate (refuses before connect, credential rides the header). Catalog count pins: 123 still-definition-only expanded rows, 127 definition-only total.
## Batch 30 (27 Nov 2026): Sentry, PagerDuty

Upgraded two monitoring connectors to token-bound READ-ONLY adapters (each `auth: api_key`, `authShape: token`).

Actions:
- Sentry (pinned `sentry.io/api/0`, Bearer): `list_org_issues` for an organization you name (lowercase slug, count 1-100); `get_issue` by id (charset-validated).
- PagerDuty (pinned `api.pagerduty.com`, `Token token=` auth plus `Accept: application/vnd.pagerduty+json;version=2`): `list_incidents` limit 1-25 from offset 0; `get_incident` by id (charset-validated).

The credentials are the user's own tokens pasted into the app vault. No writes, no resolving/muting, no acknowledges/resolutions anywhere.

Tests: adapter build/validation per connector (slug and id charset rejects, required params, caps, header shapes, read-only sweeps), engine gates (each refuses before connect and rides its credential on a read). Catalog count pins: 121 still-definition-only expanded rows, 125 definition-only total.
## Batch 31 (27 Nov 2026): Cloudflare, DigitalOcean

Upgraded two cloud connectors to token-bound READ-ONLY adapters (each `auth: api_key`, `authShape: token`).

Actions:
- Cloudflare (pinned `api.cloudflare.com/client/v4`, Bearer): `verify_token` (GET /user/tokens/verify); `list_zones` per_page 1-50.
- DigitalOcean (pinned `api.digitalocean.com/v2`, Bearer): `list_droplets` per_page 1-100, page 1; `get_droplet` by numeric id (charset-validated).

The credentials are the user's own tokens pasted into the app vault. No writes, no DNS changes, no purges, no rebuilds, no deletes anywhere. DigitalOcean's page cap aligns with the shared integer helper's 100 bound (the DO API's own 200 per page is not reachable through this helper).

Tests: adapter build/validation per connector (caps, numeric-id reject, required param, header shapes, read-only sweeps), engine gates (each refuses before connect and rides its credential on a read). Catalog count pins: 119 still-definition-only expanded rows, 123 definition-only total.
## Batch 32 (27 Nov 2026): TMDB, Unsplash

Upgraded two media connectors to token-bound READ-ONLY adapters (each `auth: api_key`, `authShape: token`).

Actions:
- TMDB (pinned `api.themoviedb.org/3`, Bearer with the v3 read access token): `search_movies` (query required maxLength 100, page 1-100); `get_movie` by numeric id (charset-validated).
- Unsplash (pinned `api.unsplash.com`, `Authorization: Client-ID` header): `search_photos` (query required, per_page 1-30); `get_photo` by id (charset-validated).

The credentials are the user's own keys pasted into the app vault. No writes anywhere.

PostHog deliberately stays definition-only: it is self-hostable, so it has no single pinned host, the same setup-shape reasoning as Jenkins.

Tests: adapter build/validation per connector (required query, numeric-id reject, page and per-page caps, percent-encoding, header shapes, read-only sweeps), engine gates (each refuses before connect and rides its credential on a read). Catalog count pins: 117 still-definition-only expanded rows, 121 definition-only total.
## Batch 33 (27 Nov 2026): New Relic, Pinecone

Upgraded two cloud connectors to token-bound READ-ONLY adapters (each `auth: api_key`, `authShape: token`).

Actions:
- New Relic (pinned `api.newrelic.com/v2`, `X-Api-Key` header): `list_applications` (per_page 1-100, page 1); `get_application` by numeric id (charset-validated). No data-in queries, no config changes.
- Pinecone (pinned `api.pinecone.io`, `Api-Key` header plus a pinned `X-Pinecone-API-Version: 2025-01`): `list_indexes`; `get_index` by name (charset-validated `[a-z0-9-]`). No vector reads, no creates, no deletes.

The credentials are the user's own keys pasted into the app vault.

Tests: adapter build/validation per connector (caps, numeric-id reject, required param, header shapes including the pinned Pinecone version header, read-only sweeps), engine gates (each refuses before connect and rides its credential on a read). One test-side fix: the gate test's header check now uses a substring test over the header values instead of an array index bound. Catalog count pins: 115 still-definition-only expanded rows, 119 definition-only total.
## Batch 34 (27 Nov 2026): Pexels, Kaggle

Upgraded two connectors to credential-bound READ-ONLY adapters (each `auth: api_key`, `authShape: token`).

Actions:
- Pexels (pinned `api.pexels.com/v1`, key directly in the `Authorization` header): `search_photos` (query required maxLength 100, per_page 1-80); `get_photo` by numeric id (charset-validated).
- Kaggle (pinned `www.kaggle.com/api/v1`, Basic auth computed from the pasted `username:key` credential, the same one-secret shape as Trello's key&token): `list_datasets` (optional search maxLength 80, page 1-20).

The credentials are the user's own keys pasted into the app vault. Kaggle's `notebooks.write` scope is never requested and nothing is uploaded anywhere.

Tests: adapter build/validation per connector (caps, numeric-id reject, required query, computed Basic value assertion for Kaggle, read-only sweeps), engine gates (each refuses before connect and rides its credential on a read; per-action params kept strict so undeclared params fail). Catalog count pins: 113 still-definition-only expanded rows, 117 definition-only total.
## Batch 35 (27 Nov 2026): Stripe, Groq

Upgraded two connectors to token-bound READ-ONLY adapters (each `auth: api_key`, `authShape: token`).

Actions:
- Stripe (pinned `api.stripe.com/v1`, Bearer; the setup note steers the user to a RESTRICTED key with charges read access): `list_charges` (limit 1-100, default 25); `get_charge` by id (charset-validated `[A-Za-z0-9_]+`). No refunds, no captures, no payouts, no account changes.
- Groq (pinned `api.groq.com/openai/v1`, Bearer): `list_models` only. The `completions.send` scope is never requested and nothing is sent to a model.

The credentials are the user's own keys pasted into the app vault.

Tests: adapter build/validation per connector (caps, id reject, required param, header shapes, read-only sweeps, the one-action Groq pin), engine gates (each refuses before connect and rides its credential on a read). Catalog count pins: 111 still-definition-only expanded rows, 115 definition-only total.
## Batch 36 (27 Nov 2026): Cohere, xAI

Upgraded two ai_cloud connectors to token-bound READ-ONLY adapters (each `auth: api_key`, `authShape: token`).

Actions:
- Cohere (pinned `api.cohere.com/v1`, Bearer): `list_models` only. The `completions.send` scope is never requested and nothing is sent to a model.
- xAI (pinned `api.x.ai/v1`, Bearer): `list_models` only. Same completions rule.

The credentials are the user's own keys pasted into the app vault.

Tests: adapter build/validation (one-action pins, header shapes, read-only sweeps, completions never present), engine gates (each refuses before connect and rides its credential on a read). Catalog count pins: 109 still-definition-only expanded rows, 113 definition-only total.
## Batch 37 (27 Nov 2026): Mistral AI, OpenRouter

Upgraded two ai_cloud connectors to token-bound READ-ONLY adapters (each `auth: api_key`, `authShape: token`).

Actions:
- Mistral AI (pinned `api.mistral.ai/v1`, Bearer): `list_models` only. The `completions.send` scope is never requested and nothing is sent to a model.
- OpenRouter (pinned `openrouter.ai/api/v1`, Bearer): `list_models` only. Same completions rule.

The credentials are the user's own keys pasted into the app vault.

Tests: adapter build/validation (one-action pins, header shapes, read-only sweeps, completions never present), engine gates (each refuses before connect and rides its credential on a read). Catalog count pins: 107 still-definition-only expanded rows, 111 definition-only total.
## Batch 38 (27 Nov 2026): Replicate, Together AI

Upgraded two ai_cloud connectors to token-bound READ-ONLY adapters (each `auth: api_key`, `authShape: token`).

Actions:
- Replicate (pinned `api.replicate.com/v1`, Bearer): `list_models` only (your account's models). The `predictions.send` scope is never requested and nothing is run on a model.
- Together AI (pinned `api.together.xyz/v1`, Bearer): `list_models` only. The `completions.send` scope is never requested and nothing is sent to a model.

The credentials are the user's own keys pasted into the app vault.

Tests: adapter build/validation (one-action pins, header shapes, read-only sweeps, sends never present), engine gates (each refuses before connect and rides its credential on a read). Catalog count pins: 105 still-definition-only expanded rows, 109 definition-only total.
## Batch 39 (27 Nov 2026): Stability AI, ElevenLabs

Upgraded two ai_cloud connectors to token-bound READ-ONLY adapters (each `auth: api_key`, `authShape: token`).

Actions:
- Stability AI (pinned `api.stability.ai/v1`, Bearer): `list_engines` (the engine list available to your key). The `images.generate` scope is never requested and nothing is generated.
- ElevenLabs (pinned `api.elevenlabs.io/v1`, `xi-api-key` header): `list_voices` (the voices in your account). The `speech.send` scope is never requested and nothing is synthesized.

The credentials are the user's own keys pasted into the app vault.

Tests: adapter build/validation (one-action pins, header shapes, read-only sweeps, sends never present), engine gates (each refuses before connect and rides its credential on a read). Catalog count pins: 103 still-definition-only expanded rows, 107 definition-only total.
## Batch 40 (27 Nov 2026): Google Maps Platform, Mapbox

Upgraded two maps connectors to key-bound READ-ONLY adapters (each `auth: api_key`, `authShape: token`). Both ride the key in the request URL (the providers' GET shape), so no headers are built for them.

Actions:
- Google Maps Platform (pinned `maps.googleapis.com/maps/api`): `geocode_address` (address required maxLength 200, key as the `key` query param). No routes, no places searches, no writes.
- Mapbox (pinned `api.mapbox.com/directions`): `get_driving_route` between two `lon,lat` points (both required, strict coordinate validation, token as the `access_token` query param).

The credentials are the user's own keys pasted into the app vault.

Tests: adapter build/validation (required params, caps, coordinate-format reject, exact built URLs, read-only sweeps), engine gates (each refuses before connect and its credential rides the request URL). Catalog count pins: 101 still-definition-only expanded rows, 105 definition-only total.
## Batch 41 (27 Nov 2026): Deepgram, AssemblyAI

Upgraded two speech connectors to key-bound READ-ONLY adapters (each `auth: api_key`, `authShape: token`).

Actions:
- Deepgram (pinned `api.deepgram.com/v1`): `list_projects` (Bearer `Token <key>` header). No transcription submission ever.
- AssemblyAI (pinned `api.assemblyai.com/v2`): `list_transcripts` (Bearer header, optional limit 1-100). No transcription submission ever.

The credentials are the user's own keys pasted into the app vault.

Tests: adapter build/validation (exact URLs, limit bounds, read-only sweeps), engine gates (each refuses before connect and its credential rides the Authorization header). Catalog count pins: 99 still-definition-only expanded rows, 103 definition-only total.
## Batch 42 (28 Nov 2026): Plausible, Amplitude

Upgraded two analytics connectors to key-bound READ-ONLY adapters (each `auth: api_key`, `authShape: token`).

Actions:
- Plausible (pinned `plausible.io/api/v1`): `list_sites` (Bearer header). Self-hosted instances use their own URL and are outside the pinned host; noted in the catalog and docs. No stats queries in this build.
- Amplitude (pinned `api2.amplitude.com/2`): `list_projects` (Bearer Management API token). No event queries or chart exports in this build.

The credentials are the user's own keys pasted into the app vault.

Tests: adapter build (exact URLs, single-action shapes, read-only sweeps), engine gates (each refuses before connect and its credential rides the Authorization header). Catalog count pins: 97 still-definition-only expanded rows, 101 definition-only total.
## Batch 43 (28 Nov 2026): Mixpanel, PostHog

Upgraded two analytics connectors to key-bound READ-ONLY adapters (each `auth: api_key`, `authShape: token`).

Actions:
- Mixpanel (pinned `mixpanel.com/api/app`): `list_projects` (Bearer service-account token). No event queries in this build.
- PostHog (pinned to the US cloud `us.posthog.com/api`): `get_current_project` (Bearer personal API key). EU cloud and self-hosted instances use their own URL and are outside the pinned host; noted in the catalog and docs. No event queries in this build.

The credentials are the user's own keys pasted into the app vault.

Tests: adapter build (exact URLs, single-action shapes, read-only sweeps), engine gates (each refuses before connect and its credential rides the Authorization header). Catalog count pins: 95 still-definition-only expanded rows, 99 definition-only total.
## Batch 44 (28 Nov 2026): Flickr, Pipedrive

Upgraded two connectors to key-bound READ-ONLY adapters (each `auth: api_key`, `authShape: token`). Both ride the key in the request URL (the providers' GET shape).

Actions:
- Flickr (pinned `api.flickr.com/services`): `search_photos` (query required maxLength 100, per_page capped 1-10 default 10, key as the `api_key` query param, JSON format). No uploads, favorites or writes.
- Pipedrive (pinned `api.pipedrive.com/v1`): `list_deals` (limit capped 1-100 default 25, token as the `api_token` query param). No deal writes.

The credentials are the user's own keys pasted into the app vault.

Tests: adapter build/validation (required params, caps, exact built URLs, read-only sweeps), engine gates (each refuses before connect and its credential rides the request URL). Catalog count pins: 93 still-definition-only expanded rows, 97 definition-only total.
## Batch 45 (28 Nov 2026): Razorpay, Zerodha Kite

Upgraded two finance connectors to key-bound READ-ONLY adapters (each `auth: api_key`, `authShape: token`).

Actions:
- Razorpay (pinned `api.razorpay.com/v1`): `list_payments` (count capped 1-100 default 25, Basic auth computed from a pasted `key_id:key_secret` pair). No captures, refunds, orders or writes.
- Zerodha Kite (pinned `api.kite.trade`): `get_user_profile` (Authorization `Token <api_key:access_token>`, `X-Kite-Version: 3`). `orders.write` is never implemented in this build.

The credentials are the user's own keys pasted into the app vault.

Tests: adapter build/validation (exact URLs, count bounds, computed-Basic header asserted against the expected value, read-only sweeps), engine gates (each refuses before connect; razorpay's credential rides as the computed Basic value, zerodha-kite's rides the Token header). Catalog count pins: 91 still-definition-only expanded rows, 95 definition-only total.
## Batch 46 (28 Nov 2026): Upstox, Udemy

Upgraded two connectors to key-bound READ-ONLY adapters (each `auth: api_key`, `authShape: token`).

Actions:
- Upstox (pinned `api.upstox.com/v2`): `get_user_profile` (Bearer access token). No holdings, orders or writes in this build.
- Udemy (pinned `www.udemy.com/api-2.0`): `search_courses` (query required maxLength 100, page_size capped 1-20 default 10, Basic auth computed from pasted affiliate `client_id:client_secret`). No enrollments or writes.

The credentials are the user's own keys pasted into the app vault.

Tests: adapter build/validation (exact URLs, caps, computed-Basic header asserted against the expected value, read-only sweeps), engine gates (each refuses before connect; upstox's credential rides the Bearer header, udemy's rides the computed Basic value). Catalog count pins: 89 still-definition-only expanded rows, 93 definition-only total.
## Batch 47 (28 Nov 2026): Trakt, Hetzner Cloud

Upgraded two connectors to key-bound READ-ONLY adapters (each `auth: api_key`, `authShape: token`).

Actions:
- Trakt (pinned `api.trakt.tv`): `list_trending_movies` (limit 1-10 default 5, `trakt-api-key` client id header, `trakt-api-version: 2`). No check-ins, scrobbles or writes.
- Hetzner Cloud (pinned `api.hetzner.cloud/v1`): `list_servers` (page 1-100 default 1, Bearer token). No create, power or writes.

The credentials are the user's own keys pasted into the app vault.

Tests: adapter build/validation (exact URLs, caps, header shape, read-only sweeps), engine gates (each refuses before connect; trakt's credential rides the trakt-api-key header, hetzner's rides the Bearer header). Catalog count pins: 87 still-definition-only expanded rows, 91 definition-only total.
## Batch 48 (28 Nov 2026): Better Stack, Backblaze B2

Upgraded two connectors to key-bound READ-ONLY adapters (each `auth: api_key`, `authShape: token`).

Actions:
- Better Stack (pinned `api.betterstack.com/api/v1`): `list_monitors` (page 1-100 default 1, Bearer token). No pause, delete or writes.
- Backblaze B2 (pinned `api.backblazeb2.com/b2api/v2`): `list_buckets` (maxBucketCount 100, the raw application-key token rides the Authorization header with no Bearer prefix, B2's own list call is a POST). No upload, delete or writes.

The credentials are the user's own keys pasted into the app vault.

Tests: adapter build/validation (exact URLs, caps, raw-token header, read-only sweeps), engine gates (each refuses before connect; better-stack's credential rides the Bearer header, backblaze-b2's rides the raw token). Catalog count pins: 85 still-definition-only expanded rows, 89 definition-only total.
## Batch 49 (28 Nov 2026): Tripadvisor, Datadog

Upgraded two connectors to key-bound READ-ONLY adapters (each `auth: api_key`, `authShape: token`).

Actions:
- Tripadvisor (pinned `terra.tripadvisor.com/api`, the Terra successor to the legacy Content API sunset 2026-08-31): `search_locations` (query required up to 500 chars, size 1-20 default 20, category RESTAURANT/ATTRACTION/HOTEL uppercased) and `get_location_details` (integer id), keyed by the `X-API-Key` header. No reviews, photos beyond search, or writes.
- Datadog (pinned `api.datadoghq.com`, the US site): `list_monitors` (page_size 1-100 default 25, credentials split from a pasted `api_key:application_key` pair into `DD-API-KEY` + `DD-APPLICATION-KEY` headers). No monitors are changed or written.

The credentials are the user's own keys pasted into the app vault.

Tests: adapter build/validation (exact URLs, caps, category whitelist, integer id bounds, dual-key headers, read-only sweeps), engine gates (each refuses before connect; tripadvisor's credential rides X-API-Key, datadog's rides the DD-API-KEY/DD-APPLICATION-KEY pair). Catalog count pins: 83 still-definition-only expanded rows, 87 definition-only total.
