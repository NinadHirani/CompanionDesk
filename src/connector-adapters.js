/**
 * Connector adapters (27 Nov 2026, Ninad's go-ahead: real integrations for
 * the highest-value providers, batch 1). Per-provider REQUEST BUILDERS for
 * the catalog connectors whose API shapes are implemented in this build.
 *
 * Pure by design: a build produces { method, url, headers, body } and the
 * executor in main.js performs the HTTPS call. Nothing in this module opens
 * a socket, and nothing ever stores, logs or returns a credential. The
 * caller resolves the credential from the OS vault and passes it in for one
 * call. Actions map to the catalog's DECLARED scopes so authorizeCall stays
 * the single consent gate: read_only actions need only a connection with
 * that scope granted; write/send actions additionally need a single-use
 * approval the user grants per action. Definition-only catalog entries stay
 * refused at authorizeCall and get no adapter here at all.
 *
 * Credential shapes:
 *  - token:     one opaque string (API key, PAT, bot token) used in headers.
 *  - url_token: one opaque string that rides the request URL path or query
 *               (Telegram bot API, Gemini API key). The executor MUST redact
 *               these URLs from logs and errors.
 *  - oauth_json: a JSON blob { client_id, client_secret, access_token,
 *               refresh_token, expires_at } produced by the in-app OAuth
 *               exchange; parsed fail-closed on every use.
 *
 * OAuth setup honesty: this build ships NO shared OAuth client and never
 * creates one for the user. The user creates their own client (Google Cloud
 * Console or Azure portal), pastes its id/secret into the app, completes the
 * consent screen, and only then can a connection use these actions.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CompanionConnectorAdapters = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_PARAM_CHARS = 4000;
  const CONTROL_RE = /[\u0000-\u001f\u007f]/;

  function fail(reason) { return { ok: false, reason: reason }; }

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v) &&
      (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
  }

  function parseTokenCredential(credential) {
    if (typeof credential !== 'string' || credential.length === 0) return fail('credential_missing');
    if (credential.length > 4096) return fail('credential_invalid');
    if (CONTROL_RE.test(credential)) return fail('credential_invalid');
    return { ok: true, token: credential };
  }

  function parseOauthCredential(credential) {
    if (typeof credential !== 'string' || credential.length === 0) return fail('credential_missing');
    let blob = null;
    try { blob = JSON.parse(credential); } catch (e) { return fail('credential_invalid'); }
    if (!isPlainObject(blob)) return fail('credential_invalid');
    if (typeof blob.access_token !== 'string' || blob.access_token.length === 0) return fail('credential_invalid');
    if (typeof blob.client_id !== 'string' || blob.client_id.length === 0) return fail('credential_invalid');
    return { ok: true, blob: blob };
  }

  function validateParams(action, params) {
    const declared = action.params || [];
    const given = params || {};
    if (!isPlainObject(given)) return 'param_invalid';
    for (const key of Object.keys(given)) {
      const d = declared.find(function (p) { return p.name === key; });
      if (!d) return 'param_invalid';
      if (typeof given[key] !== 'string') return 'param_invalid';
      if (given[key].length > (d.maxLength || MAX_PARAM_CHARS)) return 'param_invalid';
      if (CONTROL_RE.test(given[key])) return 'param_invalid';
    }
    for (const d of declared) {
      if (d.required && (given[d.name] === undefined || given[d.name] === '')) return 'param_missing';
    }
    return null;
  }

  function optionalInt(params, name, fallback) {
    const raw = params ? params[name] : undefined;
    if (raw === undefined || raw === '') return fallback;
    const n = parseInt(raw, 10);
    if (!isFinite(n) || n < 1 || n > 100) return null;
    return n;
  }

  function isoOrDaysAhead(params, name, days) {
    const raw = params ? params[name] : undefined;
    if (raw === undefined || raw === '') {
      const d = new Date(Date.now() + days * 86400000);
      return d.toISOString();
    }
    if (!/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(raw)) return null;
    return raw;
  }

  function bearerHeader(token) { return { Authorization: 'Bearer ' + token }; }

  // Batch 8 (27 Nov 2026): strict decimal coordinates for the public
  // weather and geocoding adapters. Plain decimal form only (no
  // exponent), bounded, re-serialized from the parsed number so the URL
  // can never carry anything but a plain number.
  function validCoordinate(raw, bound) {
    if (typeof raw !== 'string' || !/^-?\d{1,3}(\.\d{1,8})?$/.test(raw)) return null;
    const n = parseFloat(raw);
    if (!isFinite(n) || Math.abs(n) > bound) return null;
    return String(n);
  }

  function jsonHeaders(extra) {
    return Object.assign({ 'Content-Type': 'application/json' }, extra || {});
  }

  // ---- per-provider adapter definitions -------------------------------
  const ADAPTERS = {};

  ADAPTERS.github = {
    id: 'github', name: 'GitHub', authShape: 'token', setupRequired: false,
    setupNote: null,
    buildHeaders: function (token) { return { Authorization: 'Bearer ' + token, 'User-Agent': 'CompanionDesk', Accept: 'application/vnd.github+json' }; },
    actions: [
      { id: 'repo_read', label: 'Read a public or accessible repository', scope: 'repos.read', kind: 'read_only',
        params: [{ name: 'owner', required: true, maxLength: 100 }, { name: 'repo', required: true, maxLength: 100 }],
        build: function (p, token) {
          return { method: 'GET', url: 'https://api.github.com/repos/' + encodeURIComponent(p.owner) + '/' + encodeURIComponent(p.repo), headers: this.buildHeaders(token), body: null };
        } },
      { id: 'list_issues', label: 'List open issues on a repository', scope: 'issues.read', kind: 'read_only',
        params: [{ name: 'owner', required: true, maxLength: 100 }, { name: 'repo', required: true, maxLength: 100 }],
        build: function (p, token) {
          return { method: 'GET', url: 'https://api.github.com/repos/' + encodeURIComponent(p.owner) + '/' + encodeURIComponent(p.repo) + '/issues?state=open&per_page=20', headers: this.buildHeaders(token), body: null };
        } },
      { id: 'get_issue', label: 'Read one issue by number', scope: 'issues.read', kind: 'read_only',
        params: [{ name: 'owner', required: true, maxLength: 100 }, { name: 'repo', required: true, maxLength: 100 }, { name: 'number', required: true, maxLength: 12 }],
        build: function (p, token) {
          const n = parseInt(p.number, 10);
          if (!isFinite(n) || n < 1) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://api.github.com/repos/' + encodeURIComponent(p.owner) + '/' + encodeURIComponent(p.repo) + '/issues/' + n, headers: this.buildHeaders(token), body: null };
        } },
      { id: 'list_pull_requests', label: 'List open pull requests on a repository', scope: 'repos.read', kind: 'read_only',
        params: [{ name: 'owner', required: true, maxLength: 100 }, { name: 'repo', required: true, maxLength: 100 }],
        build: function (p, token) {
          return { method: 'GET', url: 'https://api.github.com/repos/' + encodeURIComponent(p.owner) + '/' + encodeURIComponent(p.repo) + '/pulls?state=open&per_page=20', headers: this.buildHeaders(token), body: null };
        } },
      { id: 'list_commits', label: 'List recent commits on a repository', scope: 'repos.read', kind: 'read_only',
        params: [{ name: 'owner', required: true, maxLength: 100 }, { name: 'repo', required: true, maxLength: 100 }],
        build: function (p, token) {
          return { method: 'GET', url: 'https://api.github.com/repos/' + encodeURIComponent(p.owner) + '/' + encodeURIComponent(p.repo) + '/commits?per_page=20', headers: this.buildHeaders(token), body: null };
        } },
      { id: 'create_issue', label: 'Open a new issue on a repository', scope: 'issues.write', kind: 'write',
        params: [{ name: 'owner', required: true, maxLength: 100 }, { name: 'repo', required: true, maxLength: 100 }, { name: 'title', required: true, maxLength: 200 }, { name: 'body', required: false, maxLength: 4000 }],
        build: function (p, token) {
          const body = { title: p.title };
          if (p.body) body.body = p.body;
          return { method: 'POST', url: 'https://api.github.com/repos/' + encodeURIComponent(p.owner) + '/' + encodeURIComponent(p.repo) + '/issues', headers: this.buildHeaders(token), body: JSON.stringify(body) };
        } },
    ],
  };

  ADAPTERS.replicate = {
    id: 'replicate', name: 'Replicate', authShape: 'token', setupRequired: false,
    setupNote: 'paste a Replicate API token from replicate.com/account/api-tokens; it is stored only in the app vault, never requested or shown in chat',
    buildHeaders: function (token) { return { Authorization: 'Bearer ' + token, 'User-Agent': 'CompanionDesk' }; },
    actions: [
      { id: 'list_models', label: 'List the Replicate models in your account', scope: 'models.read', kind: 'read_only',
        params: [],
        build: function (p, token) {
          return { method: 'GET', url: 'https://api.replicate.com/v1/models', headers: this.buildHeaders(token), body: null };
        } },
    ],
  };

  ADAPTERS['together-ai'] = {
    id: 'together-ai', name: 'Together AI', authShape: 'token', setupRequired: false,
    setupNote: 'paste a Together AI API key from api.together.ai; it is stored only in the app vault, never requested or shown in chat',
    buildHeaders: function (token) { return { Authorization: 'Bearer ' + token, 'User-Agent': 'CompanionDesk' }; },
    actions: [
      { id: 'list_models', label: 'List the Together AI models your key can use', scope: 'models.read', kind: 'read_only',
        params: [],
        build: function (p, token) {
          return { method: 'GET', url: 'https://api.together.xyz/v1/models', headers: this.buildHeaders(token), body: null };
        } },
    ],
  };

  ADAPTERS.mistral = {
    id: 'mistral', name: 'Mistral AI', authShape: 'token', setupRequired: false,
    setupNote: 'paste a Mistral API key from console.mistral.ai; it is stored only in the app vault, never requested or shown in chat',
    buildHeaders: function (token) { return { Authorization: 'Bearer ' + token, 'User-Agent': 'CompanionDesk' }; },
    actions: [
      { id: 'list_models', label: 'List the Mistral models your key can use', scope: 'models.read', kind: 'read_only',
        params: [],
        build: function (p, token) {
          return { method: 'GET', url: 'https://api.mistral.ai/v1/models', headers: this.buildHeaders(token), body: null };
        } },
    ],
  };

  ADAPTERS.openrouter = {
    id: 'openrouter', name: 'OpenRouter', authShape: 'token', setupRequired: false,
    setupNote: 'paste an OpenRouter API key from openrouter.ai/keys; it is stored only in the app vault, never requested or shown in chat',
    buildHeaders: function (token) { return { Authorization: 'Bearer ' + token, 'User-Agent': 'CompanionDesk' }; },
    actions: [
      { id: 'list_models', label: 'List the models OpenRouter offers', scope: 'models.read', kind: 'read_only',
        params: [],
        build: function (p, token) {
          return { method: 'GET', url: 'https://openrouter.ai/api/v1/models', headers: this.buildHeaders(token), body: null };
        } },
    ],
  };

  ADAPTERS.cohere = {
    id: 'cohere', name: 'Cohere', authShape: 'token', setupRequired: false,
    setupNote: 'paste a Cohere API key from dashboard.cohere.com/api-keys; it is stored only in the app vault, never requested or shown in chat',
    buildHeaders: function (token) { return { Authorization: 'Bearer ' + token, 'User-Agent': 'CompanionDesk' }; },
    actions: [
      { id: 'list_models', label: 'List the Cohere models your key can use', scope: 'models.read', kind: 'read_only',
        params: [],
        build: function (p, token) {
          return { method: 'GET', url: 'https://api.cohere.com/v1/models', headers: this.buildHeaders(token), body: null };
        } },
    ],
  };

  ADAPTERS.xai = {
    id: 'xai', name: 'xAI', authShape: 'token', setupRequired: false,
    setupNote: 'paste an xAI API key from console.x.ai; it is stored only in the app vault, never requested or shown in chat',
    buildHeaders: function (token) { return { Authorization: 'Bearer ' + token, 'User-Agent': 'CompanionDesk' }; },
    actions: [
      { id: 'list_models', label: 'List the xAI models your key can use', scope: 'models.read', kind: 'read_only',
        params: [],
        build: function (p, token) {
          return { method: 'GET', url: 'https://api.x.ai/v1/models', headers: this.buildHeaders(token), body: null };
        } },
    ],
  };

  ADAPTERS.stripe = {
    id: 'stripe', name: 'Stripe', authShape: 'token', setupRequired: false,
    setupNote: 'paste a Stripe RESTRICTED API key with charges read access from dashboard.stripe.com/apikeys; it is stored only in the app vault, never requested or shown in chat',
    buildHeaders: function (token) { return { Authorization: 'Bearer ' + token, 'User-Agent': 'CompanionDesk' }; },
    actions: [
      { id: 'list_charges', label: 'List recent Stripe charges (capped)', scope: 'charges.read', kind: 'read_only',
        params: [{ name: 'limit', required: false, maxLength: 3 }],
        build: function (p, token) {
          const limit = optionalInt(p, 'limit', 25);
          if (limit === null || limit < 1 || limit > 100) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://api.stripe.com/v1/charges?limit=' + limit, headers: this.buildHeaders(token), body: null };
        } },
      { id: 'get_charge', label: 'Read one Stripe charge by id', scope: 'charges.read', kind: 'read_only',
        params: [{ name: 'charge_id', required: true, maxLength: 64 }],
        build: function (p, token) {
          if (!/^[A-Za-z0-9_]+$/.test(p.charge_id)) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://api.stripe.com/v1/charges/' + encodeURIComponent(p.charge_id), headers: this.buildHeaders(token), body: null };
        } },
    ],
  };

  ADAPTERS.groq = {
    id: 'groq', name: 'Groq', authShape: 'token', setupRequired: false,
    setupNote: 'paste a Groq API key from console.groq.com/keys; it is stored only in the app vault, never requested or shown in chat',
    buildHeaders: function (token) { return { Authorization: 'Bearer ' + token, 'User-Agent': 'CompanionDesk' }; },
    actions: [
      { id: 'list_models', label: 'List the Groq models your key can use', scope: 'models.read', kind: 'read_only',
        params: [],
        build: function (p, token) {
          return { method: 'GET', url: 'https://api.groq.com/openai/v1/models', headers: this.buildHeaders(token), body: null };
        } },
    ],
  };

  ADAPTERS.pexels = {
    id: 'pexels', name: 'Pexels', authShape: 'token', setupRequired: false,
    setupNote: 'paste your Pexels API key from pexels.com/api; it is stored only in the app vault, never requested or shown in chat',
    buildHeaders: function (token) { return { Authorization: token, 'User-Agent': 'CompanionDesk' }; },
    actions: [
      { id: 'search_photos', label: 'Search Pexels for photos (capped)', scope: 'photos.read', kind: 'read_only',
        params: [{ name: 'query', required: true, maxLength: 100 }, { name: 'per_page', required: false, maxLength: 2 }],
        build: function (p, token) {
          if (!p.query) return { error: 'param_missing' };
          if (p.query.length > 100) return { error: 'param_invalid' };
          const perPage = optionalInt(p, 'per_page', 15);
          if (perPage === null || perPage < 1 || perPage > 80) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://api.pexels.com/v1/search?query=' + encodeURIComponent(p.query) + '&per_page=' + perPage, headers: this.buildHeaders(token), body: null };
        } },
      { id: 'get_photo', label: 'Read one Pexels photo by id', scope: 'photos.read', kind: 'read_only',
        params: [{ name: 'photo_id', required: true, maxLength: 12 }],
        build: function (p, token) {
          if (!/^\d{1,12}$/.test(p.photo_id)) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://api.pexels.com/v1/photos/' + encodeURIComponent(p.photo_id), headers: this.buildHeaders(token), body: null };
        } },
    ],
  };

  ADAPTERS.kaggle = {
    id: 'kaggle', name: 'Kaggle', authShape: 'token', setupRequired: false,
    setupNote: 'paste your Kaggle credentials as username:key (create a token at kaggle.com/settings); they are stored only in the app vault, never requested or shown in chat',
    buildHeaders: function (token) {
      const sep = token.indexOf(':');
      const user = sep > 0 ? token.slice(0, sep) : '';
      const key = sep > 0 ? token.slice(sep + 1) : token;
      const basic = Buffer.from(user + ':' + key).toString('base64');
      return { Authorization: 'Basic ' + basic, 'User-Agent': 'CompanionDesk' };
    },
    actions: [
      { id: 'list_datasets', label: 'Search Kaggle datasets (capped)', scope: 'datasets.read', kind: 'read_only',
        params: [{ name: 'search', required: false, maxLength: 80 }, { name: 'page', required: false, maxLength: 3 }],
        build: function (p, token) {
          if (p.search !== undefined && p.search !== '' && p.search.length > 80) return { error: 'param_invalid' };
          const page = optionalInt(p, 'page', 1);
          if (page === null || page < 1 || page > 20) return { error: 'param_invalid' };
          const q = p.search ? '?search=' + encodeURIComponent(p.search) + '&page=' + page : '?page=' + page;
          return { method: 'GET', url: 'https://www.kaggle.com/api/v1/datasets/list' + q, headers: this.buildHeaders(token), body: null };
        } },
    ],
  };

  ADAPTERS['new-relic'] = {
    id: 'new-relic', name: 'New Relic', authShape: 'token', setupRequired: false,
    setupNote: 'create a User API key at one.newrelic.com/menu/My-Account/api-keys and paste it; your key is stored only in the app vault, never requested or shown in chat',
    buildHeaders: function (token) { return { 'X-Api-Key': token, 'User-Agent': 'CompanionDesk' }; },
    actions: [
      { id: 'list_applications', label: 'List your New Relic applications (capped)', scope: 'metrics.read', kind: 'read_only',
        params: [{ name: 'per_page', required: false, maxLength: 3 }],
        build: function (p, token) {
          const perPage = optionalInt(p, 'per_page', 25);
          if (perPage === null || perPage < 1 || perPage > 100) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://api.newrelic.com/v2/applications.json?per_page=' + perPage + '&page=1', headers: this.buildHeaders(token), body: null };
        } },
      { id: 'get_application', label: 'Read one New Relic application by id', scope: 'metrics.read', kind: 'read_only',
        params: [{ name: 'application_id', required: true, maxLength: 20 }],
        build: function (p, token) {
          if (!/^\d{1,20}$/.test(p.application_id)) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://api.newrelic.com/v2/applications/' + encodeURIComponent(p.application_id) + '.json', headers: this.buildHeaders(token), body: null };
        } },
    ],
  };

  ADAPTERS.pinecone = {
    id: 'pinecone', name: 'Pinecone', authShape: 'token', setupRequired: false,
    setupNote: 'paste a Pinecone API key from app.pinecone.io; it is stored only in the app vault, never requested or shown in chat',
    buildHeaders: function (token) { return { 'Api-Key': token, 'X-Pinecone-API-Version': '2025-01', 'User-Agent': 'CompanionDesk' }; },
    actions: [
      { id: 'list_indexes', label: 'List your Pinecone indexes', scope: 'vectors.read', kind: 'read_only',
        params: [],
        build: function (p, token) {
          return { method: 'GET', url: 'https://api.pinecone.io/indexes', headers: this.buildHeaders(token), body: null };
        } },
      { id: 'get_index', label: 'Read one Pinecone index by name', scope: 'vectors.read', kind: 'read_only',
        params: [{ name: 'index_name', required: true, maxLength: 45 }],
        build: function (p, token) {
          if (!/^[a-z0-9-]+$/.test(p.index_name)) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://api.pinecone.io/indexes/' + encodeURIComponent(p.index_name), headers: this.buildHeaders(token), body: null };
        } },
    ],
  };

  ADAPTERS.tmdb = {
    id: 'tmdb', name: 'TMDB', authShape: 'token', setupRequired: false,
    setupNote: 'paste the v3 API read access token from themoviedb.org/settings/api; it is stored only in the app vault, never requested or shown in chat',
    buildHeaders: function (token) { return { Authorization: 'Bearer ' + token, 'User-Agent': 'CompanionDesk' }; },
    actions: [
      { id: 'search_movies', label: 'Search TMDB for movies (capped)', scope: 'movies.read', kind: 'read_only',
        params: [{ name: 'query', required: true, maxLength: 100 }, { name: 'page', required: false, maxLength: 3 }],
        build: function (p, token) {
          if (!p.query) return { error: 'param_missing' };
          if (p.query.length > 100) return { error: 'param_invalid' };
          const page = optionalInt(p, 'page', 1);
          if (page === null || page < 1 || page > 100) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://api.themoviedb.org/3/search/movie?query=' + encodeURIComponent(p.query) + '&page=' + page, headers: this.buildHeaders(token), body: null };
        } },
      { id: 'get_movie', label: 'Read one TMDB movie by id', scope: 'movies.read', kind: 'read_only',
        params: [{ name: 'movie_id', required: true, maxLength: 12 }],
        build: function (p, token) {
          if (!/^\d{1,12}$/.test(p.movie_id)) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://api.themoviedb.org/3/movie/' + encodeURIComponent(p.movie_id), headers: this.buildHeaders(token), body: null };
        } },
    ],
  };

  ADAPTERS.unsplash = {
    id: 'unsplash', name: 'Unsplash', authShape: 'token', setupRequired: false,
    setupNote: 'create an access key at unsplash.com/api-dashboard and paste it; your key is stored only in the app vault, never requested or shown in chat',
    buildHeaders: function (token) { return { Authorization: 'Client-ID ' + token, 'User-Agent': 'CompanionDesk' }; },
    actions: [
      { id: 'search_photos', label: 'Search Unsplash for photos (capped)', scope: 'photos.read', kind: 'read_only',
        params: [{ name: 'query', required: true, maxLength: 100 }, { name: 'per_page', required: false, maxLength: 2 }],
        build: function (p, token) {
          if (!p.query) return { error: 'param_missing' };
          if (p.query.length > 100) return { error: 'param_invalid' };
          const perPage = optionalInt(p, 'per_page', 10);
          if (perPage === null || perPage < 1 || perPage > 30) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://api.unsplash.com/search/photos?query=' + encodeURIComponent(p.query) + '&per_page=' + perPage, headers: this.buildHeaders(token), body: null };
        } },
      { id: 'get_photo', label: 'Read one Unsplash photo by id', scope: 'photos.read', kind: 'read_only',
        params: [{ name: 'photo_id', required: true, maxLength: 80 }],
        build: function (p, token) {
          if (!/^[A-Za-z0-9_-]+$/.test(p.photo_id)) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://api.unsplash.com/photos/' + encodeURIComponent(p.photo_id), headers: this.buildHeaders(token), body: null };
        } },
    ],
  };

  ADAPTERS.cloudflare = {
    id: 'cloudflare', name: 'Cloudflare', authShape: 'token', setupRequired: false,
    setupNote: 'create an API token at dash.cloudflare.com/profile/api-tokens and paste it; your token is stored only in the app vault, never requested or shown in chat',
    buildHeaders: function (token) { return { Authorization: 'Bearer ' + token, 'User-Agent': 'CompanionDesk' }; },
    actions: [
      { id: 'verify_token', label: 'Check the Cloudflare token works', scope: 'zones.read', kind: 'read_only',
        params: [],
        build: function (p, token) {
          return { method: 'GET', url: 'https://api.cloudflare.com/client/v4/user/tokens/verify', headers: this.buildHeaders(token), body: null };
        } },
      { id: 'list_zones', label: 'List your Cloudflare zones (capped)', scope: 'zones.read', kind: 'read_only',
        params: [{ name: 'per_page', required: false, maxLength: 2 }],
        build: function (p, token) {
          const perPage = optionalInt(p, 'per_page', 20);
          if (perPage === null || perPage < 1 || perPage > 50) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://api.cloudflare.com/client/v4/zones?per_page=' + perPage, headers: this.buildHeaders(token), body: null };
        } },
    ],
  };

  ADAPTERS.digitalocean = {
    id: 'digitalocean', name: 'DigitalOcean', authShape: 'token', setupRequired: false,
    setupNote: 'create a personal access token at cloud.digitalocean.com/account/api and paste it; your token is stored only in the app vault, never requested or shown in chat',
    buildHeaders: function (token) { return { Authorization: 'Bearer ' + token, 'User-Agent': 'CompanionDesk' }; },
    actions: [
      { id: 'list_droplets', label: 'List your DigitalOcean droplets (capped)', scope: 'droplets.read', kind: 'read_only',
        params: [{ name: 'per_page', required: false, maxLength: 3 }],
        build: function (p, token) {
          const perPage = optionalInt(p, 'per_page', 25);
          if (perPage === null || perPage < 1 || perPage > 100) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://api.digitalocean.com/v2/droplets?per_page=' + perPage + '&page=1', headers: this.buildHeaders(token), body: null };
        } },
      { id: 'get_droplet', label: 'Read one DigitalOcean droplet by id', scope: 'droplets.read', kind: 'read_only',
        params: [{ name: 'droplet_id', required: true, maxLength: 20 }],
        build: function (p, token) {
          if (!/^\d{1,20}$/.test(p.droplet_id)) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://api.digitalocean.com/v2/droplets/' + encodeURIComponent(p.droplet_id), headers: this.buildHeaders(token), body: null };
        } },
    ],
  };

  ADAPTERS.sentry = {
    id: 'sentry', name: 'Sentry', authShape: 'token', setupRequired: false,
    setupNote: 'create an auth token at sentry.io/settings/account/api/auth-tokens and paste it; your token is stored only in the app vault, never requested or shown in chat',
    buildHeaders: function (token) { return { Authorization: 'Bearer ' + token, 'User-Agent': 'CompanionDesk' }; },
    actions: [
      { id: 'list_org_issues', label: 'Read recent issues for a Sentry organization (capped)', scope: 'events.read', kind: 'read_only',
        params: [{ name: 'org_slug', required: true, maxLength: 100 }, { name: 'count', required: false, maxLength: 3 }],
        build: function (p, token) {
          if (!/^[a-z0-9-]+$/.test(p.org_slug)) return { error: 'param_invalid' };
          const count = optionalInt(p, 'count', 25);
          if (count === null || count < 1 || count > 100) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://sentry.io/api/0/organizations/' + encodeURIComponent(p.org_slug) + '/issues/?count=' + count, headers: this.buildHeaders(token), body: null };
        } },
      { id: 'get_issue', label: 'Read one Sentry issue by id', scope: 'events.read', kind: 'read_only',
        params: [{ name: 'org_slug', required: true, maxLength: 100 }, { name: 'issue_id', required: true, maxLength: 64 }],
        build: function (p, token) {
          if (!/^[a-z0-9-]+$/.test(p.org_slug)) return { error: 'param_invalid' };
          if (!/^[A-Za-z0-9]+$/.test(p.issue_id)) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://sentry.io/api/0/organizations/' + encodeURIComponent(p.org_slug) + '/issues/' + encodeURIComponent(p.issue_id) + '/', headers: this.buildHeaders(token), body: null };
        } },
    ],
  };

  ADAPTERS.pagerduty = {
    id: 'pagerduty', name: 'PagerDuty', authShape: 'token', setupRequired: false,
    setupNote: 'create a general-access REST API key at app.pagerduty.com/settings/api_keys and paste it; your key is stored only in the app vault, never requested or shown in chat',
    buildHeaders: function (token) { return { Authorization: 'Token token=' + token, Accept: 'application/vnd.pagerduty+json;version=2', 'User-Agent': 'CompanionDesk' }; },
    actions: [
      { id: 'list_incidents', label: 'Read recent PagerDuty incidents (capped)', scope: 'incidents.read', kind: 'read_only',
        params: [{ name: 'limit', required: false, maxLength: 2 }],
        build: function (p, token) {
          const limit = optionalInt(p, 'limit', 25);
          if (limit === null || limit < 1 || limit > 25) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://api.pagerduty.com/incidents?limit=' + limit + '&offset=0', headers: this.buildHeaders(token), body: null };
        } },
      { id: 'get_incident', label: 'Read one PagerDuty incident by id', scope: 'incidents.read', kind: 'read_only',
        params: [{ name: 'incident_id', required: true, maxLength: 80 }],
        build: function (p, token) {
          if (!/^[A-Za-z0-9]+$/.test(p.incident_id)) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://api.pagerduty.com/incidents/' + encodeURIComponent(p.incident_id), headers: this.buildHeaders(token), body: null };
        } },
    ],
  };

  ADAPTERS.heroku = {
    id: 'heroku', name: 'Heroku', authShape: 'token', setupRequired: false,
    setupNote: 'create an API token at dashboard.heroku.com/account/applications and paste it; your token is stored only in the app vault, never requested or shown in chat',
    buildHeaders: function (token) { return { Authorization: 'Bearer ' + token, Accept: 'application/vnd.heroku+json; version=3', 'User-Agent': 'CompanionDesk' }; },
    actions: [
      { id: 'list_apps', label: 'List your Heroku apps (capped)', scope: 'apps.read', kind: 'read_only',
        params: [{ name: 'limit', required: false, maxLength: 3 }],
        build: function (p, token) {
          const limit = optionalInt(p, 'limit', 50);
          if (limit === null || limit < 1 || limit > 100) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://api.heroku.com/apps?limit=' + limit, headers: this.buildHeaders(token), body: null };
        } },
      { id: 'get_app', label: 'Read one Heroku app by name or id', scope: 'apps.read', kind: 'read_only',
        params: [{ name: 'app_id', required: true, maxLength: 80 }],
        build: function (p, token) {
          if (!/^[A-Za-z0-9-]+$/.test(p.app_id)) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://api.heroku.com/apps/' + encodeURIComponent(p.app_id), headers: this.buildHeaders(token), body: null };
        } },
      { id: 'get_app_dynos', label: 'Read the dyno list of one Heroku app', scope: 'apps.read', kind: 'read_only',
        params: [{ name: 'app_id', required: true, maxLength: 80 }],
        build: function (p, token) {
          if (!/^[A-Za-z0-9-]+$/.test(p.app_id)) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://api.heroku.com/apps/' + encodeURIComponent(p.app_id) + '/dynos', headers: this.buildHeaders(token), body: null };
        } },
    ],
  };

  ADAPTERS.render = {
    id: 'render', name: 'Render', authShape: 'token', setupRequired: false,
    setupNote: 'create a read-scope API key at dashboard.render.com/u/me/settings#api-keys and paste it; your key is stored only in the app vault, never requested or shown in chat',
    buildHeaders: function (token) { return { Authorization: 'Bearer ' + token, 'User-Agent': 'CompanionDesk' }; },
    actions: [
      { id: 'list_services', label: 'List your Render services (capped)', scope: 'services.read', kind: 'read_only',
        params: [{ name: 'limit', required: false, maxLength: 3 }],
        build: function (p, token) {
          const limit = optionalInt(p, 'limit', 20);
          if (limit === null || limit < 1 || limit > 100) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://api.render.com/v1/services?limit=' + limit, headers: this.buildHeaders(token), body: null };
        } },
      { id: 'get_service', label: 'Read one Render service by id', scope: 'services.read', kind: 'read_only',
        params: [{ name: 'service_id', required: true, maxLength: 80 }],
        build: function (p, token) {
          if (!/^[A-Za-z0-9-]+$/.test(p.service_id)) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://api.render.com/v1/services/' + encodeURIComponent(p.service_id), headers: this.buildHeaders(token), body: null };
        } },
    ],
  };

  ADAPTERS.supabase = {
    id: 'supabase', name: 'Supabase', authShape: 'token', setupRequired: false,
    setupNote: 'create a management API token at supabase.com/dashboard/account/tokens and paste it; your token is stored only in the app vault, never requested or shown in chat',
    buildHeaders: function (token) { return { Authorization: 'Bearer ' + token, 'User-Agent': 'CompanionDesk' }; },
    actions: [
      { id: 'list_projects', label: 'List your Supabase projects (capped)', scope: 'tables.read', kind: 'read_only',
        params: [{ name: 'limit', required: false, maxLength: 3 }],
        build: function (p, token) {
          const limit = optionalInt(p, 'limit', 25);
          if (limit === null || limit < 1 || limit > 100) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://api.supabase.com/v1/projects?offset=0&limit=' + limit, headers: this.buildHeaders(token), body: null };
        } },
      { id: 'get_project', label: 'Read one Supabase project by ref', scope: 'tables.read', kind: 'read_only',
        params: [{ name: 'project_ref', required: true, maxLength: 60 }],
        build: function (p, token) {
          if (!/^[a-z0-9-]+$/.test(p.project_ref)) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://api.supabase.com/v1/projects/' + encodeURIComponent(p.project_ref), headers: this.buildHeaders(token), body: null };
        } },
    ],
  };

  ADAPTERS.sendgrid = {
    id: 'sendgrid', name: 'SendGrid', authShape: 'token', setupRequired: false,
    setupNote: 'create a read-scope API key at app.sendgrid.com/settings/api_keys and paste it; your key is stored only in the app vault, never requested or shown in chat',
    buildHeaders: function (token) { return { Authorization: 'Bearer ' + token, 'User-Agent': 'CompanionDesk' }; },
    actions: [
      { id: 'get_scopes', label: 'Check the SendGrid token works', scope: 'stats.read', kind: 'read_only',
        params: [],
        build: function (p, token) {
          return { method: 'GET', url: 'https://api.sendgrid.com/v3/scopes', headers: this.buildHeaders(token), body: null };
        } },
      { id: 'get_stats', label: 'Read SendGrid email statistics for a date range', scope: 'stats.read', kind: 'read_only',
        params: [{ name: 'start_date', required: true, maxLength: 10 }, { name: 'end_date', required: false, maxLength: 10 }, { name: 'aggregated_by', required: false, maxLength: 5 }],
        build: function (p, token) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(p.start_date)) return { error: 'param_invalid' };
          let url = 'https://api.sendgrid.com/v3/stats?start_date=' + encodeURIComponent(p.start_date) + '&aggregated_by=day';
          if (p.end_date !== undefined && p.end_date !== '') {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(p.end_date)) return { error: 'param_invalid' };
            url += '&end_date=' + encodeURIComponent(p.end_date);
          }
          if (p.aggregated_by !== undefined && p.aggregated_by !== '') {
            if (['day', 'week', 'month'].indexOf(p.aggregated_by) === -1) return { error: 'param_invalid' };
            url = url.replace('aggregated_by=day', 'aggregated_by=' + p.aggregated_by);
          }
          return { method: 'GET', url: url, headers: this.buildHeaders(token), body: null };
        } },
    ],
  };

  ADAPTERS.mailgun = {
    id: 'mailgun', name: 'Mailgun', authShape: 'token', setupRequired: false,
    setupNote: 'create a Mailgun API key at app.mailgun.com/settings/api_keys and paste it; your key is stored only in the app vault, never requested or shown in chat',
    buildHeaders: function (token) { return { Authorization: 'Basic ' + Buffer.from('api:' + token).toString('base64'), 'User-Agent': 'CompanionDesk' }; },
    actions: [
      { id: 'list_domains', label: 'List your Mailgun sending domains (capped)', scope: 'domains.read', kind: 'read_only',
        params: [{ name: 'limit', required: false, maxLength: 3 }],
        build: function (p, token) {
          const limit = optionalInt(p, 'limit', 50);
          if (limit === null || limit < 1 || limit > 100) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://api.mailgun.net/v3/domains?limit=' + limit, headers: this.buildHeaders(token), body: null };
        } },
      { id: 'get_domain', label: 'Read one Mailgun domain by name', scope: 'domains.read', kind: 'read_only',
        params: [{ name: 'domain', required: true, maxLength: 253 }],
        build: function (p, token) {
          if (!/^[A-Za-z0-9.-]+$/.test(p.domain)) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://api.mailgun.net/v3/domains/' + encodeURIComponent(p.domain), headers: this.buildHeaders(token), body: null };
        } },
    ],
  };

  ADAPTERS.postmark = {
    id: 'postmark', name: 'Postmark', authShape: 'token', setupRequired: false,
    setupNote: 'paste the server token of the Postmark server you want to read, from app.postmarkapp.com/server/settings; it is stored only in the app vault, never requested or shown in chat',
    buildHeaders: function (token) { return { 'X-Postmark-Server-Token': token, Accept: 'application/json', 'User-Agent': 'CompanionDesk' }; },
    actions: [
      { id: 'get_bounces', label: 'Read recent bounces on your Postmark server (capped)', scope: 'bounces.read', kind: 'read_only',
        params: [{ name: 'count', required: false, maxLength: 3 }],
        build: function (p, token) {
          const count = optionalInt(p, 'count', 50);
          if (count === null || count < 1 || count > 100) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://api.postmarkapp.com/bounces?count=' + count + '&offset=0', headers: this.buildHeaders(token), body: null };
        } },
      { id: 'get_bounce', label: 'Read one Postmark bounce by id', scope: 'bounces.read', kind: 'read_only',
        params: [{ name: 'bounce_id', required: true, maxLength: 20 }],
        build: function (p, token) {
          if (!/^\d{1,20}$/.test(p.bounce_id)) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://api.postmarkapp.com/bounces/' + encodeURIComponent(p.bounce_id), headers: this.buildHeaders(token), body: null };
        } },
    ],
  };

  ADAPTERS.circleci = {
    id: 'circleci', name: 'CircleCI', authShape: 'token', setupRequired: false,
    setupNote: 'create a personal API token at circleci.com/account/api and paste it; your token is stored only in the app vault, never requested or shown in chat',
    buildHeaders: function (token) { return { 'Circle-Token': token, 'User-Agent': 'CompanionDesk' }; },
    actions: [
      { id: 'get_me', label: 'Check the CircleCI token works', scope: 'pipelines.read', kind: 'read_only',
        params: [],
        build: function (p, token) {
          return { method: 'GET', url: 'https://circleci.com/api/v2/me', headers: this.buildHeaders(token), body: null };
        } },
      { id: 'list_projects', label: 'List your CircleCI projects (capped)', scope: 'pipelines.read', kind: 'read_only',
        params: [{ name: 'limit', required: false, maxLength: 3 }],
        build: function (p, token) {
          const limit = optionalInt(p, 'limit', 25);
          if (limit === null || limit < 1 || limit > 100) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://circleci.com/api/v2/projects?page-size=' + limit, headers: this.buildHeaders(token), body: null };
        } },
      { id: 'get_pipeline', label: 'Read one CircleCI pipeline by id', scope: 'pipelines.read', kind: 'read_only',
        params: [{ name: 'pipeline_id', required: true, maxLength: 80 }],
        build: function (p, token) {
          if (!/^[A-Za-z0-9-]+$/.test(p.pipeline_id)) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://circleci.com/api/v2/pipeline/' + encodeURIComponent(p.pipeline_id), headers: this.buildHeaders(token), body: null };
        } },
    ],
  };

  ADAPTERS.coda = {
    id: 'coda', name: 'Coda', authShape: 'token', setupRequired: false,
    setupNote: 'create an API token at coda.io/account and paste it; your token is stored only in the app vault, never requested or shown in chat',
    buildHeaders: function (token) { return { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'User-Agent': 'CompanionDesk' }; },
    actions: [
      { id: 'list_docs', label: 'List your Coda docs (capped)', scope: 'docs.read', kind: 'read_only',
        params: [{ name: 'limit', required: false, maxLength: 3 }],
        build: function (p, token) {
          const limit = optionalInt(p, 'limit', 25);
          if (limit === null || limit < 1 || limit > 100) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://coda.io/apis/v1/docs?limit=' + limit, headers: this.buildHeaders(token), body: null };
        } },
      { id: 'get_doc', label: 'Read one Coda doc by id', scope: 'docs.read', kind: 'read_only',
        params: [{ name: 'doc_id', required: true, maxLength: 80 }],
        build: function (p, token) {
          if (!/^[A-Za-z0-9_-]+$/.test(p.doc_id)) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://coda.io/apis/v1/docs/' + encodeURIComponent(p.doc_id), headers: this.buildHeaders(token), body: null };
        } },
      { id: 'create_doc', label: 'Create a Coda doc', scope: 'docs.write', kind: 'write',
        params: [{ name: 'title', required: true, maxLength: 200 }],
        build: function (p, token) {
          return { method: 'POST', url: 'https://coda.io/apis/v1/docs', headers: this.buildHeaders(token), body: JSON.stringify({ title: p.title }) };
        } },
    ],
  };

  function parseTrelloCred(token) {
    if (typeof token !== 'string') return null;
    const m = /^key=([A-Za-z0-9]{16,64})&token=([A-Za-z0-9]{16,128})$/.exec(token);
    return m ? { key: m[1], token: m[2] } : null;
  }

  ADAPTERS.trello = {
    id: 'trello', name: 'Trello', authShape: 'url_token', setupRequired: false,
    setupNote: 'create your own power-up key at trello.com/power-ups/admin, generate a token for it, and paste both as key=YOURKEY&token=YOURTOKEN; they are stored only in the app vault, never requested or shown in chat',
    buildHeaders: function () { return { 'User-Agent': 'CompanionDesk' }; },
    actions: [
      { id: 'list_boards', label: 'List your Trello boards (capped)', scope: 'boards.read', kind: 'read_only',
        params: [{ name: 'limit', required: false, maxLength: 3 }],
        build: function (p, token) {
          const cred = parseTrelloCred(token);
          if (!cred) return { error: 'credential_invalid' };
          const limit = optionalInt(p, 'limit', 50);
          if (limit === null || limit < 1 || limit > 100) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://api.trello.com/1/members/me/boards?fields=name,url&limit=' + limit + '&key=' + cred.key + '&token=' + cred.token, headers: this.buildHeaders(), body: null };
        } },
      { id: 'get_board_lists', label: "Read one board's lists", scope: 'boards.read', kind: 'read_only',
        params: [{ name: 'board_id', required: true, maxLength: 80 }, { name: 'limit', required: false, maxLength: 3 }],
        build: function (p, token) {
          const cred = parseTrelloCred(token);
          if (!cred) return { error: 'credential_invalid' };
          if (!/^[A-Za-z0-9_-]+$/.test(p.board_id)) return { error: 'param_invalid' };
          const limit = optionalInt(p, 'limit', 50);
          if (limit === null || limit < 1 || limit > 100) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://api.trello.com/1/boards/' + encodeURIComponent(p.board_id) + '/lists?limit=' + limit + '&key=' + cred.key + '&token=' + cred.token, headers: this.buildHeaders(), body: null };
        } },
      { id: 'get_cards', label: "Read one list's cards (capped)", scope: 'boards.read', kind: 'read_only',
        params: [{ name: 'list_id', required: true, maxLength: 80 }, { name: 'limit', required: false, maxLength: 3 }],
        build: function (p, token) {
          const cred = parseTrelloCred(token);
          if (!cred) return { error: 'credential_invalid' };
          if (!/^[A-Za-z0-9_-]+$/.test(p.list_id)) return { error: 'param_invalid' };
          const limit = optionalInt(p, 'limit', 50);
          if (limit === null || limit < 1 || limit > 100) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://api.trello.com/1/lists/' + encodeURIComponent(p.list_id) + '/cards?fields=name,url&limit=' + limit + '&key=' + cred.key + '&token=' + cred.token, headers: this.buildHeaders(), body: null };
        } },
      { id: 'create_card', label: 'Create a card in a Trello list', scope: 'boards.write', kind: 'write',
        params: [{ name: 'list_id', required: true, maxLength: 80 }, { name: 'name', required: true, maxLength: 200 }, { name: 'desc', required: false, maxLength: 5000 }],
        build: function (p, token) {
          const cred = parseTrelloCred(token);
          if (!cred) return { error: 'credential_invalid' };
          if (!/^[A-Za-z0-9_-]+$/.test(p.list_id)) return { error: 'param_invalid' };
          let url = 'https://api.trello.com/1/cards?idList=' + encodeURIComponent(p.list_id) + '&name=' + encodeURIComponent(p.name) + '&key=' + cred.key + '&token=' + cred.token;
          if (p.desc) url += '&desc=' + encodeURIComponent(p.desc);
          return { method: 'POST', url: url, headers: this.buildHeaders(), body: null };
        } },
    ],
  };

  ADAPTERS.linear = {
    id: 'linear', name: 'Linear', authShape: 'token', setupRequired: false,
    setupNote: 'create a personal API key at linear.app/settings/account/security and paste it; your key is stored only in the app vault, never requested or shown in chat',
    buildHeaders: function (token) { return { Authorization: token, 'Content-Type': 'application/json', 'User-Agent': 'CompanionDesk' }; },
    actions: [
      { id: 'list_issues', label: 'List recent issues in Linear (capped)', scope: 'issues.read', kind: 'read_only',
        params: [{ name: 'limit', required: false, maxLength: 3 }],
        build: function (p, token) {
          const limit = optionalInt(p, 'limit', 20);
          if (limit === null || limit < 1 || limit > 25) return { error: 'param_invalid' };
          return { method: 'POST', url: 'https://api.linear.app/graphql', headers: this.buildHeaders(token), body: JSON.stringify({ query: 'query($first: Int!) { issues(first: $first) { nodes { id title identifier state { name } } } }', variables: { first: limit } }) };
        } },
      { id: 'get_issue', label: 'Read one Linear issue by id', scope: 'issues.read', kind: 'read_only',
        params: [{ name: 'issue_id', required: true, maxLength: 80 }],
        build: function (p, token) {
          if (!/^[A-Za-z0-9-]+$/.test(p.issue_id)) return { error: 'param_invalid' };
          return { method: 'POST', url: 'https://api.linear.app/graphql', headers: this.buildHeaders(token), body: JSON.stringify({ query: 'query($id: String!) { issue(id: $id) { id title identifier description state { name } assignee { name } } }', variables: { id: p.issue_id } }) };
        } },
      { id: 'create_issue', label: 'Create an issue in Linear', scope: 'issues.write', kind: 'write',
        params: [{ name: 'team_id', required: true, maxLength: 80 }, { name: 'title', required: true, maxLength: 200 }, { name: 'description', required: false, maxLength: 5000 }],
        build: function (p, token) {
          if (!/^[A-Za-z0-9-]+$/.test(p.team_id)) return { error: 'param_invalid' };
          const input = { teamId: p.team_id, title: p.title };
          if (p.description) input.description = p.description;
          return { method: 'POST', url: 'https://api.linear.app/graphql', headers: this.buildHeaders(token), body: JSON.stringify({ query: 'mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier } } }', variables: { input: input } }) };
        } },
    ],
  };

  ADAPTERS.airtable = {
    id: 'airtable', name: 'Airtable', authShape: 'token', setupRequired: false,
    setupNote: 'create a personal access token at airtable.com/create/tokens with the data records scopes for your bases and paste it; your token is stored only in the app vault, never requested or shown in chat',
    buildHeaders: function (token) { return { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'User-Agent': 'CompanionDesk' }; },
    actions: [
      { id: 'list_bases', label: 'List the bases your token can reach', scope: 'records.read', kind: 'read_only',
        params: [],
        build: function (p, token) {
          return { method: 'GET', url: 'https://api.airtable.com/v0/meta/bases', headers: this.buildHeaders(token), body: null };
        } },
      { id: 'list_records', label: 'List records in one table (capped)', scope: 'records.read', kind: 'read_only',
        params: [{ name: 'base_id', required: true, maxLength: 17 }, { name: 'table', required: true, maxLength: 100 }, { name: 'max_records', required: false, maxLength: 4 }],
        build: function (p, token) {
          if (!/^[a-zA-Z0-9]{17}$/.test(p.base_id)) return { error: 'param_invalid' };
          const max = optionalInt(p, 'max_records', 50);
          if (max === null || max < 1 || max > 100) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://api.airtable.com/v0/' + p.base_id + '/' + encodeURIComponent(p.table) + '?maxRecords=' + max, headers: this.buildHeaders(token), body: null };
        } },
      { id: 'create_record', label: 'Create one record in a table', scope: 'records.write', kind: 'write',
        params: [{ name: 'base_id', required: true, maxLength: 17 }, { name: 'table', required: true, maxLength: 100 }, { name: 'fields_json', required: true, maxLength: 2000 }],
        build: function (p, token) {
          if (!/^[a-zA-Z0-9]{17}$/.test(p.base_id)) return { error: 'param_invalid' };
          let fields;
          try { fields = JSON.parse(p.fields_json); } catch (e) { return { error: 'param_invalid' }; }
          if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return { error: 'param_invalid' };
          const keys = Object.keys(fields);
          if (keys.length < 1 || keys.length > 20) return { error: 'param_invalid' };
          for (const k of keys) {
            if (typeof k !== 'string' || k.length > 100) return { error: 'param_invalid' };
            const v = fields[k];
            if (!(v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) return { error: 'param_invalid' };
          }
          return { method: 'POST', url: 'https://api.airtable.com/v0/' + p.base_id + '/' + encodeURIComponent(p.table), headers: this.buildHeaders(token), body: JSON.stringify({ fields: fields }) };
        } },
    ],
  };

  ADAPTERS.todoist = {
    id: 'todoist', name: 'Todoist', authShape: 'token', setupRequired: false,
    setupNote: 'paste your own Todoist API token from app.todoist.com/app/settings/integrations/developer; your token is stored only in the app vault, never requested or shown in chat',
    buildHeaders: function (token) { return { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'User-Agent': 'CompanionDesk' }; },
    actions: [
      { id: 'get_projects', label: 'List your Todoist projects', scope: 'tasks.read', kind: 'read_only',
        params: [],
        build: function (p, token) {
          return { method: 'GET', url: 'https://api.todoist.com/rest/v2/projects', headers: this.buildHeaders(token), body: null };
        } },
      { id: 'get_tasks', label: 'List active tasks, optionally filtered', scope: 'tasks.read', kind: 'read_only',
        params: [{ name: 'project_id', required: false, maxLength: 80 }, { name: 'filter', required: false, maxLength: 200 }, { name: 'limit', required: false, maxLength: 3 }],
        build: function (p, token) {
          const qs = [];
          if (p.project_id) {
            if (!/^[A-Za-z0-9]+$/.test(p.project_id)) return { error: 'param_invalid' };
            qs.push('project_id=' + encodeURIComponent(p.project_id));
          }
          if (p.filter) qs.push('filter=' + encodeURIComponent(p.filter));
          const limit = optionalInt(p, 'limit', 50);
          if (limit === null || limit < 1 || limit > 100) return { error: 'param_invalid' };
          qs.push('limit=' + limit);
          return { method: 'GET', url: 'https://api.todoist.com/rest/v2/tasks' + (qs.length ? '?' + qs.join('&') : ''), headers: this.buildHeaders(token), body: null };
        } },
      { id: 'create_task', label: 'Create a task in Todoist', scope: 'tasks.write', kind: 'write',
        params: [{ name: 'content', required: true, maxLength: 500 }, { name: 'project_id', required: false, maxLength: 80 }, { name: 'due_string', required: false, maxLength: 100 }, { name: 'priority', required: false, maxLength: 1 }],
        build: function (p, token) {
          const body = { content: p.content };
          if (p.project_id) {
            if (!/^[A-Za-z0-9]+$/.test(p.project_id)) return { error: 'param_invalid' };
            body.project_id = p.project_id;
          }
          if (p.due_string) body.due_string = p.due_string;
          if (p.priority) {
            const pr = optionalInt(p, 'priority', 0);
            if (pr === null || pr < 1 || pr > 4) return { error: 'param_invalid' };
            body.priority = pr;
          }
          return { method: 'POST', url: 'https://api.todoist.com/rest/v2/tasks', headers: this.buildHeaders(token), body: JSON.stringify(body) };
        } },
    ],
  };

  ADAPTERS.notion = {
    id: 'notion', name: 'Notion', authShape: 'token', setupRequired: false,
    setupNote: 'create an internal integration at notion.so/my-integrations and paste its secret token',
    buildHeaders: function (token) { return { Authorization: 'Bearer ' + token, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' }; },
    actions: [
      { id: 'search', label: 'Search accessible pages and databases', scope: 'pages.read', kind: 'read_only',
        params: [{ name: 'query', required: false, maxLength: 200 }],
        build: function (p, token) {
          const body = { page_size: 20 };
          if (p.query) body.query = p.query;
          return { method: 'POST', url: 'https://api.notion.com/v1/search', headers: this.buildHeaders(token), body: JSON.stringify(body) };
        } },
      { id: 'get_page', label: 'Retrieve one page by id', scope: 'pages.read', kind: 'read_only',
        params: [{ name: 'page_id', required: true, maxLength: 80 }],
        build: function (p, token) {
          return { method: 'GET', url: 'https://api.notion.com/v1/pages/' + encodeURIComponent(p.page_id), headers: this.buildHeaders(token), body: null };
        } },
      { id: 'get_page_blocks', label: "Read a page's content blocks", scope: 'pages.read', kind: 'read_only',
        params: [{ name: 'page_id', required: true, maxLength: 80 }],
        build: function (p, token) {
          return { method: 'GET', url: 'https://api.notion.com/v1/blocks/' + encodeURIComponent(p.page_id) + '/children?page_size=100', headers: this.buildHeaders(token), body: null };
        } },
      { id: 'create_page', label: 'Create a page under a parent page', scope: 'pages.write', kind: 'write',
        params: [{ name: 'parent_id', required: true, maxLength: 80 }, { name: 'title', required: true, maxLength: 200 }, { name: 'content', required: false, maxLength: 20000 }],
        build: function (p, token) {
          const body = { parent: { page_id: p.parent_id }, properties: { title: { title: [{ text: { content: p.title } }] } } };
          if (p.content) body.children = [{ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: p.content } }] } }];
          return { method: 'POST', url: 'https://api.notion.com/v1/pages', headers: this.buildHeaders(token), body: JSON.stringify(body) };
        } },
    ],
  };

  ADAPTERS.slack = {
    id: 'slack', name: 'Slack', authShape: 'token', setupRequired: false,
    setupNote: 'create your own Slack app and bot token (xoxb...) at api.slack.com/apps; the bot needs the matching scopes',
    buildHeaders: function (token) { return { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }; },
    actions: [
      { id: 'auth_test', label: 'Check the bot token works', scope: 'channels.read', kind: 'read_only',
        params: [],
        build: function (p, token) {
          return { method: 'POST', url: 'https://slack.com/api/auth.test', headers: this.buildHeaders(token), body: '{}' };
        } },
      { id: 'list_channels', label: 'List public channels the bot can see', scope: 'channels.read', kind: 'read_only',
        params: [],
        build: function (p, token) {
          return { method: 'GET', url: 'https://slack.com/api/conversations.list?limit=50&types=public_channel', headers: this.buildHeaders(token), body: null };
        } },
      { id: 'get_channel', label: 'Read one channel by id', scope: 'channels.read', kind: 'read_only',
        params: [{ name: 'channel', required: true, maxLength: 80 }],
        build: function (p, token) {
          return { method: 'GET', url: 'https://slack.com/api/conversations.info?channel=' + encodeURIComponent(p.channel), headers: this.buildHeaders(token), body: null };
        } },
      { id: 'list_users', label: 'List people in the workspace', scope: 'users.read', kind: 'read_only',
        params: [{ name: 'limit', required: false, maxLength: 3 }],
        build: function (p, token) {
          const limit = optionalInt(p, 'limit', 50);
          if (limit === null) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://slack.com/api/users.list?limit=' + limit, headers: this.buildHeaders(token), body: null };
        } },
      { id: 'get_channel_history', label: 'Read recent messages in a channel', scope: 'channels.read', kind: 'read_only',
        params: [{ name: 'channel', required: true, maxLength: 80 }, { name: 'limit', required: false, maxLength: 3 }],
        build: function (p, token) {
          const limit = optionalInt(p, 'limit', 20);
          if (limit === null) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://slack.com/api/conversations.history?channel=' + encodeURIComponent(p.channel) + '&limit=' + limit, headers: this.buildHeaders(token), body: null };
        } },
      { id: 'post_message', label: 'Post a message to a channel', scope: 'message.send', kind: 'send',
        params: [{ name: 'channel', required: true, maxLength: 80 }, { name: 'text', required: true, maxLength: 4000 }],
        build: function (p, token) {
          return { method: 'POST', url: 'https://slack.com/api/chat.postMessage', headers: this.buildHeaders(token), body: JSON.stringify({ channel: p.channel, text: p.text }) };
        } },
    ],
  };

  ADAPTERS.discord = {
    id: 'discord', name: 'Discord', authShape: 'token', setupRequired: false,
    setupNote: 'create your own bot application at discord.com/developers/applications and paste its bot token',
    buildHeaders: function (token) { return { Authorization: 'Bot ' + token, 'Content-Type': 'application/json' }; },
    actions: [
      { id: 'list_guilds', label: 'List guilds the bot is in', scope: 'guilds.read', kind: 'read_only',
        params: [],
        build: function (p, token) {
          return { method: 'GET', url: 'https://discord.com/api/v10/users/@me/guilds', headers: this.buildHeaders(token), body: null };
        } },
      { id: 'list_channels', label: 'List channels in a guild', scope: 'guilds.read', kind: 'read_only',
        params: [{ name: 'guild_id', required: true, maxLength: 25 }],
        build: function (p, token) {
          if (!/^\d{5,25}$/.test(p.guild_id)) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://discord.com/api/v10/guilds/' + p.guild_id + '/channels', headers: this.buildHeaders(token), body: null };
        } },
      { id: 'get_channel', label: 'Read one channel by id', scope: 'channels.read', kind: 'read_only',
        params: [{ name: 'channel_id', required: true, maxLength: 25 }],
        build: function (p, token) {
          if (!/^\d{5,25}$/.test(p.channel_id)) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://discord.com/api/v10/channels/' + p.channel_id, headers: this.buildHeaders(token), body: null };
        } },
      { id: 'list_channel_messages', label: 'Read recent messages in a channel', scope: 'channels.read', kind: 'read_only',
        params: [{ name: 'channel_id', required: true, maxLength: 25 }, { name: 'limit', required: false, maxLength: 3 }],
        build: function (p, token) {
          if (!/^\d{5,25}$/.test(p.channel_id)) return { error: 'param_invalid' };
          const limit = optionalInt(p, 'limit', 20);
          if (limit === null) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://discord.com/api/v10/channels/' + p.channel_id + '/messages?limit=' + limit, headers: this.buildHeaders(token), body: null };
        } },
      { id: 'send_message', label: 'Send a message to a channel', scope: 'message.send', kind: 'send',
        params: [{ name: 'channel_id', required: true, maxLength: 40 }, { name: 'content', required: true, maxLength: 2000 }],
        build: function (p, token) {
          return { method: 'POST', url: 'https://discord.com/api/v10/channels/' + encodeURIComponent(p.channel_id) + '/messages', headers: this.buildHeaders(token), body: JSON.stringify({ content: p.content }) };
        } },
    ],
  };

  ADAPTERS.telegram = {
    id: 'telegram', name: 'Telegram', authShape: 'url_token', setupRequired: false,
    setupNote: 'create your own bot with @BotFather and paste its bot token',
    actions: [
      { id: 'get_me', label: 'Check the bot token works', scope: 'chats.read', kind: 'read_only',
        params: [],
        build: function (p, token) {
          return { method: 'GET', url: 'https://api.telegram.org/bot' + encodeURIComponent(token) + '/getMe', headers: {}, body: null };
        } },
      { id: 'get_updates', label: 'Read recent messages and updates sent to the bot', scope: 'chats.read', kind: 'read_only',
        params: [{ name: 'limit', required: false, maxLength: 3 }, { name: 'offset', required: false, maxLength: 20 }],
        build: function (p, token) {
          const limit = optionalInt(p, 'limit', 20);
          if (limit === null) return { error: 'param_invalid' };
          let qs = '?limit=' + limit;
          if (p.offset !== undefined && p.offset !== '') {
            if (!/^\d{1,20}$/.test(p.offset)) return { error: 'param_invalid' };
            qs += '&offset=' + p.offset;
          }
          return { method: 'GET', url: 'https://api.telegram.org/bot' + encodeURIComponent(token) + '/getUpdates' + qs, headers: {}, body: null };
        } },
      { id: 'get_chat', label: 'Read one chat by id', scope: 'chats.read', kind: 'read_only',
        params: [{ name: 'chat_id', required: true, maxLength: 21 }],
        build: function (p, token) {
          if (!/^-?\d{1,20}$/.test(p.chat_id)) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://api.telegram.org/bot' + encodeURIComponent(token) + '/getChat?chat_id=' + encodeURIComponent(p.chat_id), headers: {}, body: null };
        } },
      { id: 'send_message', label: 'Send a message to a chat', scope: 'message.send', kind: 'send',
        params: [{ name: 'chat_id', required: true, maxLength: 80 }, { name: 'text', required: true, maxLength: 4000 }],
        build: function (p, token) {
          return { method: 'POST', url: 'https://api.telegram.org/bot' + encodeURIComponent(token) + '/sendMessage', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: p.chat_id, text: p.text }) };
        } },
    ],
  };

  ADAPTERS.openai = {
    id: 'openai', name: 'OpenAI', authShape: 'token', setupRequired: false,
    setupNote: 'paste your own API key from platform.openai.com; the API is paid per token',
    buildHeaders: function (token) { return { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }; },
    actions: [
      { id: 'list_models', label: 'List models the key can use', scope: 'models.read', kind: 'read_only',
        params: [],
        build: function (p, token) {
          return { method: 'GET', url: 'https://api.openai.com/v1/models', headers: this.buildHeaders(token), body: null };
        } },
      { id: 'chat', label: 'Generate a chat completion', scope: 'completions.send', kind: 'send',
        params: [{ name: 'model', required: true, maxLength: 80 }, { name: 'messages', required: true, maxLength: MAX_PARAM_CHARS }],
        build: function (p, token) {
          let messages = null;
          try { messages = JSON.parse(p.messages); } catch (e) { return { error: 'param_invalid' }; }
          if (!Array.isArray(messages)) return { error: 'param_invalid' };
          return { method: 'POST', url: 'https://api.openai.com/v1/chat/completions', headers: this.buildHeaders(token), body: JSON.stringify({ model: p.model, messages: messages }) };
        } },
    ],
  };

  ADAPTERS.anthropic = {
    id: 'anthropic', name: 'Anthropic', authShape: 'token', setupRequired: false,
    setupNote: 'paste your own API key from console.anthropic.com; the API is paid per token',
    buildHeaders: function (token) { return { 'x-api-key': token, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }; },
    actions: [
      { id: 'list_models', label: 'List models the key can use', scope: 'models.read', kind: 'read_only',
        params: [],
        build: function (p, token) {
          return { method: 'GET', url: 'https://api.anthropic.com/v1/models', headers: this.buildHeaders(token), body: null };
        } },
      { id: 'message', label: 'Generate a message', scope: 'messages.send', kind: 'send',
        params: [{ name: 'model', required: true, maxLength: 80 }, { name: 'messages', required: true, maxLength: MAX_PARAM_CHARS }, { name: 'max_tokens', required: false, maxLength: 8 }],
        build: function (p, token) {
          let messages = null;
          try { messages = JSON.parse(p.messages); } catch (e) { return { error: 'param_invalid' }; }
          if (!Array.isArray(messages)) return { error: 'param_invalid' };
          const maxTokens = optionalInt(p, 'max_tokens', 1024);
          if (maxTokens === null) return { error: 'param_invalid' };
          return { method: 'POST', url: 'https://api.anthropic.com/v1/messages', headers: this.buildHeaders(token), body: JSON.stringify({ model: p.model, messages: messages, max_tokens: maxTokens }) };
        } },
    ],
  };

  ADAPTERS.huggingface = {
    id: 'huggingface', name: 'Hugging Face', authShape: 'token', setupRequired: false,
    setupNote: 'create a read access token at huggingface.co/settings/tokens and paste it (the account token is free; inference itself may cost on paid models)',
    buildHeaders: function (token) { return { Authorization: 'Bearer ' + token, 'User-Agent': 'CompanionDesk', Accept: 'application/json' }; },
    actions: [
      { id: 'whoami', label: 'Check the token works and who it belongs to', scope: 'models.read', kind: 'read_only',
        params: [],
        build: function (p, token) {
          return { method: 'GET', url: 'https://huggingface.co/api/whoami-v2', headers: this.buildHeaders(token), body: null };
        } },
      { id: 'list_models', label: 'List or search models on the Hub', scope: 'models.read', kind: 'read_only',
        params: [{ name: 'search', required: false, maxLength: 200 }, { name: 'limit', required: false, maxLength: 3 }],
        build: function (p, token) {
          const limit = optionalInt(p, 'limit', 20);
          if (limit === null) return { error: 'param_invalid' };
          let url = 'https://huggingface.co/api/models?limit=' + limit;
          if (p.search) url += '&search=' + encodeURIComponent(p.search);
          return { method: 'GET', url: url, headers: this.buildHeaders(token), body: null };
        } },
    ],
  };

  ADAPTERS.arxiv = {
    id: 'arxiv', name: 'arXiv', authShape: 'public', setupRequired: false,
    setupNote: 'no account or key needed: the arXiv API is public and free; keep usage gentle (about one request every 3 seconds)',
    buildHeaders: function () { return { 'User-Agent': 'CompanionDesk', Accept: 'application/atom+xml, application/json;q=0.8' }; },
    actions: [
      { id: 'search_papers', label: 'Search arXiv for papers', scope: 'papers.read', kind: 'read_only',
        params: [{ name: 'query', required: true, maxLength: 200 }, { name: 'limit', required: false, maxLength: 3 }],
        build: function (p) {
          const limit = optionalInt(p, 'limit', 20);
          if (limit === null) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://export.arxiv.org/api/query?search_query=all:' + encodeURIComponent(p.query) + '&start=0&max_results=' + limit, headers: this.buildHeaders(), body: null };
        } },
      { id: 'get_paper', label: 'Read one paper by arXiv id', scope: 'papers.read', kind: 'read_only',
        params: [{ name: 'id', required: true, maxLength: 60 }],
        build: function (p) {
          if (!/^[A-Za-z0-9][A-Za-z0-9.\-\/]*$/.test(p.id)) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://export.arxiv.org/api/query?id_list=' + encodeURIComponent(p.id) + '&max_results=1', headers: this.buildHeaders(), body: null };
        } },
    ],
  };

  ADAPTERS.crossref = {
    id: 'crossref', name: 'Crossref', authShape: 'public', setupRequired: false,
    setupNote: 'no account or key needed: the Crossref REST API is public; the optional polite-pool mailto parameter is not sent by this build',
    buildHeaders: function () { return { 'User-Agent': 'CompanionDesk', Accept: 'application/json' }; },
    actions: [
      { id: 'search_works', label: 'Search Crossref for scholarly works', scope: 'works.read', kind: 'read_only',
        params: [{ name: 'query', required: true, maxLength: 200 }, { name: 'limit', required: false, maxLength: 3 }],
        build: function (p) {
          const limit = optionalInt(p, 'limit', 20);
          if (limit === null) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://api.crossref.org/works?query=' + encodeURIComponent(p.query) + '&rows=' + limit, headers: this.buildHeaders(), body: null };
        } },
      { id: 'get_work', label: 'Read one work by DOI', scope: 'works.read', kind: 'read_only',
        params: [{ name: 'doi', required: true, maxLength: 200 }],
        build: function (p) {
          if (!/^10\.[0-9]{4,9}\//.test(p.doi)) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://api.crossref.org/works/' + encodeURIComponent(p.doi), headers: this.buildHeaders(), body: null };
        } },
    ],
  };

  ADAPTERS['docker-hub'] = {
    id: 'docker-hub', name: 'Docker Hub', authShape: 'public', setupRequired: false,
    setupNote: 'no account or key needed: the Docker Hub v2 API is public and keyless for public repositories; private repositories need authentication this build never requests, and image pulls stay out of scope (the adapter reads metadata only)',
    buildHeaders: function () { return { 'User-Agent': 'CompanionDesk', Accept: 'application/json' }; },
    actions: [
      { id: 'search_repositories', label: 'Search Docker Hub public repositories', scope: 'images.read', kind: 'read_only',
        params: [{ name: 'query', required: true, maxLength: 200 }, { name: 'limit', required: false, maxLength: 3 }],
        build: function (p) {
          if (!/^[ -~]+$/.test(p.query)) return { error: 'param_invalid' };
          const limit = optionalInt(p, 'limit', 20);
          if (limit === null || limit < 1 || limit > 25) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://hub.docker.com/v2/search/repositories/?query=' + encodeURIComponent(p.query) + '&page_size=' + limit, headers: this.buildHeaders(), body: null };
        } },
      { id: 'get_repository', label: 'Read one Docker Hub public repository by namespace and name', scope: 'images.read', kind: 'read_only',
        params: [{ name: 'namespace', required: true, maxLength: 100 }, { name: 'repository', required: true, maxLength: 100 }],
        build: function (p) {
          if (!/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(p.namespace)) return { error: 'param_invalid' };
          if (!/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(p.repository)) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://hub.docker.com/v2/repositories/' + encodeURIComponent(p.namespace) + '/' + encodeURIComponent(p.repository) + '/', headers: this.buildHeaders(), body: null };
        } },
      { id: 'get_tags', label: 'List tags of a Docker Hub public repository', scope: 'images.read', kind: 'read_only',
        params: [{ name: 'namespace', required: true, maxLength: 100 }, { name: 'repository', required: true, maxLength: 100 }],
        build: function (p) {
          if (!/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(p.namespace)) return { error: 'param_invalid' };
          if (!/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(p.repository)) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://hub.docker.com/v2/repositories/' + encodeURIComponent(p.namespace) + '/' + encodeURIComponent(p.repository) + '/tags?page_size=20', headers: this.buildHeaders(), body: null };
        } },
    ],
  };

  ADAPTERS['internet-archive'] = {
    id: 'internet-archive', name: 'Internet Archive', authShape: 'public', setupRequired: false,
    setupNote: 'no account or key needed: the Internet Archive advanced search and metadata APIs are public and keyless for reads; uploading items is an authenticated API this build never touches',
    buildHeaders: function () { return { 'User-Agent': 'CompanionDesk', Accept: 'application/json' }; },
    actions: [
      { id: 'search_items', label: 'Search the Internet Archive for items', scope: 'metadata.read', kind: 'read_only',
        params: [{ name: 'query', required: true, maxLength: 200 }, { name: 'limit', required: false, maxLength: 3 }],
        build: function (p) {
          if (!/^[ -~]+$/.test(p.query)) return { error: 'param_invalid' };
          const limit = optionalInt(p, 'limit', 20);
          if (limit === null || limit < 1 || limit > 50) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://archive.org/advancedsearch.php?q=' + encodeURIComponent(p.query) + '&fl%5B%5D=identifier&fl%5B%5D=title&fl%5B%5D=mediatype&rows=' + limit + '&output=json&page=1', headers: this.buildHeaders(), body: null };
        } },
      { id: 'get_metadata', label: 'Read one Internet Archive item by identifier', scope: 'metadata.read', kind: 'read_only',
        params: [{ name: 'identifier', required: true, maxLength: 100 }],
        build: function (p) {
          if (!/^[A-Za-z0-9._~-]+$/.test(p.identifier)) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://archive.org/metadata/' + encodeURIComponent(p.identifier), headers: this.buildHeaders(), body: null };
        } },
    ],
  };

  ADAPTERS.npm = {
    id: 'npm', name: 'npm', authShape: 'public', setupRequired: false,
    setupNote: 'no account or key needed: the npm registry API is public and keyless for public packages; publishing and private packages need authentication this build never requests',
    buildHeaders: function () { return { 'User-Agent': 'CompanionDesk', Accept: 'application/json' }; },
    actions: [
      { id: 'get_package', label: 'Read an npm package: full registry metadata', scope: 'packages.read', kind: 'read_only',
        params: [{ name: 'package', required: true, maxLength: 214 }],
        build: function (p) {
          if (!/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(p.package)) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://registry.npmjs.org/' + encodeURIComponent(p.package).replace(/^%40/, '@'), headers: this.buildHeaders(), body: null };
        } },
      { id: 'search_packages', label: 'Search npm for public packages', scope: 'packages.read', kind: 'read_only',
        params: [{ name: 'query', required: true, maxLength: 200 }, { name: 'limit', required: false, maxLength: 3 }],
        build: function (p) {
          if (!/^[ -~]+$/.test(p.query)) return { error: 'param_invalid' };
          const limit = optionalInt(p, 'limit', 20);
          if (limit === null || limit < 1 || limit > 25) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://registry.npmjs.org/-/v1/search?text=' + encodeURIComponent(p.query) + '&size=' + limit, headers: this.buildHeaders(), body: null };
        } },
    ],
  };

  ADAPTERS.pypi = {
    id: 'pypi', name: 'PyPI', authShape: 'public', setupRequired: false,
    setupNote: 'no account or key needed: the PyPI JSON API is public and keyless for reads; uploading packages is a different, authenticated API this build never touches',
    buildHeaders: function () { return { 'User-Agent': 'CompanionDesk', Accept: 'application/json' }; },
    actions: [
      { id: 'get_package', label: 'Read a PyPI package: latest release metadata', scope: 'packages.read', kind: 'read_only',
        params: [{ name: 'package', required: true, maxLength: 100 }],
        build: function (p) {
          if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(p.package)) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://pypi.org/pypi/' + encodeURIComponent(p.package) + '/json', headers: this.buildHeaders(), body: null };
        } },
      { id: 'get_release', label: 'Read one PyPI release by package and version', scope: 'packages.read', kind: 'read_only',
        params: [{ name: 'package', required: true, maxLength: 100 }, { name: 'version', required: true, maxLength: 50 }],
        build: function (p) {
          if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(p.package)) return { error: 'param_invalid' };
          if (!/^[A-Za-z0-9.!+_-]+$/.test(p.version)) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://pypi.org/pypi/' + encodeURIComponent(p.package) + '/' + encodeURIComponent(p.version) + '/json', headers: this.buildHeaders(), body: null };
        } },
    ],
  };

  ADAPTERS.musicbrainz = {
    id: 'musicbrainz', name: 'MusicBrainz', authShape: 'public', setupRequired: false,
    setupNote: 'no account or key needed: the MusicBrainz web service is public and free; this build keeps to its one-request-per-second rate limit',
    buildHeaders: function () { return { 'User-Agent': 'CompanionDesk', Accept: 'application/json' }; },
    actions: [
      { id: 'search_artists', label: 'Search MusicBrainz for artists', scope: 'recordings.read', kind: 'read_only',
        params: [{ name: 'query', required: true, maxLength: 200 }, { name: 'limit', required: false, maxLength: 2 }],
        build: function (p) {
          if (!/^[ -~]+$/.test(p.query)) return { error: 'param_invalid' };
          const limit = optionalInt(p, 'limit', 20);
          if (limit === null || limit < 1 || limit > 25) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://musicbrainz.org/ws/2/artist?query=' + encodeURIComponent(p.query) + '&fmt=json&limit=' + limit, headers: this.buildHeaders(), body: null };
        } },
      { id: 'search_recordings', label: 'Search MusicBrainz for recordings', scope: 'recordings.read', kind: 'read_only',
        params: [{ name: 'query', required: true, maxLength: 200 }, { name: 'limit', required: false, maxLength: 2 }],
        build: function (p) {
          if (!/^[ -~]+$/.test(p.query)) return { error: 'param_invalid' };
          const limit = optionalInt(p, 'limit', 20);
          if (limit === null || limit < 1 || limit > 25) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://musicbrainz.org/ws/2/recording?query=' + encodeURIComponent(p.query) + '&fmt=json&limit=' + limit, headers: this.buildHeaders(), body: null };
        } },
      { id: 'get_artist', label: 'Read one MusicBrainz artist by MBID', scope: 'recordings.read', kind: 'read_only',
        params: [{ name: 'mbid', required: true, maxLength: 36 }],
        build: function (p) {
          if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p.mbid)) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://musicbrainz.org/ws/2/artist/' + encodeURIComponent(p.mbid) + '?fmt=json', headers: this.buildHeaders(), body: null };
        } },
    ],
  };

  ADAPTERS.openalex = {
    id: 'openalex', name: 'OpenAlex', authShape: 'public', setupRequired: false,
    setupNote: 'no account or key needed: the OpenAlex API is public and free; the optional polite-pool mailto parameter is not sent by this build',
    buildHeaders: function () { return { 'User-Agent': 'CompanionDesk', Accept: 'application/json' }; },
    actions: [
      { id: 'search_works', label: 'Search OpenAlex for scholarly works', scope: 'works.read', kind: 'read_only',
        params: [{ name: 'search', required: true, maxLength: 200 }, { name: 'limit', required: false, maxLength: 3 }],
        build: function (p) {
          const limit = optionalInt(p, 'limit', 20);
          if (limit === null) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://api.openalex.org/works?search=' + encodeURIComponent(p.search) + '&per-page=' + limit, headers: this.buildHeaders(), body: null };
        } },
      { id: 'get_work', label: 'Read one work by OpenAlex id or DOI', scope: 'works.read', kind: 'read_only',
        params: [{ name: 'work_id', required: true, maxLength: 200 }],
        build: function (p) {
          const okShape = /^W[0-9]{1,15}$/.test(p.work_id) || /^(doi:)?10\.[0-9]{4,9}\/[A-Za-z0-9._()\-\/]+$/.test(p.work_id);
          if (!okShape) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://api.openalex.org/works/' + encodeURIComponent(p.work_id), headers: this.buildHeaders(), body: null };
        } },
    ],
  };

  ADAPTERS['open-meteo'] = {
    id: 'open-meteo', name: 'Open-Meteo', authShape: 'public', setupRequired: false,
    setupNote: 'no account or key needed: the Open-Meteo API is public and free for non-commercial use; keep within its fair-use daily quota',
    buildHeaders: function () { return { 'User-Agent': 'CompanionDesk', Accept: 'application/json' }; },
    actions: [
      { id: 'get_current_weather', label: 'Read current weather at coordinates', scope: 'weather.read', kind: 'read_only',
        params: [{ name: 'latitude', required: true, maxLength: 12 }, { name: 'longitude', required: true, maxLength: 12 }],
        build: function (p) {
          const lat = validCoordinate(p.latitude, 90), lon = validCoordinate(p.longitude, 180);
          if (lat === null || lon === null) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lon + '&current=temperature_2m,weather_code,wind_speed_10m', headers: this.buildHeaders(), body: null };
        } },
      { id: 'get_daily_forecast', label: 'Read the daily forecast at coordinates', scope: 'weather.read', kind: 'read_only',
        params: [{ name: 'latitude', required: true, maxLength: 12 }, { name: 'longitude', required: true, maxLength: 12 }, { name: 'days', required: false, maxLength: 2 }],
        build: function (p) {
          const lat = validCoordinate(p.latitude, 90), lon = validCoordinate(p.longitude, 180);
          if (lat === null || lon === null) return { error: 'param_invalid' };
          const days = optionalInt(p, 'days', 7);
          if (days === null || days > 16) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lon + '&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code&forecast_days=' + days, headers: this.buildHeaders(), body: null };
        } },
    ],
  };

  ADAPTERS.openstreetmap = {
    id: 'openstreetmap', name: 'OpenStreetMap', authShape: 'public', setupRequired: false,
    setupNote: 'no account or key needed: Nominatim is public; its usage policy requires a descriptive User-Agent (this build sends one) and at most one request per second',
    buildHeaders: function () { return { 'User-Agent': 'CompanionDesk/1.0 (https://github.com/NinadHirani/CompanionDesk)', Accept: 'application/json' }; },
    actions: [
      { id: 'search_places', label: 'Search places by name (Nominatim)', scope: 'places.read', kind: 'read_only',
        params: [{ name: 'query', required: true, maxLength: 200 }, { name: 'limit', required: false, maxLength: 2 }],
        build: function (p) {
          const limit = optionalInt(p, 'limit', 10);
          if (limit === null || limit > 50) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://nominatim.openstreetmap.org/search?q=' + encodeURIComponent(p.query) + '&format=jsonv2&limit=' + limit, headers: this.buildHeaders(), body: null };
        } },
      { id: 'reverse_geocode', label: 'Look up the place at coordinates', scope: 'places.read', kind: 'read_only',
        params: [{ name: 'latitude', required: true, maxLength: 12 }, { name: 'longitude', required: true, maxLength: 12 }],
        build: function (p) {
          const lat = validCoordinate(p.latitude, 90), lon = validCoordinate(p.longitude, 180);
          if (lat === null || lon === null) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://nominatim.openstreetmap.org/reverse?lat=' + lat + '&lon=' + lon + '&format=jsonv2', headers: this.buildHeaders(), body: null };
        } },
    ],
  };

  ADAPTERS.wikimedia = {
    id: 'wikimedia', name: 'Wikimedia', authShape: 'public', setupRequired: false,
    setupNote: 'no account or key needed: the MediaWiki and Wikipedia REST APIs are public; Wikimedia asks for a descriptive User-Agent (this build sends one) and polite-use rates',
    buildHeaders: function () { return { 'User-Agent': 'CompanionDesk/1.0 (https://github.com/NinadHirani/CompanionDesk)', Accept: 'application/json' }; },
    actions: [
      { id: 'search_pages', label: 'Search Wikipedia articles', scope: 'search.read', kind: 'read_only',
        params: [{ name: 'query', required: true, maxLength: 200 }, { name: 'limit', required: false, maxLength: 3 }],
        build: function (p) {
          const limit = optionalInt(p, 'limit', 10);
          if (limit === null || limit > 50) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=' + encodeURIComponent(p.query) + '&format=json&srlimit=' + limit, headers: this.buildHeaders(), body: null };
        } },
      { id: 'get_page_summary', label: 'Read the summary of one Wikipedia page', scope: 'search.read', kind: 'read_only',
        params: [{ name: 'title', required: true, maxLength: 200 }],
        build: function (p) {
          return { method: 'GET', url: 'https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(p.title), headers: this.buildHeaders(), body: null };
        } },
    ],
  };

  ADAPTERS.openlibrary = {
    id: 'openlibrary', name: 'Open Library', authShape: 'public', setupRequired: false,
    setupNote: 'no account or key needed: the Open Library search and metadata APIs are public and polite-use rate limited',
    buildHeaders: function () { return { 'User-Agent': 'CompanionDesk/1.0 (https://github.com/NinadHirani/CompanionDesk)', Accept: 'application/json' }; },
    actions: [
      { id: 'search_books', label: 'Search Open Library for books', scope: 'books.read', kind: 'read_only',
        params: [{ name: 'query', required: true, maxLength: 200 }, { name: 'limit', required: false, maxLength: 3 }],
        build: function (p) {
          const limit = optionalInt(p, 'limit', 20);
          if (limit === null || limit > 100) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://openlibrary.org/search.json?q=' + encodeURIComponent(p.query) + '&limit=' + limit, headers: this.buildHeaders(), body: null };
        } },
      { id: 'get_book', label: 'Read one book by ISBN or Open Library id', scope: 'books.read', kind: 'read_only',
        params: [{ name: 'identifier', required: true, maxLength: 40 }],
        build: function (p) {
          const id = p.identifier;
          if (/^[0-9]{9}([0-9]|X|x)$/.test(id) || /^[0-9]{13}$/.test(id)) {
            return { method: 'GET', url: 'https://openlibrary.org/isbn/' + encodeURIComponent(id) + '.json', headers: this.buildHeaders(), body: null };
          }
          if (/^OL[0-9]+M$/.test(id)) {
            return { method: 'GET', url: 'https://openlibrary.org/books/' + encodeURIComponent(id) + '.json', headers: this.buildHeaders(), body: null };
          }
          if (/^OL[0-9]+W$/.test(id)) {
            return { method: 'GET', url: 'https://openlibrary.org/works/' + encodeURIComponent(id) + '.json', headers: this.buildHeaders(), body: null };
          }
          return { error: 'param_invalid' };
        } },
    ],
  };

  ADAPTERS.jira = {
    id: 'jira', name: 'Jira', authShape: 'token', setupRequired: false,
    setupNote: 'in the app, enter your Atlassian account email, your API token (create one at id.atlassian.com) and your tenant site address (https://your-site.atlassian.net); all three are stored only in the app vault, never requested or shown in chat; this build reads Jira Cloud only',
    hostValid: function (h) {
      return typeof h === 'string' && /^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.atlassian\.net$/i.test(h);
    },
    credentialPayload: function (cred) {
      let p;
      try { p = JSON.parse(cred); } catch (e) { return null; }
      if (!p || typeof p !== 'object') return null;
      if (typeof p.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)) return null;
      if (typeof p.token !== 'string' || p.token.length < 10) return null;
      if (!this.hostValid(p.host)) return null;
      return p;
    },
    buildHeaders: function (c) {
      return { Authorization: 'Basic ' + Buffer.from(c.email + ':' + c.token, 'utf8').toString('base64'), Accept: 'application/json', 'User-Agent': 'CompanionDesk' };
    },
    actions: [
      { id: 'get_issue', label: 'Read one Jira issue by key', scope: 'issues.read', kind: 'read_only',
        params: [{ name: 'issue_key', required: true, maxLength: 100 }],
        build: function (p, cred) {
          if (!/^[A-Za-z0-9]+-[0-9]+$/.test(p.issue_key)) return { error: 'param_invalid' };
          const c = this.credentialPayload(cred);
          if (!c) return { error: 'credential_invalid' };
          return { method: 'GET', url: c.host + '/rest/api/3/issue/' + encodeURIComponent(p.issue_key) + '?fields=summary,status,issuetype,assignee,created,updated', headers: this.buildHeaders(c), body: null };
        } },
      { id: 'search_issues', label: 'Search Jira issues with a JQL query', scope: 'issues.read', kind: 'read_only',
        params: [{ name: 'jql', required: true, maxLength: 500 }],
        build: function (p, cred) {
          if (!/^[ -~]+$/.test(p.jql)) return { error: 'param_invalid' };
          const c = this.credentialPayload(cred);
          if (!c) return { error: 'credential_invalid' };
          return { method: 'GET', url: c.host + '/rest/api/3/search?jql=' + encodeURIComponent(p.jql) + '&maxResults=20', headers: this.buildHeaders(c), body: null };
        } },
    ],
  };

  ADAPTERS.gitlab = {
    id: 'gitlab', name: 'GitLab', authShape: 'token', setupRequired: false,
    setupNote: 'paste your own GitLab personal access token with the read_api scope (create it at gitlab.com under user settings, personal access tokens); the token is stored only in the app vault, never requested or shown in chat; this build talks to gitlab.com only, not a self-hosted instance',
    buildHeaders: function (token) { return { Authorization: 'Bearer ' + token, Accept: 'application/json', 'User-Agent': 'CompanionDesk' }; },
    actions: [
      { id: 'search_projects', label: 'Search public and permitted GitLab projects', scope: 'read_api', kind: 'read_only',
        params: [{ name: 'query', required: true, maxLength: 200 }],
        build: function (p, token) {
          if (!/^[A-Za-z0-9_ .,'-]+$/.test(p.query)) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://gitlab.com/api/v4/projects?search=' + encodeURIComponent(p.query) + '&per_page=20', headers: this.buildHeaders(token), body: null };
        } },
      { id: 'get_project', label: 'Read one GitLab project by id or namespace/project path', scope: 'read_api', kind: 'read_only',
        params: [{ name: 'project', required: true, maxLength: 200 }],
        build: function (p, token) {
          if (!/^[A-Za-z0-9_./-]+$/.test(p.project) || p.project.indexOf('..') !== -1) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://gitlab.com/api/v4/projects/' + encodeURIComponent(p.project), headers: this.buildHeaders(token), body: null };
        } },
      { id: 'list_recent_commits', label: 'List the recent commits of one GitLab project', scope: 'read_api', kind: 'read_only',
        params: [{ name: 'project', required: true, maxLength: 200 }],
        build: function (p, token) {
          if (!/^[A-Za-z0-9_./-]+$/.test(p.project) || p.project.indexOf('..') !== -1) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://gitlab.com/api/v4/projects/' + encodeURIComponent(p.project) + '/repository/commits?per_page=20', headers: this.buildHeaders(token), body: null };
        } },
    ],
  };

  ADAPTERS['brave-search'] = {
    id: 'brave-search', name: 'Brave Search', authShape: 'token', setupRequired: false,
    setupNote: 'paste your own API key from brave.com/search/api; the free tier has a monthly query allowance; your key is stored only in the app vault, never requested or shown in chat',
    buildHeaders: function (token) { return { 'X-Subscription-Token': token, Accept: 'application/json', 'User-Agent': 'CompanionDesk' }; },
    actions: [
      { id: 'web_search', label: 'Search the web with Brave', scope: 'search.read', kind: 'read_only',
        params: [{ name: 'query', required: true, maxLength: 200 }, { name: 'count', required: false, maxLength: 2 }],
        build: function (p, token) {
          const count = optionalInt(p, 'count', 10);
          if (count === null || count < 1 || count > 20) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://api.search.brave.com/res/v1/web/search?q=' + encodeURIComponent(p.query) + '&count=' + count, headers: this.buildHeaders(token), body: null };
        } },
    ],
  };

  ADAPTERS.tavily = {
    id: 'tavily', name: 'Tavily', authShape: 'token', setupRequired: false,
    setupNote: 'paste your own API key from app.tavily.com; the free tier includes a monthly credit allowance; your key is stored only in the app vault, never requested or shown in chat',
    buildHeaders: function (token) { return { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'User-Agent': 'CompanionDesk' }; },
    actions: [
      { id: 'web_search', label: 'Search the web with Tavily', scope: 'search.read', kind: 'read_only',
        params: [{ name: 'query', required: true, maxLength: 200 }, { name: 'max_results', required: false, maxLength: 2 }],
        build: function (p, token) {
          const maxResults = optionalInt(p, 'max_results', 5);
          if (maxResults === null || maxResults < 1 || maxResults > 20) return { error: 'param_invalid' };
          return { method: 'POST', url: 'https://api.tavily.com/search', headers: this.buildHeaders(token), body: JSON.stringify({ query: p.query, max_results: maxResults }) };
        } },
    ],
  };

  ADAPTERS['google-gemini'] = {
    id: 'google-gemini', name: 'Google Gemini', authShape: 'url_token', setupRequired: false,
    setupNote: 'paste your own API key from aistudio.google.com; the free tier has request limits',
    actions: [
      { id: 'list_models', label: 'List models the key can use', scope: 'models.read', kind: 'read_only',
        params: [],
        build: function (p, token) {
          return { method: 'GET', url: 'https://generativelanguage.googleapis.com/v1beta/models?key=' + encodeURIComponent(token), headers: {}, body: null };
        } },
      { id: 'generate', label: 'Generate content from a prompt', scope: 'completions.send', kind: 'send',
        params: [{ name: 'model', required: true, maxLength: 80 }, { name: 'text', required: true, maxLength: MAX_PARAM_CHARS }],
        build: function (p, token) {
          return { method: 'POST', url: 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(p.model) + ':generateContent?key=' + encodeURIComponent(token), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: p.text }] }] }) };
        } },
    ],
  };

  // ---- OAuth2 providers: the user creates their own client ------------
  function googleOauth(scope) {
    return {
      scope: scope,
      authorizeUrl: function (cfg, state) {
        return 'https://accounts.google.com/o/oauth2/v2/auth?response_type=code' +
          '&client_id=' + encodeURIComponent(cfg.client_id) +
          '&redirect_uri=' + encodeURIComponent(cfg.redirect_uri) +
          '&scope=' + encodeURIComponent(scope) +
          '&access_type=offline&prompt=consent' +
          '&state=' + encodeURIComponent(state || '');
      },
      tokenRequest: function (cfg, code) {
        return { method: 'POST', url: 'https://oauth2.googleapis.com/token', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'code=' + encodeURIComponent(code) + '&client_id=' + encodeURIComponent(cfg.client_id) + '&client_secret=' + encodeURIComponent(cfg.client_secret) + '&redirect_uri=' + encodeURIComponent(cfg.redirect_uri) + '&grant_type=authorization_code' };
      },
      refreshRequest: function (cfg, refreshToken) {
        return { method: 'POST', url: 'https://oauth2.googleapis.com/token', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'refresh_token=' + encodeURIComponent(refreshToken) + '&client_id=' + encodeURIComponent(cfg.client_id) + '&client_secret=' + encodeURIComponent(cfg.client_secret) + '&grant_type=refresh_token' };
      },
    };
  }

  function microsoftOauth(scope) {
    return {
      scope: scope,
      authorizeUrl: function (cfg, state) {
        return 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?response_type=code' +
          '&client_id=' + encodeURIComponent(cfg.client_id) +
          '&redirect_uri=' + encodeURIComponent(cfg.redirect_uri) +
          '&scope=' + encodeURIComponent(scope) +
          '&response_mode=query' +
          '&state=' + encodeURIComponent(state || '');
      },
      tokenRequest: function (cfg, code) {
        return { method: 'POST', url: 'https://login.microsoftonline.com/common/oauth2/v2.0/token', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'code=' + encodeURIComponent(code) + '&client_id=' + encodeURIComponent(cfg.client_id) + '&client_secret=' + encodeURIComponent(cfg.client_secret) + '&redirect_uri=' + encodeURIComponent(cfg.redirect_uri) + '&grant_type=authorization_code' };
      },
      refreshRequest: function (cfg, refreshToken) {
        return { method: 'POST', url: 'https://login.microsoftonline.com/common/oauth2/v2.0/token', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'refresh_token=' + encodeURIComponent(refreshToken) + '&client_id=' + encodeURIComponent(cfg.client_id) + '&client_secret=' + encodeURIComponent(cfg.client_secret) + '&grant_type=refresh_token' };
      },
    };
  }

  function oauthActions(list) { return list; }

  ADAPTERS['google-docs'] = {
    id: 'google-docs', name: 'Google Docs', authShape: 'oauth_json', setupRequired: true,
    setupNote: 'create your own OAuth client in Google Cloud Console (Docs API enabled) and complete the in-app sign-in; no shared client exists; consent requests only the read-only documents scope',
    oauth: googleOauth('https://www.googleapis.com/auth/documents.readonly'),
    buildHeaders: function (blob) { return bearerHeader(blob.access_token); },
    actions: oauthActions([
      { id: 'get_document_content', label: 'Read one Google Docs document by id', scope: 'documents.read', kind: 'read_only',
        params: [{ name: 'document_id', required: true, maxLength: 120 }],
        build: function (p, blob) {
          if (!/^[A-Za-z0-9_-]+$/.test(p.document_id)) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://docs.googleapis.com/v1/documents/' + encodeURIComponent(p.document_id) + '?fields=documentId,title,body', headers: this.buildHeaders(blob), body: null };
        } },
    ]),
  };

  ADAPTERS['google-sheets'] = {
    id: 'google-sheets', name: 'Google Sheets', authShape: 'oauth_json', setupRequired: true,
    setupNote: 'create your own OAuth client in Google Cloud Console (Sheets API enabled) and complete the in-app sign-in; no shared client exists; consent requests only the read-only spreadsheets scope',
    oauth: googleOauth('https://www.googleapis.com/auth/spreadsheets.readonly'),
    buildHeaders: function (blob) { return bearerHeader(blob.access_token); },
    actions: oauthActions([
      { id: 'get_values', label: 'Read cell values from one Google Sheets range', scope: 'spreadsheets.read', kind: 'read_only',
        params: [{ name: 'spreadsheet_id', required: true, maxLength: 120 }, { name: 'range', required: true, maxLength: 200 }],
        build: function (p, blob) {
          if (!/^[A-Za-z0-9_-]+$/.test(p.spreadsheet_id)) return { error: 'param_invalid' };
          if (!/^[A-Za-z0-9_ '!:.$,-]+$/.test(p.range)) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent(p.spreadsheet_id) + '/values/' + encodeURIComponent(p.range) + '?majorDimension=ROWS', headers: this.buildHeaders(blob), body: null };
        } },
    ]),
  };

  ADAPTERS['google-drive'] = {
    id: 'google-drive', name: 'Google Drive', authShape: 'oauth_json', setupRequired: true,
    setupNote: 'create your own OAuth client in Google Cloud Console (Drive API enabled) and complete the in-app sign-in; no shared client exists',
    oauth: googleOauth('https://www.googleapis.com/auth/drive'),
    buildHeaders: function (blob) { return bearerHeader(blob.access_token); },
    actions: oauthActions([
      { id: 'list_files', label: 'List the most recently modified files', scope: 'files.read', kind: 'read_only',
        params: [{ name: 'query', required: false, maxLength: 500 }],
        build: function (p, blob) {
          let url = 'https://www.googleapis.com/drive/v3/files?pageSize=20&fields=files(id,name,mimeType,modifiedTime)&orderBy=modifiedTime desc';
          if (p.query) url += '&q=' + encodeURIComponent(p.query);
          return { method: 'GET', url: url, headers: this.buildHeaders(blob), body: null };
        } },
      { id: 'get_file_meta', label: 'Read one file by id', scope: 'files.read', kind: 'read_only',
        params: [{ name: 'file_id', required: true, maxLength: 120 }],
        build: function (p, blob) {
          return { method: 'GET', url: 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(p.file_id) + '?fields=id,name,mimeType,size,modifiedTime', headers: this.buildHeaders(blob), body: null };
        } },
      { id: 'create_file', label: 'Create a small text file in Drive', scope: 'files.write', kind: 'write',
        params: [{ name: 'name', required: true, maxLength: 200 }, { name: 'content', required: true, maxLength: 20000 }],
        build: function (p, blob) {
          const boundary = 'companiondesk' + Math.random().toString(36).slice(2, 12);
          const body = '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify({ name: p.name, mimeType: 'text/plain' }) + '\r\n--' + boundary + '\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n' + p.content + '\r\n--' + boundary + '--\r\n';
          return { method: 'POST', url: 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,size', headers: Object.assign(this.buildHeaders(blob), { 'Content-Type': 'multipart/related; boundary=' + boundary }), body: body };
        } },
    ]),
  };

  ADAPTERS.gmail = {
    id: 'gmail', name: 'Gmail', authShape: 'oauth_json', setupRequired: true,
    setupNote: 'create your own OAuth client in Google Cloud Console (Gmail API enabled) and complete the in-app sign-in; no shared client exists',
    oauth: googleOauth('https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send'),
    buildHeaders: function (blob) { return bearerHeader(blob.access_token); },
    actions: oauthActions([
      { id: 'list_messages', label: 'List the newest messages', scope: 'mail.read', kind: 'read_only',
        params: [{ name: 'max_results', required: false, maxLength: 3 }],
        build: function (p, blob) {
          const n = optionalInt(p, 'max_results', 10);
          if (n === null) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=' + n, headers: this.buildHeaders(blob), body: null };
        } },
      { id: 'search_messages', label: 'Search messages with a Gmail query', scope: 'mail.read', kind: 'read_only',
        params: [{ name: 'query', required: true, maxLength: 300 }],
        build: function (p, blob) {
          return { method: 'GET', url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages?q=' + encodeURIComponent(p.query), headers: this.buildHeaders(blob), body: null };
        } },
      { id: 'send_message', label: 'Send an email from the connected account', scope: 'mail.send', kind: 'send',
        params: [{ name: 'to', required: true, maxLength: 320 }, { name: 'subject', required: true, maxLength: 200 }, { name: 'text', required: true, maxLength: 8000 }],
        build: function (p, blob) {
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.to)) return { error: 'param_invalid' };
          const subject = p.subject.replace(/[\r\n]+/g, ' ');
          const mime = 'To: ' + p.to + '\r\nSubject: ' + subject + '\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n' + p.text;
          const b64 = Buffer.from(mime, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
          return { method: 'POST', url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send', headers: this.buildHeaders(blob), body: JSON.stringify({ raw: b64 }) };
        } },
    ]),
  };

  ADAPTERS['google-calendar'] = {
    id: 'google-calendar', name: 'Google Calendar', authShape: 'oauth_json', setupRequired: true,
    setupNote: 'create your own OAuth client in Google Cloud Console (Calendar API enabled) and complete the in-app sign-in; no shared client exists',
    oauth: googleOauth('https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events'),
    buildHeaders: function (blob) { return bearerHeader(blob.access_token); },
    actions: oauthActions([
      { id: 'list_events', label: 'List upcoming events on the primary calendar', scope: 'events.read', kind: 'read_only',
        params: [{ name: 'days_ahead', required: false, maxLength: 3 }],
        build: function (p, blob) {
          const days = optionalInt(p, 'days_ahead', 7);
          if (days === null) return { error: 'param_invalid' };
          const timeMin = new Date().toISOString();
          const timeMax = new Date(Date.now() + days * 86400000).toISOString();
          return { method: 'GET', url: 'https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=20&singleEvents=true&orderBy=startTime&timeMin=' + encodeURIComponent(timeMin) + '&timeMax=' + encodeURIComponent(timeMax), headers: this.buildHeaders(blob), body: null };
        } },
      { id: 'get_event', label: 'Read one event by id', scope: 'events.read', kind: 'read_only',
        params: [{ name: 'event_id', required: true, maxLength: 120 }],
        build: function (p, blob) {
          return { method: 'GET', url: 'https://www.googleapis.com/calendar/v3/calendars/primary/events/' + encodeURIComponent(p.event_id), headers: this.buildHeaders(blob), body: null };
        } },
      { id: 'create_event', label: 'Create an event on the primary calendar', scope: 'events.write', kind: 'write',
        params: [{ name: 'summary', required: true, maxLength: 200 }, { name: 'start', required: true, maxLength: 40 }, { name: 'end', required: true, maxLength: 40 }],
        build: function (p, blob) {
          if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(p.start) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(p.end)) return { error: 'param_invalid' };
          return { method: 'POST', url: 'https://www.googleapis.com/calendar/v3/calendars/primary/events', headers: this.buildHeaders(blob), body: JSON.stringify({ summary: p.summary, start: { dateTime: p.start }, end: { dateTime: p.end } }) };
        } },
    ]),
  };

  ADAPTERS['microsoft-excel'] = {
    id: 'microsoft-excel', name: 'Microsoft Excel', authShape: 'oauth_json', setupRequired: true,
    setupNote: 'register your own app in the Azure portal (Microsoft Graph) and complete the in-app sign-in; no shared client exists; consent requests only the read-only Files.Read Microsoft scope',
    oauth: microsoftOauth('Files.Read offline_access'),
    buildHeaders: function (blob) { return bearerHeader(blob.access_token); },
    actions: oauthActions([
      { id: 'get_workbook_range', label: 'Read one Excel workbook range by worksheet and address', scope: 'workbook.read', kind: 'read_only',
        params: [{ name: 'workbook_item_id', required: true, maxLength: 200 }, { name: 'worksheet', required: true, maxLength: 100 }, { name: 'range', required: true, maxLength: 200 }],
        build: function (p, blob) {
          if (!/^[A-Za-z0-9_.!-]+$/.test(p.workbook_item_id)) return { error: 'param_invalid' };
          if (!/^[A-Za-z0-9_ .-]+$/.test(p.worksheet)) return { error: 'param_invalid' };
          if (!/^[A-Za-z0-9_ '!:.$,-]+$/.test(p.range)) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://graph.microsoft.com/v1.0/me/drive/items/' + encodeURIComponent(p.workbook_item_id) + '/workbook/worksheets/' + encodeURIComponent(p.worksheet) + "/range(address='" + encodeURIComponent(p.range) + "')", headers: this.buildHeaders(blob), body: null };
        } },
    ]),
  };

  ADAPTERS['microsoft-word'] = {
    id: 'microsoft-word', name: 'Microsoft Word', authShape: 'oauth_json', setupRequired: true,
    setupNote: 'register your own app in the Azure portal (Microsoft Graph) and complete the in-app sign-in; no shared client exists; consent requests only the read-only Files.Read Microsoft scope',
    oauth: microsoftOauth('Files.Read offline_access'),
    buildHeaders: function (blob) { return bearerHeader(blob.access_token); },
    actions: oauthActions([
      { id: 'get_document_properties', label: 'Read one Word document item by id (metadata)', scope: 'documents.read', kind: 'read_only',
        params: [{ name: 'item_id', required: true, maxLength: 200 }],
        build: function (p, blob) {
          if (!/^[A-Za-z0-9_.!-]+$/.test(p.item_id)) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://graph.microsoft.com/v1.0/me/drive/items/' + encodeURIComponent(p.item_id) + '?select=id,name,size,lastModifiedDateTime,webUrl', headers: this.buildHeaders(blob), body: null };
        } },
    ]),
  };

  ADAPTERS['microsoft-teams'] = {
    id: 'microsoft-teams', name: 'Microsoft Teams', authShape: 'oauth_json', setupRequired: true,
    setupNote: 'register your own app in the Azure portal (Microsoft Graph) and complete the in-app sign-in; no shared client exists; consent requests only the read-only Chat.Read Microsoft scope (delegated; a tenant that blocks user consent needs its admin to approve the app once)',
    oauth: microsoftOauth('Chat.Read offline_access'),
    buildHeaders: function (blob) { return bearerHeader(blob.access_token); },
    actions: oauthActions([
      { id: 'list_chats', label: 'List your recent Teams chats', scope: 'chat.read', kind: 'read_only',
        params: [],
        build: function (p, blob) {
          return { method: 'GET', url: 'https://graph.microsoft.com/v1.0/chats?$top=20', headers: this.buildHeaders(blob), body: null };
        } },
      { id: 'get_chat_messages', label: 'Read the recent messages of one Teams chat', scope: 'chat.read', kind: 'read_only',
        params: [{ name: 'chat_id', required: true, maxLength: 300 }],
        build: function (p, blob) {
          if (!/^[A-Za-z0-9:@._-]+$/.test(p.chat_id)) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://graph.microsoft.com/v1.0/chats/' + encodeURIComponent(p.chat_id) + '/messages?$top=20', headers: this.buildHeaders(blob), body: null };
        } },
    ]),
  };

  ADAPTERS['microsoft-onedrive'] = {
    id: 'microsoft-onedrive', name: 'Microsoft OneDrive', authShape: 'oauth_json', setupRequired: true,
    setupNote: 'register your own app in the Azure portal (Microsoft Graph, delegated Files.ReadWrite) and complete the in-app sign-in; no shared client exists',
    oauth: microsoftOauth('Files.ReadWrite offline_access'),
    buildHeaders: function (blob) { return bearerHeader(blob.access_token); },
    actions: oauthActions([
      { id: 'list_files', label: 'List files at the OneDrive root', scope: 'files.read', kind: 'read_only',
        params: [],
        build: function (p, blob) {
          return { method: 'GET', url: 'https://graph.microsoft.com/v1.0/me/drive/root/children?$top=20', headers: this.buildHeaders(blob), body: null };
        } },
      { id: 'get_file_meta', label: 'Read one item by id', scope: 'files.read', kind: 'read_only',
        params: [{ name: 'item_id', required: true, maxLength: 180 }],
        build: function (p, blob) {
          return { method: 'GET', url: 'https://graph.microsoft.com/v1.0/me/drive/items/' + encodeURIComponent(p.item_id) + '?select=id,name,size,lastModifiedDateTime', headers: this.buildHeaders(blob), body: null };
        } },
      { id: 'create_file', label: 'Create a small text file at the OneDrive root', scope: 'files.write', kind: 'write',
        params: [{ name: 'name', required: true, maxLength: 200 }, { name: 'content', required: true, maxLength: 20000 }],
        build: function (p, blob) {
          return { method: 'PUT', url: 'https://graph.microsoft.com/v1.0/me/drive/root:/' + encodeURIComponent(p.name) + ':/content', headers: Object.assign(this.buildHeaders(blob), { 'Content-Type': 'text/plain; charset=UTF-8' }), body: p.content };
        } },
    ]),
  };

  ADAPTERS['microsoft-outlook'] = {
    id: 'microsoft-outlook', name: 'Microsoft Outlook', authShape: 'oauth_json', setupRequired: true,
    setupNote: 'register your own app in the Azure portal (Microsoft Graph, delegated Mail.Read and Mail.Send) and complete the in-app sign-in; no shared client exists',
    oauth: microsoftOauth('Mail.Read Mail.Send offline_access'),
    buildHeaders: function (blob) { return bearerHeader(blob.access_token); },
    actions: oauthActions([
      { id: 'list_messages', label: 'List the newest messages', scope: 'mail.read', kind: 'read_only',
        params: [{ name: 'max_results', required: false, maxLength: 3 }],
        build: function (p, blob) {
          const n = optionalInt(p, 'max_results', 10);
          if (n === null) return { error: 'param_invalid' };
          return { method: 'GET', url: 'https://graph.microsoft.com/v1.0/me/messages?$top=' + n + '&$select=subject,from,receivedDateTime', headers: this.buildHeaders(blob), body: null };
        } },
      { id: 'search_messages', label: 'Search messages with a Graph $search query', scope: 'mail.read', kind: 'read_only',
        params: [{ name: 'query', required: true, maxLength: 300 }],
        build: function (p, blob) {
          return { method: 'GET', url: 'https://graph.microsoft.com/v1.0/me/messages?$search=' + encodeURIComponent('"' + p.query + '"') + '&$top=20&$select=subject,from,receivedDateTime', headers: this.buildHeaders(blob), body: null };
        } },
      { id: 'send_message', label: 'Send an email from the connected account', scope: 'mail.send', kind: 'send',
        params: [{ name: 'to', required: true, maxLength: 320 }, { name: 'subject', required: true, maxLength: 200 }, { name: 'text', required: true, maxLength: 8000 }],
        build: function (p, blob) {
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.to)) return { error: 'param_invalid' };
          const subject = p.subject.replace(/[\r\n]+/g, ' ');
          return { method: 'POST', url: 'https://graph.microsoft.com/v1.0/me/sendMail', headers: this.buildHeaders(blob), body: JSON.stringify({ message: { subject: subject, body: { contentType: 'Text', content: p.text }, toRecipients: [{ emailAddress: { address: p.to } }] } }) };
        } },
    ]),
  };

  ADAPTERS['microsoft-calendar'] = {
    id: 'microsoft-calendar', name: 'Microsoft Calendar', provider: 'Microsoft', category: 'calendar',
    authShape: 'oauth_json', setupRequired: true,
    setupNote: 'register your own app in the Azure portal (Microsoft Graph, delegated Calendars.Read and Calendars.ReadWrite) and complete the in-app sign-in; no shared client exists',
    oauth: microsoftOauth('Calendars.Read Calendars.ReadWrite offline_access'),
    buildHeaders: function (blob) { return bearerHeader(blob.access_token); },
    actions: oauthActions([
      { id: 'list_events', label: 'List upcoming events on the default calendar', scope: 'events.read', kind: 'read_only',
        params: [{ name: 'days_ahead', required: false, maxLength: 3 }],
        build: function (p, blob) {
          const days = optionalInt(p, 'days_ahead', 7);
          if (days === null) return { error: 'param_invalid' };
          const start = new Date().toISOString();
          const end = new Date(Date.now() + days * 86400000).toISOString();
          return { method: 'GET', url: 'https://graph.microsoft.com/v1.0/me/calendarview?startDateTime=' + encodeURIComponent(start) + '&endDateTime=' + encodeURIComponent(end) + '&$top=20', headers: this.buildHeaders(blob), body: null };
        } },
      { id: 'get_event', label: 'Read one event by id', scope: 'events.read', kind: 'read_only',
        params: [{ name: 'event_id', required: true, maxLength: 120 }],
        build: function (p, blob) {
          return { method: 'GET', url: 'https://graph.microsoft.com/v1.0/me/events/' + encodeURIComponent(p.event_id), headers: this.buildHeaders(blob), body: null };
        } },
      { id: 'create_event', label: 'Create an event on the default calendar', scope: 'events.write', kind: 'write',
        params: [{ name: 'subject', required: true, maxLength: 200 }, { name: 'start', required: true, maxLength: 40 }, { name: 'end', required: true, maxLength: 40 }],
        build: function (p, blob) {
          if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(p.start) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(p.end)) return { error: 'param_invalid' };
          return { method: 'POST', url: 'https://graph.microsoft.com/v1.0/me/events', headers: this.buildHeaders(blob), body: JSON.stringify({ subject: p.subject, start: { dateTime: p.start, timeZone: 'UTC' }, end: { dateTime: p.end, timeZone: 'UTC' } }) };
        } },
    ]),
  };

  // ---- registry API ----------------------------------------------------
  function get(id) {
    const a = ADAPTERS[id];
    return a || null;
  }

  function listActions(id) {
    const a = get(id);
    return a ? a.actions.map(function (x) {
      return { id: x.id, label: x.label, scope: x.scope, kind: x.kind,
        params: (x.params || []).map(function (q) { return { name: q.name, required: !!q.required }; }) };
    }) : null;
  }

  // Params-only check (batch 3, 27 Nov 2026): lets the engine refuse a bad
  // parameter set BEFORE any approval is consumed. Same rules as the check
  // inside buildRequest, no credential parsing, no request building.
  function validateOnly(id, actionId, params) {
    const a = get(id);
    if (!a) return 'no_adapter';
    const action = a.actions.find(function (x) { return x.id === actionId; });
    if (!action) return 'unknown_action';
    return validateParams(action, params);
  }

  function buildRequest(id, actionId, params, credential) {
    const a = get(id);
    if (!a) return fail('no_adapter');
    const action = a.actions.find(function (x) { return x.id === actionId; });
    if (!action) return fail('unknown_action');
    const bad = validateParams(action, params);
    if (bad) return fail(bad);
    let cred;
    if (a.authShape === 'public') {
      cred = { ok: true };
    } else if (a.authShape === 'oauth_json') {
      cred = parseOauthCredential(credential);
      if (!cred.ok) return cred;
    } else {
      cred = parseTokenCredential(credential);
      if (!cred.ok) return cred;
    }
    let req;
    if (a.authShape === 'oauth_json') req = action.build.call(a, params || {}, cred.blob);
    else if (a.authShape === 'public') req = action.build.call(a, params || {});
    else req = action.build.call(a, params || {}, cred.token);
    if (!req || req.error) return fail((req && req.error) || 'request_build_failed');
    if (!/^https:\/\//.test(req.url)) return fail('url_invalid');
    if (req.method !== 'GET' && req.method !== 'POST' && req.method !== 'PUT') return fail('request_build_failed');
    return { ok: true, request: { method: req.method, url: req.url, headers: req.headers || {}, body: req.body || null, urlContainsSecret: a.authShape === 'url_token' } };
  }

  function authorizeUrl(id, cfg, state) {
    const a = get(id);
    if (!a || !a.oauth) return fail('no_oauth');
    if (!isPlainObject(cfg) || typeof cfg.client_id !== 'string' || !cfg.client_id) return fail('client_config_invalid');
    if (typeof cfg.redirect_uri !== 'string' || !validRedirect(cfg.redirect_uri)) return fail('redirect_uri_invalid');
    return { ok: true, url: a.oauth.authorizeUrl(cfg, typeof state === 'string' ? state.slice(0, 120) : '') };
  }

  function tokenRequest(id, cfg, code) {
    const a = get(id);
    if (!a || !a.oauth) return fail('no_oauth');
    if (!isPlainObject(cfg) || typeof cfg.client_id !== 'string' || !cfg.client_id) return fail('client_config_invalid');
    if (typeof cfg.client_secret !== 'string' || !cfg.client_secret) return fail('client_config_invalid');
    if (typeof cfg.redirect_uri !== 'string' || !validRedirect(cfg.redirect_uri)) return fail('redirect_uri_invalid');
    if (typeof code !== 'string' || !code || code.length > 512 || CONTROL_RE.test(code)) return fail('code_invalid');
    return { ok: true, request: a.oauth.tokenRequest(cfg, code) };
  }

  function refreshRequest(id, cfg, refreshToken) {
    const a = get(id);
    if (!a || !a.oauth) return fail('no_oauth');
    if (!isPlainObject(cfg) || typeof cfg.client_id !== 'string' || !cfg.client_id) return fail('client_config_invalid');
    if (typeof cfg.client_secret !== 'string' || !cfg.client_secret) return fail('client_config_invalid');
    if (typeof refreshToken !== 'string' || !refreshToken || refreshToken.length > 2048) return fail('credential_invalid');
    return { ok: true, request: a.oauth.refreshRequest(cfg, refreshToken) };
  }

  function validRedirect(u) {
    if (typeof u !== 'string' || u.length === 0 || u.length > 500) return false;
    if (CONTROL_RE.test(u) || u.indexOf('@') !== -1 || u.indexOf('?') !== -1) return false;
    let parsed = null;
    try { parsed = new URL(u); } catch (e) { return false; }
    if (parsed.protocol === 'https:') return true;
    if (parsed.protocol === 'http:') {
      return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
    }
    return false;
  }

  return {
    ADAPTER_IDS: Object.keys(ADAPTERS).sort(),
    get: get,
    listActions: listActions,
    buildRequest: buildRequest,
    validateOnly: validateOnly,
    authorizeUrl: authorizeUrl,
    tokenRequest: tokenRequest,
    refreshRequest: refreshRequest,
    parseOauthCredential: parseOauthCredential,
  };
});
