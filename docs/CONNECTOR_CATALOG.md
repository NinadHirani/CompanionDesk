# Connector catalog (Gate 2, shipped read-only)

This page documents the connector discovery catalog that ships inside CompanionDesk. It is generated from `src/connectors.js` and verified against it by `tests/connector-catalog-doc.test.js`, so the doc and the code cannot drift.

## Activation gate

Nothing auto-connects. The module constant AUTO_CONNECT is false, the catalog is not registered as an agent tool in main.js, and every entry starts in the `discovered` state with zero connections. Activation requires explicit user selection per connector: you pick one, approve the exact scopes for it, and provide its credential through secure storage before anything is connected. Scopes in the write, send, delete, external and sensitive classes each require an approval gate; read-only scopes do not. Cost and limits are surfaced here and in the panel BEFORE any activation.

## Catalog

| id | name | provider | category | hosting | cost model | cost note | limits | scopes (class) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `cal-com` | Cal.com | Cal.com | calendar | self_hostable | free_open_source | Free, open-source; the hosted tier has a free plan | Self-hosted: your hardware; hosted: plan quotas | events.read (read_only), events.write (write) |
| `canvas-lms` | Canvas LMS | Instructure (Canvas) | education | self_hostable | free_open_source | Free, open-source; Instructure cloud is paid | Self-hosted: your hardware | courses.read (read_only) |
| `esphome` | ESPHome | ESPHome (open-source) | home | self_hostable | free_open_source | Free, open firmware for DIY devices | Bound by your own hardware | devices.read (read_only) |
| `gitlab` | GitLab | GitLab | code | self_hostable | free_open_source | Free, open-source; self-host or use the free tier | Free tier rate limits per user | projects.read (read_only), projects.write (write) |
| `grafana` | Grafana | Grafana Labs | monitoring | self_hostable | free_open_source | Free open-source tier; cloud tiers are paid | Self-hosted: your hardware; cloud: plan quotas | dashboards.read (read_only), dashboards.write (write), alerting.delete (delete) |
| `home-assistant` | Home Assistant | Home Assistant | home | self_hostable | free_open_source | Free, open-source home automation | Bound by your own hub | state.read (read_only), service.call (write) |
| `jellyfin` | Jellyfin | Jellyfin | media | self_hostable | free_open_source | Free, open-source media server | Bound by your own server | library.read (read_only) |
| `jenkins` | Jenkins | Jenkins CI | developer | self_hostable | free_open_source | Free, open-source CI server | Bound by your own hardware | builds.read (read_only) |
| `joplin` | Joplin | Joplin | notes | self_hostable | free_open_source | Free, open-source notes; sync target may cost | Sync storage quota | notes.read (read_only), notes.write (write) |
| `mastodon` | Mastodon | Mastodon | social | self_hostable | free_open_source | Free, open-source; most instances are free | Instance rate limits apply | timeline.read (read_only), post.write (write) |
| `matomo` | Matomo | Matomo | analytics | self_hostable | free_open_source | Free, open-source; cloud tiers are paid | Self-hosted: your hardware | stats.read (read_only) |
| `matrix` | Matrix | Matrix.org Foundation | messaging | self_hostable | free_open_source | Free, open-source; self-host or use free homeservers | Homeserver rate limits apply | rooms.read (read_only), message.send (send) |
| `metabase` | Metabase | Metabase | analytics | self_hostable | free_open_source | Free, open-source BI; paid cloud tiers | Self-hosted: your hardware | queries.read (read_only) |
| `miniflux` | Miniflux | Miniflux | feeds | self_hostable | free_open_source | Free, open-source feed reader | Bound by your own server | entries.read (read_only) |
| `moodle` | Moodle | Moodle | education | self_hostable | free_open_source | Free, open-source LMS | Bound by your own server | courses.read (read_only) |
| `nextcloud` | Nextcloud | Nextcloud | files | self_hostable | free_open_source | Free, open-source; self-hosted or free-tier providers | Storage quota of the chosen server | files.read (read_only), files.write (write) |
| `ollama` | Ollama (local models) | Ollama | ai_local | local | free_open_source | Free, open-source; runs on your own machine | Bound by local hardware and model sizes | model.infer (read_only) |
| `plausible` | Plausible | Plausible | analytics | self_hostable | free_open_source | Free, open-source; the hosted tier is paid | Self-hosted: your hardware | stats.read (read_only) |
| `posthog` | PostHog | PostHog | analytics | self_hostable | free_open_source | Free, open-source; the cloud tier is free up to a monthly event allowance | Cloud event quota; self-hosted: your hardware | events.read (read_only) |
| `qdrant` | Qdrant | Qdrant | ai_cloud | self_hostable | free_open_source | Free, open-source vector database; cloud tier is paid | Self-hosted: your hardware; cloud: plan quotas | vectors.read (read_only), vectors.write (write) |
| `rss` | RSS feeds | open standard | feeds | local | free_open_source | Free; RSS feeds are open by design | Bound by each feed publisher | feed.read (read_only) |
| `rocket-chat` | Rocket.Chat | Rocket.Chat | messaging | self_hostable | free_open_source | Free, open-source; hosted tiers are paid | Self-hosted: your hardware; cloud: plan quotas | channels.read (read_only), message.send (send) |
| `signal` | Signal | Signal Foundation | messaging | self_hostable | free_open_source | Free, open-source messenger | Bound by the bot or bridge setup used | chats.read (read_only), message.send (send) |
| `uptime-kuma` | Uptime Kuma | Uptime Kuma | monitoring | self_hostable | free_open_source | Free, open-source uptime monitor | Bound by your own hardware | status.read (read_only) |
| `weaviate` | Weaviate | Weaviate | ai_cloud | self_hostable | free_open_source | Free, open-source vector database; cloud tier is paid | Self-hosted: your hardware; cloud: plan quotas | vectors.read (read_only) |
| `woocommerce` | WooCommerce | Automattic (WooCommerce) | business | self_hostable | free_open_source | Free, open-source commerce plugin | Bound by your own WordPress site | orders.read (read_only) |
| `healthchecks-io` | healthchecks.io | healthchecks.io | monitoring | self_hostable | free_open_source | Free open-source; the hosted tier is free for 20 checks | Hosted free tier: 20 checks | checks.read (read_only), pings.send (send) |
| `crossref` | Crossref | Crossref | reference | cloud | free_open_source | Free scholarly metadata service | Polite pool with a mailto contact | works.read (read_only) |
| `internet-archive` | Internet Archive | Internet Archive | reference | cloud | free_open_source | Free, non-profit archive | Upload throttling applies | metadata.read (read_only), items.upload (write) |
| `musicbrainz` | MusicBrainz | MusicBrainz Foundation | media | cloud | free_open_source | Free, open music encyclopedia | Rate limit: one request per second | recordings.read (read_only) |
| `openlibrary` | Open Library | Open Library (Internet Archive) | reference | cloud | free_open_source | Free; Open Library is an open project | Polite-use rate limits | books.read (read_only) |
| `openalex` | OpenAlex | OurResearch (OpenAlex) | reference | cloud | free_open_source | Free, open catalogue of scholarly papers | Polite-use rate limits; a mailto contact is requested | works.read (read_only) |
| `openstreetmap` | OpenStreetMap | OpenStreetMap Foundation | maps | cloud | free_open_source | Free, open map data | Nominatim and Overpass polite-use limits | places.read (read_only) |
| `wikimedia` | Wikimedia | Wikimedia Foundation | reference | cloud | free_open_source | Free; Wikimedia APIs are open | Polite-use rate limits; a user agent is required | search.read (read_only) |
| `arxiv` | arXiv | arXiv | reference | cloud | free_open_source | Free open preprint library | Rate-limited bulk access | papers.read (read_only) |
| `lm-studio` | LM Studio | LM Studio | ai_local | local | free_tier | Free desktop app; runs local models | Bound by local hardware and model sizes | model.infer (read_only) |
| `airtable` | Airtable | Airtable | productivity | cloud | free_tier | Free plan with record limits; paid plans beyond | Free tier API rate limits apply | records.read (read_only), records.write (write) |
| `amadeus` | Amadeus | Amadeus | travel | cloud | free_tier | A free self-service test tier; paid production | Test tier monthly quota | flights.read (read_only) |
| `amplitude` | Amplitude | Amplitude | analytics | cloud | free_tier | Free tier with a monthly event cap | Event cap on the free tier | events.read (read_only) |
| `anilist` | AniList | AniList | media | cloud | free_tier | Free account; the GraphQL API is open with rate limits | Rate limits per minute | media.read (read_only) |
| `asana` | Asana | Asana | productivity | cloud | free_tier | Free for individuals and small teams | Free tier API rate limits apply | tasks.read (read_only), tasks.write (write) |
| `assemblyai` | AssemblyAI | AssemblyAI | ai_cloud | cloud | free_tier | Free tier with audio-hour credit | Free tier limits | transcripts.read (read_only), transcription.send (send) |
| `azure-blob` | Azure Blob Storage | Microsoft | cloud | cloud | free_tier | A free monthly allowance; paid beyond | Free tier limits | objects.read (read_only) |
| `azure-devops` | Azure DevOps | Microsoft | developer | cloud | free_tier | Free tier for up to 5 users | Free tier API rate limits apply | repos.read (read_only), builds.read (read_only) |
| `backblaze-b2` | Backblaze B2 | Backblaze | cloud | cloud | free_tier | 10 GB free storage; paid beyond | Free tier transaction limits | objects.read (read_only) |
| `better-stack` | Better Stack | Better Stack | monitoring | cloud | free_tier | Free monitoring tier; paid beyond | Free tier limits | monitors.read (read_only) |
| `bitbucket` | Bitbucket | Atlassian | developer | cloud | free_tier | Free for up to 5 users | Free tier API rate limits apply | repos.read (read_only), repos.write (write) |
| `bluesky` | Bluesky | Bluesky PBC | social | cloud | free_tier | Free; the AT Protocol is open | Per-account rate limits | timeline.read (read_only), post.write (write) |
| `booking-com` | Booking.com | Booking.com | travel | cloud | free_tier | Free; partner API access is approved per partner | Partner-tier rate limits | hotels.read (read_only) |
| `calendly` | Calendly | Calendly | calendar | cloud | free_tier | Free basic plan; paid plans beyond | Free tier API rate limits apply | events.read (read_only) |
| `circleci` | CircleCI | CircleCI | developer | cloud | free_tier | Free tier with limited monthly credits | Credit and concurrency limits on the free tier | pipelines.read (read_only) |
| `clickup` | ClickUp | ClickUp | productivity | cloud | free_tier | Free forever plan; paid plans beyond | Free tier API rate limits apply | tasks.read (read_only), tasks.write (write) |
| `cloudflare` | Cloudflare | Cloudflare | cloud | cloud | free_tier | Free plan; R2 storage has a free allowance | Free plan API rate limits | zones.read (read_only) |
| `coda` | Coda | Coda | productivity | cloud | free_tier | Free doc maker plan; paid plans beyond | Free tier API rate limits apply | docs.read (read_only), docs.write (write) |
| `cohere` | Cohere | Cohere | ai_cloud | cloud | free_tier | Free trial keys with rate limits | Trial rate limits | models.read (read_only), completions.send (send) |
| `coinbase` | Coinbase | Coinbase | finance | cloud | free_tier | Free; trading fees apply | Per-key API rate limits | accounts.read (read_only) |
| `confluence` | Confluence | Atlassian | productivity | cloud | free_tier | Free cloud plan up to 10 users | Free tier API rate limits apply | pages.read (read_only), pages.write (write) |
| `deepgram` | Deepgram | Deepgram | ai_cloud | cloud | free_tier | Free credits; paid beyond | Credit limits | usage.read (read_only), transcription.send (send) |
| `deezer` | Deezer | Deezer | media | cloud | free_tier | Free tier; Premium beyond | Free tier API rate limits | library.read (read_only) |
| `digitalocean` | DigitalOcean | DigitalOcean | cloud | cloud | free_tier | Free trial credit; pay-as-you-go beyond | Trial credit limits | droplets.read (read_only) |
| `discord` | Discord | Discord Inc. | messaging | cloud | free_tier | Free; the bot API is free with rate limits | Per-bot rate limits apply | guilds.read (read_only), message.send (send) |
| `docker-hub` | Docker Hub | Docker | developer | cloud | free_tier | Free for public images; pull rate limits | Pull rate limits on the free tier | images.read (read_only) |
| `dropbox` | Dropbox | Dropbox | files | cloud | free_tier | Free basic plan with limited storage; paid plans beyond | Free tier API rate limits apply | files.read (read_only), files.write (write) |
| `elevenlabs` | ElevenLabs | ElevenLabs | ai_cloud | cloud | free_tier | Free tier with a monthly character quota | Character quota on the free tier | voices.read (read_only), speech.send (send) |
| `evernote` | Evernote | Bending Spoons (Evernote) | productivity | cloud | free_tier | Free plan with a monthly upload cap | Free tier API rate limits apply | notes.read (read_only), notes.write (write) |
| `flickr` | Flickr | SmugMug (Flickr) | social | cloud | free_tier | Free tier; Pro beyond | Free tier limits | photos.read (read_only) |
| `fly-io` | Fly.io | Fly.io | developer | cloud | free_tier | Free allowances for small machines; paid beyond | Free allowance limits | machines.read (read_only) |
| `freshdesk` | Freshdesk | Freshworks | business | cloud | free_tier | Free plan for up to 2 agents | Free tier API rate limits | tickets.read (read_only) |
| `github` | GitHub | GitHub (Microsoft) | code | cloud | free_tier | Free for public repos; paid plans for private features | 5,000 REST requests per hour on the free tier | repos.read (read_only), issues.write (write) |
| `gmail` | Gmail | Google | messaging | cloud | free_tier | Free with a Google account; Workspace plans are paid | Per-user sending quotas apply | mail.read (read_only), mail.send (send) |
| `goodreads` | Goodreads | Amazon (Goodreads) | media | cloud | free_tier | Free membership; API access is limited to legacy keys | The public API is restricted; limited access | books.read (read_only) |
| `google-analytics` | Google Analytics | Google | analytics | cloud | free_tier | Free GA4 property | GA4 Data API quotas per property | reports.read (read_only) |
| `google-calendar` | Google Calendar | Google | calendar | cloud | free_tier | Free with a Google account | Free tier API rate limits apply | events.read (read_only), events.write (write) |
| `google-chat` | Google Chat | Google | messaging | cloud | free_tier | Free with a Google account; Workspace plans are paid | Free tier API rate limits apply | spaces.read (read_only), message.send (send) |
| `google-classroom` | Google Classroom | Google | education | cloud | free_tier | Free with Google Workspace for Education | Per-project API quotas | courses.read (read_only) |
| `google-cloud-storage` | Google Cloud Storage | Google | cloud | cloud | free_tier | A free monthly allowance; paid beyond | Free tier operation quotas | objects.read (read_only) |
| `google-docs` | Google Docs | Google | productivity | cloud | free_tier | Free with a Google account | Per-project API quotas apply | documents.read (read_only) |
| `google-drive` | Google Drive | Google | files | cloud | free_tier | Free storage with a Google account; paid plans beyond | Per-project API quotas apply | files.read (read_only), files.write (write) |
| `google-gemini` | Google Gemini | Google | ai_cloud | cloud | free_tier | A free tier with request limits; paid beyond | Free tier request-per-minute limits | models.read (read_only), completions.send (send) |
| `google-maps` | Google Maps Platform | Google | maps | cloud | free_tier | A free monthly credit allowance; paid beyond | Per-SKU monthly quota | places.read (read_only) |
| `google-meet` | Google Meet | Google | meetings | cloud | free_tier | Free with a Google account | Free tier API rate limits apply | meetings.read (read_only) |
| `nest` | Google Nest | Google | home | cloud | free_tier | Free with a Google account; device purchase required | Per-device rate limits | devices.read (read_only) |
| `google-photos` | Google Photos | Google | media | cloud | free_tier | Free with a Google account; paid plans beyond | Per-project API quotas | albums.read (read_only) |
| `google-sheets` | Google Sheets | Google | productivity | cloud | free_tier | Free with a Google account | Per-project API quotas apply | spreadsheets.read (read_only), spreadsheets.write (write) |
| `groq` | Groq | Groq | ai_cloud | cloud | free_tier | Free tier with rate limits; paid beyond | Free tier token-per-minute limits | models.read (read_only), completions.send (send) |
| `gumroad` | Gumroad | Gumroad | business | cloud | free_tier | Per-sale fee; no monthly cost | API rate limits | products.read (read_only) |
| `hubspot` | HubSpot | HubSpot | business | cloud | free_tier | Free CRM; paid hubs beyond | Free tier API rate limits apply | contacts.read (read_only), contacts.write (write) |
| `huggingface` | Hugging Face | Hugging Face | ai_cloud | cloud | free_tier | Free tier; paid compute is optional | Free tier API rate limits apply | models.read (read_only), datasets.upload (write) |
| `ifttt` | IFTTT | IFTTT | automation | cloud | free_tier | Free with limited applets; Pro is paid | Free tier applet limits | applets.read (read_only) |
| `instagram` | Instagram | Meta | social | cloud | free_tier | Free; the Graph API covers Business and Creator accounts | Per-app rate limits | posts.read (read_only) |
| `jira` | Jira | Atlassian | developer | cloud | free_tier | Free for up to 10 users | Free tier API rate limits apply | issues.read (read_only), issues.write (write) |
| `kaggle` | Kaggle | Google (Kaggle) | developer | cloud | free_tier | Free with a Kaggle account | Daily API call quota per competition or dataset | datasets.read (read_only), notebooks.write (write) |
| `line` | LINE | LY Corporation (LINE) | messaging | cloud | free_tier | Free; the Messaging API has a free message quota | Free message quota per month | chats.read (read_only), message.send (send) |
| `linear` | Linear | Linear | productivity | cloud | free_tier | Free for small teams | Free tier API rate limits apply | issues.read (read_only), issues.write (write) |
| `linkedin` | LinkedIn | Microsoft (LinkedIn) | social | cloud | free_tier | Free; API access is limited to approved products | Throttled for most apps | posts.read (read_only) |
| `mailchimp` | Mailchimp | Intuit Mailchimp | business | cloud | free_tier | Free tier up to 500 contacts; paid beyond | Free tier contact limits | campaigns.read (read_only) |
| `mailgun` | Mailgun | Sinch Mailgun | email | cloud | free_tier | Free trial tier; paid per volume | Trial tier limits | domains.read (read_only), mail.send (send) |
| `make` | Make | Make | automation | cloud | free_tier | Free plan with operation limits; paid beyond | Free tier operation quota | scenarios.read (read_only) |
| `mapbox` | Mapbox | Mapbox | maps | cloud | free_tier | A free monthly allowance; paid beyond | Free tier request limits | directions.read (read_only) |
| `microsoft-onedrive` | Microsoft OneDrive | Microsoft | files | cloud | free_tier | Free storage with a Microsoft account; Microsoft 365 plans are paid | Free tier API throttling applies | files.read (read_only), files.write (write) |
| `microsoft-outlook` | Microsoft Outlook | Microsoft | messaging | cloud | free_tier | Free with a Microsoft account; Microsoft 365 plans are paid | Free tier API throttling applies | mail.read (read_only), mail.send (send) |
| `microsoft-teams` | Microsoft Teams | Microsoft | meetings | cloud | free_tier | Free with a Microsoft account; Microsoft 365 plans are paid | Free tier API throttling applies | meetings.read (read_only), meetings.write (write) |
| `mistral` | Mistral AI | Mistral AI | ai_cloud | cloud | free_tier | A free experiment tier; paid beyond | Free tier rate limits | models.read (read_only), completions.send (send) |
| `mixpanel` | Mixpanel | Mixpanel | analytics | cloud | free_tier | Free tier with a monthly event cap | Event cap on the free tier | events.read (read_only) |
| `netlify` | Netlify | Netlify | developer | cloud | free_tier | Free tier; paid plans beyond | Free tier build-minute and bandwidth limits | deployments.read (read_only) |
| `new-relic` | New Relic | New Relic | monitoring | cloud | free_tier | Free tier with a monthly data allowance | Ingest allowance on the free tier | metrics.read (read_only) |
| `notion` | Notion | Notion Labs | notes | cloud | free_tier | Free personal plan; paid plans for teams | Free tier API rate limits apply | pages.read (read_only), pages.write (write) |
| `open-meteo` | Open-Meteo | Open-Meteo | weather | cloud | free_tier | Free for non-commercial use | Free tier daily API call quota | weather.read (read_only) |
| `openrouter` | OpenRouter | OpenRouter | ai_cloud | cloud | free_tier | Pay-per-token; free models exist | Per-model provider limits | models.read (read_only), completions.send (send) |
| `pagerduty` | PagerDuty | PagerDuty | monitoring | cloud | free_tier | Free tier for a single responder | Free tier limits | incidents.read (read_only) |
| `pexels` | Pexels | Pexels | media | cloud | free_tier | Free with attribution | Hourly request quota | photos.read (read_only) |
| `pinecone` | Pinecone | Pinecone | ai_cloud | cloud | free_tier | Free starter plan; paid beyond | Starter plan limits | vectors.read (read_only) |
| `pinterest` | Pinterest | Pinterest | social | cloud | free_tier | Free account; API access is free with limits | Per-app rate limits | pins.read (read_only) |
| `postmark` | Postmark | Postmark (ActiveCampaign) | email | cloud | free_tier | Free developer tier around 100 emails a month | Monthly send quota on the free tier | bounces.read (read_only), mail.send (send) |
| `proton-mail` | Proton Mail | Proton AG | email | cloud | free_tier | Free encrypted email; paid plans beyond | Free tier API rate limits apply | mail.read (read_only), mail.send (send) |
| `pypi` | PyPI | Python Software Foundation | developer | cloud | free_tier | Free for open-source packages | Polite-use rate limits | packages.read (read_only) |
| `railway` | Railway | Railway | developer | cloud | free_tier | Trial credit; usage-based pricing beyond | Usage caps on the trial | services.read (read_only) |
| `razorpay` | Razorpay | Razorpay | finance | cloud | free_tier | No setup fee; per-transaction fees | Per-account API rate limits | payments.read (read_only) |
| `reddit` | Reddit | Reddit | social | cloud | free_tier | Free; OAuth rate limits apply | Per-OAuth-client rate limits | posts.read (read_only) |
| `render` | Render | Render | developer | cloud | free_tier | Free web services that idle when unused | Free tier instance limits | services.read (read_only) |
| `replicate` | Replicate | Replicate | ai_cloud | cloud | free_tier | Free trial credit; paid per run | Concurrency limits | models.read (read_only), predictions.send (send) |
| `sendgrid` | SendGrid | Twilio SendGrid | email | cloud | free_tier | Free tier around 100 emails a day; paid beyond | Daily send quota on the free tier | stats.read (read_only), mail.send (send) |
| `sentry` | Sentry | Sentry | monitoring | cloud | free_tier | Free developer tier; paid beyond | Free tier event quota | events.read (read_only) |
| `slack` | Slack | Salesforce (Slack) | messaging | cloud | free_tier | Free tier with message-history limits; paid plans beyond | Free tier API rate limits apply | channels.read (read_only), message.send (send) |
| `smartthings` | SmartThings | Samsung | home | cloud | free_tier | Free with a Samsung account | Per-app rate limits | devices.read (read_only) |
| `soundcloud` | SoundCloud | SoundCloud | media | cloud | free_tier | Free tier | Free tier API rate limits | tracks.read (read_only) |
| `splitwise` | Splitwise | Splitwise | finance | cloud | free_tier | Free; Pro beyond | API rate limits | expenses.read (read_only) |
| `spotify` | Spotify | Spotify | media | cloud | free_tier | Free tier; Premium unlocks full features | Free tier API rate limits apply | library.read (read_only), playback.control (write) |
| `square` | Square | Block (Square) | business | cloud | free_tier | No monthly fee; per-transaction fees | Per-location API rate limits | payments.read (read_only) |
| `stripe` | Stripe | Stripe | finance | cloud | free_tier | No monthly fee; per-transaction fees | Per-account API rate limits | charges.read (read_only) |
| `supabase` | Supabase | Supabase | developer | cloud | free_tier | Free tier with usage limits; paid beyond | Free tier usage caps | tables.read (read_only) |
| `tmdb` | TMDB | The Movie Database (TMDB) | media | cloud | free_tier | Free for non-commercial use | Polite-use rate limits | movies.read (read_only) |
| `telegram` | Telegram | Telegram | messaging | cloud | free_tier | Free; the bot API is free with rate limits | Per-bot rate limits apply | chats.read (read_only), message.send (send) |
| `threads` | Threads | Meta | social | cloud | free_tier | Free; the API covers basic publishing and reads | Per-app rate limits | posts.read (read_only) |
| `ticktick` | TickTick | Appest (TickTick) | productivity | cloud | free_tier | Free plan; Premium beyond | Free tier API rate limits apply | tasks.read (read_only), tasks.write (write) |
| `tiktok` | TikTok | ByteDance (TikTok) | social | cloud | free_tier | Free; API approvals required | Per-app rate limits | videos.read (read_only) |
| `todoist` | Todoist | Doist | productivity | cloud | free_tier | Free plan; Pro is paid | Free tier API rate limits apply | tasks.read (read_only), tasks.write (write) |
| `trakt` | Trakt | Trakt | media | cloud | free_tier | Free tier; VIP beyond | Free tier API limits | history.read (read_only) |
| `trello` | Trello | Atlassian | productivity | cloud | free_tier | Free boards with card limits; paid plans beyond | Free tier API rate limits apply | boards.read (read_only), boards.write (write) |
| `tripadvisor` | Tripadvisor | Tripadvisor | travel | cloud | free_tier | Free content API for approved partners | Per-key monthly quota | locations.read (read_only) |
| `tuya` | Tuya | Tuya | home | cloud | free_tier | Free developer tier; device access per plan | Free tier API quotas | devices.read (read_only) |
| `twitch` | Twitch | Amazon (Twitch) | media | cloud | free_tier | Free; API rate limits apply | Per-token rate limits | streams.read (read_only) |
| `uber` | Uber | Uber | travel | cloud | free_tier | Free; rides are priced per trip | Per-app rate limits | rides.read (read_only) |
| `udemy` | Udemy | Udemy | education | cloud | free_tier | Paid courses; the affiliate API is free | Affiliate API rate limits | courses.read (read_only) |
| `unsplash` | Unsplash | Unsplash | media | cloud | free_tier | Free for the demo tier; production needs attribution | Demo tier hourly limits | photos.read (read_only) |
| `upstox` | Upstox | Upstox | finance | cloud | free_tier | Free API with an Upstox account; brokerage applies | Per-account API rate limits | portfolio.read (read_only) |
| `vercel` | Vercel | Vercel | developer | cloud | free_tier | Free Hobby plan; Pro beyond | Hobby plan limits apply | deployments.read (read_only) |
| `vimeo` | Vimeo | Vimeo | media | cloud | free_tier | Free basic plan; paid beyond | Free tier API rate limits | videos.read (read_only) |
| `whatsapp` | WhatsApp | Meta | messaging | cloud | free_tier | Free personal messaging; the Business API bills per conversation | Business API conversation pricing and rate limits | chats.read (read_only), message.send (send) |
| `x-twitter` | X (Twitter) | X Corp. | social | cloud | free_tier | A free tier with limited write access; paid tiers beyond | Free tier post caps | posts.read (read_only) |
| `youtube` | YouTube | Google (YouTube) | media | cloud | free_tier | Free; API quota applies per project | Per-project daily API quota | videos.read (read_only), videos.write (write) |
| `zapier` | Zapier | Zapier | automation | cloud | free_tier | Free plan around 100 tasks a month; paid beyond | Free tier task and polling limits | zaps.read (read_only), zaps.write (write) |
| `zoho-crm` | Zoho CRM | Zoho | business | cloud | free_tier | Free plan for up to 3 users | Free tier API call quota | accounts.read (read_only) |
| `zoho-mail` | Zoho Mail | Zoho | email | cloud | free_tier | Free plan for up to 5 users; paid beyond | Free tier API rate limits apply | mail.read (read_only), mail.send (send) |
| `zoom` | Zoom | Zoom | meetings | cloud | free_tier | Free basic plan with meeting limits; paid plans beyond | Free tier API rate limits apply | meetings.read (read_only), meetings.write (write) |
| `icloud` | iCloud | Apple | cloud | cloud | free_tier | Free 5 GB with an Apple account; iCloud+ beyond | No public developer API; third-party bridges only | files.read (read_only) |
| `monday-com` | monday.com | monday.com | productivity | cloud | free_tier | Free plan for up to 2 seats | Free tier API rate limits apply | boards.read (read_only), boards.write (write) |
| `npm` | npm | npm (GitHub) | developer | cloud | free_tier | Free for public packages | Registry rate limits | packages.read (read_only) |
| `philips-hue` | Philips Hue | Signify (Philips Hue) | home | local | paid | Bridge and bulbs are a purchase; the local API is free | Local bridge rate limits | lights.read (read_only), lights.write (write) |
| `aws-s3` | AWS S3 | Amazon Web Services | cloud | cloud | paid | Pay-as-you-go; a free-tier allowance for new accounts | Request and storage pricing per region | objects.read (read_only) |
| `anthropic` | Anthropic | Anthropic | ai_cloud | cloud | paid | Paid per token; no free API tier | Model-dependent rate and token limits | models.read (read_only), messages.send (send) |
| `datadog` | Datadog | Datadog | monitoring | cloud | paid | Paid per host; a trial exists | Plan quotas apply | metrics.read (read_only) |
| `fastmail` | Fastmail | Fastmail | email | cloud | paid | Paid plans with a 30-day trial | Per-account API rate limits | mail.read (read_only), mail.send (send) |
| `heroku` | Heroku | Salesforce (Heroku) | developer | cloud | paid | Paid plans; no permanent free tier | Dyno and add-on limits by plan | apps.read (read_only) |
| `hetzner` | Hetzner Cloud | Hetzner | cloud | cloud | paid | Paid per cloud server | Plan quotas apply | servers.read (read_only) |
| `intercom` | Intercom | Intercom | business | cloud | paid | Paid per seat; a trial exists | Plan rate limits | conversations.read (read_only) |
| `openai` | OpenAI | OpenAI | ai_cloud | cloud | paid | Paid per token; the API has no free tier | Model-dependent rate and token limits | models.read (read_only), completions.send (send) |
| `perplexity` | Perplexity | Perplexity | ai_cloud | cloud | paid | Paid per token | Model-dependent rate limits | models.read (read_only), completions.send (send) |
| `pipedrive` | Pipedrive | Pipedrive | business | cloud | paid | Paid plans with a 14-day trial | Per-account API rate limits | deals.read (read_only) |
| `plaid` | Plaid | Plaid | finance | cloud | paid | Paid per connected account; a free development tier | Sandbox and production limits | transactions.read (read_only) |
| `quickbooks` | QuickBooks | Intuit QuickBooks | finance | cloud | paid | Paid plans; a free trial exists | Per-company API limits | invoices.read (read_only) |
| `ring` | Ring | Amazon (Ring) | home | cloud | paid | Device purchase required; some features need a subscription | Per-account rate limits | devices.read (read_only) |
| `salesforce` | Salesforce | Salesforce | business | cloud | paid | Paid subscriptions; a free trial exists | Per-org API request limits | accounts.read (read_only) |
| `shopify` | Shopify | Shopify | business | cloud | paid | Paid subscriptions; a free trial exists | Per-shop API rate limits | products.read (read_only) |
| `stability-ai` | Stability AI | Stability AI | ai_cloud | cloud | paid | Paid per credit | Credit and rate limits | account.read (read_only), images.generate (send) |
| `together-ai` | Together AI | Together AI | ai_cloud | cloud | paid | Paid per token | Model-dependent rate limits | models.read (read_only), completions.send (send) |
| `twilio` | Twilio | Twilio | messaging | cloud | paid | Paid per message or minute; trial credit only | Per-message and per-minute billing | messages.send (send) |
| `wasabi` | Wasabi | Wasabi | cloud | cloud | paid | Paid per terabyte-month; no egress fees | Plan quotas apply | objects.read (read_only) |
| `xero` | Xero | Xero | finance | cloud | paid | Paid subscription; a free trial exists | Per-org rate limits | invoices.read (read_only) |
| `zendesk` | Zendesk | Zendesk | business | cloud | paid | Paid per agent | Per-account API rate limits | tickets.read (read_only) |
| `zerodha-kite` | Zerodha Kite | Zerodha | finance | cloud | paid | Kite Connect is subscription-based; standard brokerage applies | Per-app tick and order rate limits | portfolio.read (read_only), orders.write (write) |
| `xai` | xAI | xAI | ai_cloud | cloud | paid | Paid per token | Model-dependent rate limits | models.read (read_only), completions.send (send) |


Sorted free-first: local and self-hostable free/open-source entries first, free-tier cloud next, paid last. The catalog above carries 182 shipped entries across 26 categories: the 20-entry legacy tier (local-first and self-hostable first), a curated popular-provider tier (27 Nov 2026, Ninad's clarification): 13 mainstream cloud services (Slack, Discord, Notion, Dropbox, Google Drive/Gmail/Calendar, OneDrive/Outlook, Telegram, YouTube, Spotify, Zoom), and an expanded breadth tier (27 Nov 2026, Ninad's request): 149 further curated entries across productivity, automation, email, communication, developer, cloud, AI, CRM/business, finance, analytics, media, social, education, research, travel, maps and smart home. The curated and expanded tiers are listed as METADATA ONLY: each honestly marked integrationImplemented: false, refused at authorizeCall even when connected, and visible in the panel with its real cost and limits. The catalog is extensible only through reviewed registration (MAX_EXTRA additions, each validated and audited), these curated and expanded entries, and user-added custom connectors, never by inventing entries.

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
