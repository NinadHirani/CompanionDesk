'use strict';
// Read-only agent status panel (Gate 2 wiring). Every call goes through
// window.companiondesk's six read-only channels. This file cannot start,
// step, resume or abort a run, approve anything, change grants, touch the
// emergency stop, or write persistence: the preload never exposes those
// operations. The panel renders text only (textContent, never innerHTML)
// and stays silent when a channel is refused or missing.
(function () {
  const READ_METHODS = ['status_get', 'runs_get', 'audit_read', 'providers_get', 'notifications_read', 'reminders_read'];

  function api() {
    const a = typeof window !== 'undefined' ? window.companiondesk : null;
    if (!a || typeof a !== 'object') return null;
    for (const m of READ_METHODS) {
      if (typeof a[m] !== 'function') return null;
    }
    return a;
  }

  function line(text) {
    const el = document.createElement('div');
    el.textContent = text;
    return el;
  }

  function panelEl() {
    let panel = document.getElementById('agent-status');
    if (!panel) {
      panel = document.createElement('section');
      panel.id = 'agent-status';
      document.body.appendChild(panel);
    }
    return panel;
  }

  function count(data, key) {
    return (data && data[key]) || [];
  }

  async function refresh() {
    const a = api();
    if (!a) return;
    try {
      const [status, runs, audit, providers, notifications, reminders] = await Promise.all([
        a.status_get({}),
        a.runs_get({}),
        a.audit_read({ limit: 20 }),
        a.providers_get({}),
        a.notifications_read({ limit: 20 }),
        a.reminders_read({ limit: 20 }),
      ]);
      const panel = panelEl();
      panel.textContent = '';
      if (!status || status.ok !== true) {
        panel.appendChild(line('agent: unavailable'));
        return;
      }
      const d = status.data || {};
      panel.appendChild(line(
        'agent: stopped=' + (d.stopped === true ? 'yes' : 'no')
        + ', active run=' + (d.activeRun || 'none')
        + ', pending notifications=' + (d.notificationsPending || 0)
      ));
      const runList = count(runs && runs.ok && runs.data, 'runs');
      panel.appendChild(line('runs: ' + (runList.length
        ? runList.map((r) => (r.state || '?') + ' ' + (r.runId || '?')).join('; ')
        : 'none')));
      const auditData = (audit && audit.ok && audit.data) || {};
      panel.appendChild(line('audit: ' + count(auditData, 'entries').length
        + ' recent entries, chain verified=' + (auditData.verified === true ? 'yes' : 'unknown')));
      const provList = count(providers && providers.ok && providers.data, 'providers');
      panel.appendChild(line('providers: ' + (provList.length ? provList.length + ' listed' : 'none')));
      const notifRecords = count(notifications && notifications.ok && notifications.data, 'notifications');
      panel.appendChild(line('notifications: ' + notifRecords.length + ' queued'));
      // Display only: the pure shaper turns the channel's records into
      // bounded plain-text lines (cap 10, newest first, malformed records
      // skipped). Everything below renders with textContent, so no record
      // can become markup. Nothing here marks a notification read and no
      // new channel is used: this is the same read-only notifications:read
      // response the count above always came from.
      const view = (typeof window !== 'undefined' && window.CompanionNotificationsView)
        ? window.CompanionNotificationsView
        : null;
      if (view && typeof view.shape === 'function') {
        const shaped = view.shape(notifRecords);
        if (shaped && shaped.ok === true) {
          for (const text of shaped.lines) panel.appendChild(line(text));
          if (shaped.hidden > 0) {
            panel.appendChild(line('notifications: ' + shaped.hidden + ' older not shown'));
          }
          if (shaped.skipped > 0) {
            panel.appendChild(line('notifications: ' + shaped.skipped + ' malformed record(s) not shown'));
          }
        }
      }
      // Display store section: the same notifications:read response also
      // carries the main-owned display store's records under data.display.
      // Rendered like everything else: bounded, textContent only, nothing
      // marked read, nothing sent back. Displaying is not acknowledging.
      const displayRecords = (notifications && notifications.ok && notifications.data && Array.isArray(notifications.data.display))
        ? notifications.data.display
        : [];
      panel.appendChild(line('display: ' + (displayRecords.length ? String(displayRecords.length) + ' shown' : 'none')));
      if (view && typeof view.shape === 'function') {
        const dshaped = view.shape(displayRecords);
        if (dshaped && dshaped.ok === true) {
          for (const text of dshaped.lines) panel.appendChild(line(text));
          if (dshaped.hidden > 0) {
            panel.appendChild(line('display: ' + dshaped.hidden + ' older not shown'));
          }
          if (dshaped.skipped > 0) {
            panel.appendChild(line('display: ' + dshaped.skipped + ' malformed record(s) not shown'));
          }
        }
      }
      panel.appendChild(line('reminders: ' + count(reminders && reminders.ok && reminders.data, 'reminders').length + ' scheduled'));
    } catch (e) {
      // Refusals and absences keep the panel quiet; nothing retries here.
    }
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', refresh);
    else refresh();
  }
})();
