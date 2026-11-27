'use strict';
// Workspace panel (Gate 3 slice, approved by Ninad on 26 Nov 2026): the
// Workspace surface over the workspace-views catalog. The panel renders
// the view picker, fetches each wired view's owning rows through the
// companiondesk bridge, shapes them with the pure shaper
// (CompanionWorkspaceViews), and renders them as textContent-only lines.
// The connector settings section (Gate 2 follow-on, same approval) lists
// the catalog with cost and limits visible BEFORE activation; connecting,
// disconnecting, revoking and readmitting happen only from an explicit
// click, and every refusal is surfaced verbatim. No auto-connect: nothing
// activates on load. Missing bridge, missing shaper or a failing fetch
// degrades to an honest status line, never a crash and never an invented
// row. Unwired views say so instead of guessing. This module does not
// touch any closed file.
(function () {
  const METHODS = [
    'workspace_rows',
    'workspace_connectors',
    'workspace_connector_connect',
    'workspace_connector_disconnect',
    'workspace_connector_readmit',
    'workspace_connector_revoke',
  ];

  function api(preferred) {
    let a = preferred;
    if (a === undefined) a = typeof window !== 'undefined' ? window.companiondesk : null;
    if (!a || typeof a !== 'object') return null;
    for (const m of METHODS) {
      if (typeof a[m] !== 'function') return null;
    }
    return a;
  }

  function shaper() {
    return (typeof window !== 'undefined' && window.CompanionWorkspaceViews) || null;
  }

  function el(tag) {
    return document.createElement(tag);
  }

  function line(text) {
    const d = el('div');
    d.textContent = text;
    return d;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  let statusEl = null;

  function say(text) {
    if (statusEl) statusEl.textContent = text;
  }

  function passwordField(placeholder) {
    const i = el('input');
    i.type = 'password';
    i.setAttribute('placeholder', placeholder);
    i.setAttribute('autocomplete', 'off');
    return i;
  }

  function button(label, ariaLabel, onClick) {
    const b = el('button');
    b.type = 'button';
    b.textContent = label;
    if (ariaLabel) b.setAttribute('aria-label', ariaLabel);
    b.addEventListener('click', () => {
      if (b.disabled) return;
      b.disabled = true;
      Promise.resolve()
        .then(onClick)
        .catch(() => say('workspace: unavailable right now'))
        .then(() => { b.disabled = false; });
    });
    return b;
  }

  function mount(opts) {
    const sel = document.getElementById('ws-view');
    const refreshBtn = document.getElementById('ws-refresh');
    statusEl = document.getElementById('ws-status');
    const rowsEl = document.getElementById('ws-rows');
    const connEl = document.getElementById('ws-connectors');
    if (!sel || !refreshBtn || !statusEl || !rowsEl || !connEl) return null;
    const explicitApi = opts && opts.api !== undefined ? opts.api : undefined;
    const v = shaper();

    const catalog = v && typeof v.catalog === 'function' ? v.catalog() : null;
    if (!Array.isArray(catalog) || catalog.length === 0) {
      say('workspace: unavailable right now');
      return { refresh: () => {} };
    }
    clear(sel);
    for (const entry of catalog) {
      const o = el('option');
      o.value = entry.name;
      o.textContent = entry.label;
      sel.appendChild(o);
    }
    const wanted = opts && opts.initialView ? opts.initialView : catalog[0].name;
    sel.value = catalog.some((c) => c.name === wanted) ? wanted : catalog[0].name;

    let busy = false;

    async function renderConnectors(a) {
      clear(connEl);
      let list;
      try {
        list = await a.workspace_connectors();
      } catch {
        connEl.appendChild(line('workspace: connector catalog unavailable'));
        return;
      }
      if (!Array.isArray(list) || list.length === 0) {
        connEl.appendChild(line('workspace: no connectors in the catalog'));
        return;
      }
      const connectedCount = list.filter((e) => e && e.state === 'connected').length;
      connEl.appendChild(line('connector catalog: ' + list.length + ' listed, ' + connectedCount + ' connected; connecting is always your explicit pick per connector'));
      // Gate 2 AI-access connector flow (27 Nov 2026): the AI's connect
      // requests render here. Approving is an explicit user click and it
      // runs the SAME connect gate as the user's own pick; dismissing just
      // resolves the request. The optional methods degrade gracefully: a
      // bridge without them still renders the catalog.
      const canRequests = typeof a.workspace_connectorRequests === 'function' && typeof a.workspace_connectorRequestResolve === 'function';
      if (canRequests) {
        let reqs;
        try {
          reqs = await a.workspace_connectorRequests();
        } catch {
          reqs = [];
        }
        const open = (Array.isArray(reqs) ? reqs : []).filter((r) => r && (r.status === 'pending' || r.status === 'approved'));
        if (open.length) {
          connEl.appendChild(line('AI connect requests: ' + open.length + ' open; approving is your explicit click and it runs the same connect gate as your own pick'));
          for (const r of open) {
            const entry = list.find((e) => e && e.id === r.connectorId);
            const name = (entry && entry.name) || r.connectorId;
            connEl.appendChild(line('AI request for ' + name + ' - ' + (r.reason || '') + ' - status: ' + r.status));
            if (r.status === 'pending') {
              connEl.appendChild(button('Approve request for ' + name, 'Approve request for ' + name, async () => {
                const res = await a.workspace_connectorRequestResolve(r.id, 'approved');
                if (res && res.ok) {
                  const scopes = ((entry && Array.isArray(entry.scopes) ? entry.scopes : []) || []).map((s) => s.name);
                  const cr = await a.workspace_connector_connect(r.connectorId, scopes);
                  say(cr && cr.ok ? 'workspace: connector connected (AI request approved)' : 'workspace: connect refused: ' + ((cr && cr.reason) || 'unknown'));
                } else {
                  say('workspace: approval refused: ' + ((res && res.reason) || 'unknown'));
                }
                await renderConnectors(a);
              }));
              connEl.appendChild(button('Dismiss request for ' + name, 'Dismiss request for ' + name, async () => {
                const res = await a.workspace_connectorRequestResolve(r.id, 'dismissed');
                say(res && res.ok ? 'workspace: request dismissed' : 'workspace: dismiss refused: ' + ((res && res.reason) || 'unknown'));
                await renderConnectors(a);
              }));
            }
          }
        }
      }
      // Catalog search + category filter (27 Nov 2026 marketplace slice):
      // purely client-side. Filters hide rows; they never change a
      // connector's state and they never activate anything.
      const connFilter = { q: '', cat: 'all' };
      const searchInput = el('input');
      searchInput.type = 'search';
      searchInput.setAttribute('placeholder', 'search connectors');
      searchInput.setAttribute('aria-label', 'search connectors');
      connEl.appendChild(searchInput);
      const catSel = el('select');
      catSel.setAttribute('aria-label', 'filter connectors by category');
      const allOpt = el('option');
      allOpt.value = 'all';
      allOpt.textContent = 'all categories';
      catSel.appendChild(allOpt);
      for (const c of Array.from(new Set(list.map((x) => x && x.category).filter(Boolean))).sort()) {
        const o = el('option');
        o.value = c;
        o.textContent = c;
        catSel.appendChild(o);
      }
      connEl.appendChild(catSel);
      const rowWrappers = [];
      function applyConnFilter() {
        const q = connFilter.q.trim().toLowerCase();
        for (const w of rowWrappers) {
          const e = w.e || {};
          const hay = ((e.name || '') + ' ' + (e.id || '') + ' ' + (e.category || '')).toLowerCase();
          w.rowEl.hidden = (q && hay.indexOf(q) === -1) || (connFilter.cat !== 'all' && e.category !== connFilter.cat);
        }
      }
      searchInput.addEventListener('input', () => { connFilter.q = searchInput.value; applyConnFilter(); });
      catSel.addEventListener('change', () => { connFilter.cat = catSel.value; applyConnFilter(); });
      for (const e of list) {
        if (!e || typeof e !== 'object') continue;
        const rowEl = el('div');
        connEl.appendChild(rowEl);
        rowWrappers.push({ rowEl: rowEl, e: e });
        rowEl.appendChild(line((e.name || e.id) + ' - ' + (e.state || 'discovered') + ' - ' + (e.costNote || '') + ' - ' + (e.limits || '')));
        if (Array.isArray(e.scopes) && e.scopes.length) {
          rowEl.appendChild(line('scopes: ' + e.scopes.map((s) => s.name + ' (' + s.class + ')').join(', ')));
        }
        // Custom connectors (27 Nov 2026 marketplace slice): the honest
        // readiness label travels with every custom row. No custom
        // connector ever claims a working integration.
        if (e.custom) {
          rowEl.appendChild(line('custom connector: ' + (e.readinessNote || 'integration not implemented in this build')));
        } else if (e.readinessNote) {
          // Curated popular-provider tier (27 Nov 2026): mainstream services
          // are LISTED for discovery, never claimed to work; the honest
          // label travels with the row the same way it does for customs.
          rowEl.appendChild(line('integration not implemented: ' + e.readinessNote));
        }
        const state = e.state || 'discovered';
        const scopeNames = (Array.isArray(e.scopes) ? e.scopes : []).map((s) => s.name);
        if (state === 'discovered') {
          // Gate 2 credential step: a connect needs a stored credential.
          // Without one, this row shows a password field; the typed value
          // goes straight to main's OS credential vault and is never
          // rendered, logged or kept here. A row that already has one
          // connects with the plain button, no repeated prompt.
          if (e.hasCredential !== true) {
            const credInput = passwordField('credential for ' + (e.name || e.id));
            rowEl.appendChild(credInput);
            rowEl.appendChild(button('Connect ' + e.name, 'Connect ' + e.name, async () => {
              const secret = credInput.value;
              credInput.value = '';
              if (!secret) {
                say('workspace: enter a credential for ' + (e.name || e.id) + ' to connect');
                return;
              }
              const sr = typeof a.workspace_connectorCredentialSet === 'function'
                ? await a.workspace_connectorCredentialSet(e.id, secret)
                : null;
              if (sr && sr.ok !== true) {
                say('workspace: credential not saved: ' + ((sr && sr.reason) || 'unknown'));
                return;
              }
              const r = await a.workspace_connector_connect(e.id, scopeNames);
              say(r && r.ok ? 'workspace: connect requested for ' + e.name : 'workspace: connect refused: ' + ((r && r.reason) || 'unknown'));
              await renderConnectors(a);
            }));
          } else {
            rowEl.appendChild(button('Connect ' + e.name, 'Connect ' + e.name, async () => {
              const r = await a.workspace_connector_connect(e.id, scopeNames);
              say(r && r.ok ? 'workspace: connect requested for ' + e.name : 'workspace: connect refused: ' + ((r && r.reason) || 'unknown'));
              await renderConnectors(a);
            }));
          }
        } else if (state === 'connected') {
          rowEl.appendChild(button('Disconnect ' + e.name, 'Disconnect ' + e.name, async () => {
            const r = await a.workspace_connector_disconnect(e.id);
            say(r && r.ok ? 'workspace: connector disconnected' : 'workspace: disconnect refused: ' + ((r && r.reason) || 'unknown'));
            await renderConnectors(a);
          }));
          rowEl.appendChild(button('Revoke ' + e.name, 'Revoke ' + e.name, async () => {
            const r = await a.workspace_connector_revoke(e.id);
            say(r && r.ok ? 'workspace: connector revoked' : 'workspace: revoke refused: ' + ((r && r.reason) || 'unknown'));
            await renderConnectors(a);
          }));
        } else {
          rowEl.appendChild(button('Readmit ' + e.name, 'Readmit ' + e.name, async () => {
            const r = await a.workspace_connector_readmit(e.id);
            say(r && r.ok ? 'workspace: connector readmitted' : 'workspace: readmit refused: ' + ((r && r.reason) || 'unknown'));
            await renderConnectors(a);
          }));
        }
        if (e.custom && state !== 'connected') {
          rowEl.appendChild(button('Remove ' + (e.name || e.id), 'Remove custom connector ' + (e.name || e.id), async () => {
            if (typeof a.workspace_connectorCustomRemove !== 'function') { say('workspace: custom connectors unavailable in this build'); return; }
            const r = await a.workspace_connectorCustomRemove(e.id);
            say(r && r.ok ? 'workspace: custom connector removed' : 'workspace: remove refused: ' + ((r && r.reason) || 'unknown'));
            await renderConnectors(a);
          }));
        }
      }
      applyConnFilter();
      // Custom connector form (27 Nov 2026 marketplace slice): add a
      // connector for an app/website that is not in the built-in catalog.
      // Every field is explicit, the policy core validates and refuses
      // anything unsafe, and every refusal surfaces verbatim. Scopes use
      // the exact "name:class" form so a permission class is never guessed.
      connEl.appendChild(line('add a custom connector: the definition (and, for key/token types, the credential) is stored, but no integration actions are implemented for custom connectors in this build'));
      const fName = el('input');
      fName.setAttribute('placeholder', 'name, e.g. My Service');
      fName.setAttribute('aria-label', 'custom connector name');
      connEl.appendChild(fName);
      const fCat = el('input');
      fCat.setAttribute('placeholder', 'category (optional)');
      fCat.setAttribute('aria-label', 'custom connector category');
      connEl.appendChild(fCat);
      const fAuth = el('select');
      fAuth.setAttribute('aria-label', 'custom connector auth type');
      for (const t of ['api_key', 'access_token', 'oauth2', 'webhook', 'website']) {
        const o = el('option');
        o.value = t;
        o.textContent = t;
        fAuth.appendChild(o);
      }
      connEl.appendChild(fAuth);
      const fUrl = el('input');
      fUrl.setAttribute('placeholder', 'https:// URL (required for oauth2/webhook/website; http only for localhost)');
      fUrl.setAttribute('aria-label', 'custom connector URL');
      connEl.appendChild(fUrl);
      const fScopes = el('input');
      fScopes.setAttribute('placeholder', 'scopes as name:class, e.g. events.read:read_only, events.write:write');
      fScopes.setAttribute('aria-label', 'custom connector scopes');
      connEl.appendChild(fScopes);
      connEl.appendChild(button('Add custom connector', 'Add custom connector', async () => {
        if (typeof a.workspace_connectorCustomAdd !== 'function') { say('workspace: custom connectors unavailable in this build'); return; }
        const name = fName.value.trim();
        if (!name) { say('workspace: name your custom connector first'); return; }
        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        if (!slug) { say('workspace: name your custom connector first'); return; }
        const id = /^[a-z]/.test(slug) ? slug : 'c-' + slug;
        const scopeList = fScopes.value.split(',').map((s) => s.trim()).filter(Boolean);
        const r = await a.workspace_connectorCustomAdd({ id: id, name: name, category: fCat.value.trim() || undefined, authType: fAuth.value, url: fUrl.value.trim() || undefined, scopes: scopeList });
        if (r && r.ok) {
          say('workspace: custom connector added (definition only; no integration actions are implemented in this build)');
          fName.value = '';
          fCat.value = '';
          fUrl.value = '';
          fScopes.value = '';
        } else {
          say('workspace: custom connector refused: ' + ((r && r.reason) || 'unknown'));
        }
        await renderConnectors(a);
      }));
    }

    async function refresh() {
      if (busy) return;
      const a = api(explicitApi);
      if (!a || !v) {
        say('workspace: unavailable right now');
        clear(rowsEl);
        return;
      }
      busy = true;
      try {
        const name = sel.value;
        const entry = catalog.find((c) => c.name === name);
        clear(rowsEl);
        if (!entry || !entry.wired) {
          say('workspace: ' + (entry ? entry.label : name) + ' is not wired yet in this build');
          await renderConnectors(a);
          return;
        }
        let rows;
        try {
          rows = await a.workspace_rows(name);
        } catch {
          say('workspace: unavailable right now');
          await renderConnectors(a);
          return;
        }
        const sh = v.shape(name, rows);
        if (!sh || !sh.ok) {
          say('workspace: rows refused (' + ((sh && sh.reason) || 'unknown') + ')');
          await renderConnectors(a);
          return;
        }
        for (const l of sh.lines) rowsEl.appendChild(line(l));
        if (sh.total === 0) rowsEl.appendChild(line('no rows yet: rows appear only through explicit app actions, never a scan'));
        say('workspace: showing ' + sh.shown + ' of ' + sh.total + (sh.skipped ? ', ' + sh.skipped + ' skipped' : ''));
        await renderConnectors(a);
      } catch {
        say('workspace: unavailable right now');
      } finally {
        busy = false;
      }
    }

    sel.addEventListener('change', refresh);
    refreshBtn.addEventListener('click', refresh);

    refresh();
    return { refresh };
  }

  if (typeof window !== 'undefined') {
    window.CompanionWorkspacePanel = { mount };
  }

  if (typeof document !== 'undefined') {
    const boot = () => {
      if (document.getElementById('ws-view')) mount({});
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }
})();
