# Connector catalog (Gate 2, shipped read-only)

This page documents the connector discovery catalog that ships inside CompanionDesk. It is generated from `src/connectors.js` and verified against it by `tests/connector-catalog-doc.test.js`, so the doc and the code cannot drift.

## Activation gate

Nothing auto-connects. The module constant AUTO_CONNECT is false, the catalog is not registered as an agent tool in main.js, and every entry starts in the `discovered` state with zero connections. Activation requires explicit user selection per connector: you pick one, approve the exact scopes for it, and provide its credential through secure storage before anything is connected. Scopes in the write, send, delete, external and sensitive classes each require an approval gate; read-only scopes do not. Cost and limits are surfaced here and in the panel BEFORE any activation.

## Catalog

| id | name | category | hosting | cost model | cost note | limits | scopes (class) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `gitlab` | GitLab | code | self_hostable | free_open_source | Free, open-source; self-host or use the free tier | Free tier rate limits per user | projects.read (read_only), projects.write (write) |
| `grafana` | Grafana | monitoring | self_hostable | free_open_source | Free open-source tier; cloud tiers are paid | Self-hosted: your hardware; cloud: plan quotas | dashboards.read (read_only), dashboards.write (write), alerting.delete (delete) |
| `home-assistant` | Home Assistant | home | self_hostable | free_open_source | Free, open-source home automation | Bound by your own hub | state.read (read_only), service.call (write) |
| `jellyfin` | Jellyfin | media | self_hostable | free_open_source | Free, open-source media server | Bound by your own server | library.read (read_only) |
| `joplin` | Joplin | notes | self_hostable | free_open_source | Free, open-source notes; sync target may cost | Sync storage quota | notes.read (read_only), notes.write (write) |
| `mastodon` | Mastodon | social | self_hostable | free_open_source | Free, open-source; most instances are free | Instance rate limits apply | timeline.read (read_only), post.write (write) |
| `matrix` | Matrix | messaging | self_hostable | free_open_source | Free, open-source; self-host or use free homeservers | Homeserver rate limits apply | rooms.read (read_only), message.send (send) |
| `miniflux` | Miniflux | feeds | self_hostable | free_open_source | Free, open-source feed reader | Bound by your own server | entries.read (read_only) |
| `nextcloud` | Nextcloud | files | self_hostable | free_open_source | Free, open-source; self-hosted or free-tier providers | Storage quota of the chosen server | files.read (read_only), files.write (write) |
| `ollama` | Ollama (local models) | ai_local | local | free_open_source | Free, open-source; runs on your own machine | Bound by local hardware and model sizes | model.infer (read_only) |
| `rss` | RSS feeds | feeds | local | free_open_source | Free; RSS feeds are open by design | Bound by each feed publisher | feed.read (read_only) |
| `healthchecks-io` | healthchecks.io | monitoring | self_hostable | free_open_source | Free open-source; the hosted tier is free for 20 checks | Hosted free tier: 20 checks | checks.read (read_only), pings.send (send) |
| `internet-archive` | Internet Archive | reference | cloud | free_open_source | Free, non-profit archive | Upload throttling applies | metadata.read (read_only), items.upload (write) |
| `openlibrary` | Open Library | reference | cloud | free_open_source | Free; Open Library is an open project | Polite-use rate limits | books.read (read_only) |
| `wikimedia` | Wikimedia | reference | cloud | free_open_source | Free; Wikimedia APIs are open | Polite-use rate limits; a user agent is required | search.read (read_only) |
| `github` | GitHub | code | cloud | free_tier | Free for public repos; paid plans for private features | 5,000 REST requests per hour on the free tier | repos.read (read_only), issues.write (write) |
| `huggingface` | Hugging Face | ai_cloud | cloud | free_tier | Free tier; paid compute is optional | Free tier API rate limits apply | models.read (read_only), datasets.upload (write) |
| `open-meteo` | Open-Meteo | weather | cloud | free_tier | Free for non-commercial use | Free tier daily API call quota | weather.read (read_only) |
| `openai` | OpenAI | ai_cloud | cloud | paid | Paid per token; the API has no free tier | Model-dependent rate and token limits | models.read (read_only), completions.send (send) |
| `twilio` | Twilio | messaging | cloud | paid | Paid per message or minute; trial credit only | Per-message and per-minute billing | messages.send (send) |

Sorted free-first: local and self-hostable free/open-source entries first, free-tier cloud next, paid last. The catalog above carries 20 shipped entries; it is extensible only through reviewed registration (MAX_EXTRA additions, each validated and audited), never by inventing entries.

Status 27 Nov 2026: shipped and documented, nothing connected, no credentials requested, no permissions granted. Naming a real service to activate and approving each per-connector activation remain the owner's calls.

## Credential storage (Gate 2 credential step, 27 Nov 2026)

Connecting requires a stored credential, and the credential lives in the OS
credential vault only. src/connector-credential-store.js holds ONE opaque
secret per connector id (an API key, a token, whatever the service layer of a
later step needs), encrypted by Electron's safeStorage (Keychain on macOS,
DPAPI on Windows, libsecret/KWallet on Linux) into a 0600 file under the
app's userData directory. Fail closed: if the OS cannot encrypt (or on Linux
the backend is not a real secret service), nothing is saved and the connect
keeps refusing with `credential_ref_required`.

What is stored where, and where it never goes:

- The plaintext secret: only in the OS-vault-encrypted file, decrypted in the
  main process when a service call needs it. Never in settings, SQLite,
  localStorage, logs or the renderer.
- Settings: only connection ids, states, exact scopes and request text. The
  credential reference is deterministic from the id
  (`keychain:companiondesk-<id>`), so a restart re-derives it from the vault
  after the snapshot is restored; nothing about credentials is persisted.
- Disconnect and revoke both delete the stored credential: authorization is
  persistent until the user disconnects, and a reconnect is a fresh explicit
  connect with a fresh credential entry. Removing a credential is refused
  while the connector is connected (disconnect first).
- The Connectors panel shows a password field for a connector with no stored
  credential; the typed value goes straight to main's vault and is never
  rendered or kept. A connector that already has one connects with the plain
  button, no repeated prompt.

The store is service-agnostic and performs no network calls; nothing is
connected by this step. Naming a real service, providing its credential and
approving each activation remain the owner's calls.

The AI can also ASK for a connection (27 Nov 2026 decision): its connector_status tool lists the catalog's live states and may raise a user-facing connect request naming one catalog connector and a short reason. The request appears in the Workspace panel's Connectors section; approving it is an explicit click that runs the SAME connect gate as the user's own pick, dismissing it just resolves the request. A request is never a grant and nothing auto-connects.

## Custom connectors (marketplace slice, 27 Nov 2026)

The Connectors section is no longer read-only: the user can add a connector
for an app/website that is not in the built-in catalog, and the panel gained
a client-side search box and a category filter over the full list.

What a custom connector is, honestly:

- A DEFINITION plus, for key/token types, one credential in the OS vault.
  The panel labels every custom row with its readiness note, and
  `authorizeCall` refuses custom entries with `integration_not_implemented`,
  so a custom connector can never claim a working integration. The connect
  gate itself is unchanged (explicit user action, exact declared scopes, an
  opaque credential reference) and the connection persists until the user
  disconnects, exactly like a built-in one.
- Safe auth-type allowlist: `api_key`, `access_token`, `oauth2`, `webhook`,
  `website`. OAuth is labelled as not implemented (no provider-backed flow
  in this build); webhook/website URLs are stored as definitions only.
- URL rules: https only (http accepted for loopback hosts only), no
  userinfo and no query strings, so a secret can never ride inside a stored
  URL. Bounded at 2048 characters.
- Scopes are exact and never guessed: the form takes `name:class` pairs
  (e.g. `events.read:read_only, events.write:write`) and the core validates
  both halves against the same scope rules as the built-in catalog.
- Bounded at 50 custom entries; ids are unique across built-ins, reviewed
  registrations and customs; removing is user-initiated, refused while
  connected, and also drops the stored credential.
- Persistence: custom definitions ride the catalog snapshot (states, exact
  grants, definitions only, never credential material) and restore fails
  closed on an invalid definition. The audit log carries ids, actions and
  scopes only; it never carries an URL or a credential.

New channels: `workspace:connectorCustomAdd` and
`workspace:connectorCustomRemove` (renderer gestures; main builds
`userInitiated`). The AI sees custom entries through the ordinary catalog
surface (`list`/`describe`/`connector_status`) and can request a connection
through the existing request center; approval still runs the same explicit
connect gate. No real service is activated by any of this until the user
chooses one, enters its credential and approves its scopes.
