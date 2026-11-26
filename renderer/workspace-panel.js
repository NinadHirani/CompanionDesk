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
      for (const e of list) {
        if (!e || typeof e !== 'object') continue;
        connEl.appendChild(line((e.name || e.id) + ' - ' + (e.state || 'discovered') + ' - ' + (e.costNote || '') + ' - ' + (e.limits || '')));
        if (Array.isArray(e.scopes) && e.scopes.length) {
          connEl.appendChild(line('scopes: ' + e.scopes.map((s) => s.name + ' (' + s.class + ')').join(', ')));
        }
        const state = e.state || 'discovered';
        const scopeNames = (Array.isArray(e.scopes) ? e.scopes : []).map((s) => s.name);
        if (state === 'discovered') {
          connEl.appendChild(button('Connect ' + e.name, 'Connect ' + e.name, async () => {
            const r = await a.workspace_connector_connect(e.id, scopeNames);
            say(r && r.ok ? 'workspace: connect requested for ' + e.name : 'workspace: connect refused: ' + ((r && r.reason) || 'unknown'));
            await renderConnectors(a);
          }));
        } else if (state === 'connected') {
          connEl.appendChild(button('Disconnect ' + e.name, 'Disconnect ' + e.name, async () => {
            const r = await a.workspace_connector_disconnect(e.id);
            say(r && r.ok ? 'workspace: connector disconnected' : 'workspace: disconnect refused: ' + ((r && r.reason) || 'unknown'));
            await renderConnectors(a);
          }));
          connEl.appendChild(button('Revoke ' + e.name, 'Revoke ' + e.name, async () => {
            const r = await a.workspace_connector_revoke(e.id);
            say(r && r.ok ? 'workspace: connector revoked' : 'workspace: revoke refused: ' + ((r && r.reason) || 'unknown'));
            await renderConnectors(a);
          }));
        } else {
          connEl.appendChild(button('Readmit ' + e.name, 'Readmit ' + e.name, async () => {
            const r = await a.workspace_connector_readmit(e.id);
            say(r && r.ok ? 'workspace: connector readmitted' : 'workspace: readmit refused: ' + ((r && r.reason) || 'unknown'));
            await renderConnectors(a);
          }));
        }
      }
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
