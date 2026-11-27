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
