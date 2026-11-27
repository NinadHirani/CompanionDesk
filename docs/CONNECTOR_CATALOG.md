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

The AI can also ASK for a connection (27 Nov 2026 decision): its connector_status tool lists the catalog's live states and may raise a user-facing connect request naming one catalog connector and a short reason. The request appears in the Workspace panel's Connectors section; approving it is an explicit click that runs the SAME connect gate as the user's own pick, dismissing it just resolves the request. A request is never a grant and nothing auto-connects.
