/**
 * Gate 2 AI-access connector flow (Ninad's decision, 27 Nov 2026): the
 * Connectors section is accessible by both the user and the AI. This module
 * is the agent-facing side: a read-and-ask tool. It lists the connector
 * catalog with live states and it can RAISE a user-facing connect request
 * naming one catalog connector and a bounded reason. It NEVER connects,
 * never grants a scope, never consumes an approval and never touches a
 * credential: connection stays behind the panel's explicit connect gate
 * (exact declared scopes, explicit user action, credential reference), and
 * the user approves or dismisses every request there. Pure: no fs, no
 * network, no secrets; the reason field is bounded text, nothing else.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CompanionAgentToolConnectors = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var CONNECTORS_TOOL_DEFINITION = {
    name: 'connector_status',
    description: 'read connector catalog states, raise a user-facing connect request that the user must approve in the Workspace panel, or RUN a read-only connector action through the same consent gates the panel uses; it never connects, grants or touches credentials, and send/write actions always come back approval_required for the user to run from the panel (Gate 2 AI-access decision, 27 Nov 2026; batch 2 action calling)',
    capability: 'ordinary',
    critical: false,
    schema: {
      properties: {
        action: { type: 'string', required: true, maxLength: 14, enum: ['list', 'request_connect', 'run'] },
        connector_id: { type: 'string', maxLength: 64 },
        action_id: { type: 'string', maxLength: 64 },
        params: { type: 'object' },
        reason: { type: 'string', maxLength: 280 },
      },
    },
  };

  function isPlainObject(v) {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
    var proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
  }

  function createConnectorsTool(opts) {
    var catalog = opts && opts.catalog;
    var requests = opts && opts.requests;
    var engine = opts && opts.engine;
    var adapters = opts && opts.adapters;
    function execute(args) {
      if (!isPlainObject(args)) return Promise.resolve({ ok: false, reason: 'bad_request' });
      if (args.action === 'list') {
        var connectors = catalog.list().map(function (e) {
          var row = { id: e.id, name: e.name, state: catalog.state(e.id) || 'discovered', costNote: e.costNote, limits: e.limits };
          // Implemented adapters surface their runnable actions so the AI
          // names only what actually exists; definition-only entries stay
          // silent about actions they do not have.
          if (adapters && e.integrationImplemented) row.actions = adapters.listActions(e.id) || [];
          return row;
        });
        return Promise.resolve({ ok: true, connectors: connectors, requests: requests.list() });
      }
      if (args.action === 'request_connect') {
        return Promise.resolve(requests.request(args.connector_id, { reason: args.reason }));
      }
      if (args.action === 'run') {
        // Batch 2 (27 Nov 2026): read-only connector actions run through
        // the SAME engine the panel uses, so the full consent chain
        // (connected, scope granted, single-use approval for sends and
        // writes) applies identically. The engine returns
        // approval_required for write/send scopes: the user runs those
        // from the Workspace panel, and this tool never mints approvals.
        if (typeof args.connector_id !== 'string' || args.connector_id.length === 0 || args.connector_id.length > 64) {
          return Promise.resolve({ ok: false, reason: 'bad_request' });
        }
        if (typeof args.action_id !== 'string' || args.action_id.length === 0 || args.action_id.length > 64) {
          return Promise.resolve({ ok: false, reason: 'bad_request' });
        }
        var params = {};
        if (args.params !== undefined) {
          if (!isPlainObject(args.params)) return Promise.resolve({ ok: false, reason: 'param_invalid' });
          if (Object.keys(args.params).length > 20) return Promise.resolve({ ok: false, reason: 'param_invalid' });
          var encoded = null;
          try { encoded = JSON.stringify(args.params); } catch (e) { return Promise.resolve({ ok: false, reason: 'param_invalid' }); }
          if (encoded === null || encoded.length > 2000) return Promise.resolve({ ok: false, reason: 'param_invalid' });
          params = args.params;
        }
        if (!engine) return Promise.resolve({ ok: false, reason: 'unavailable' });
        return engine.run(args.connector_id, args.action_id, params, {}).then(function (r) {
          if (r && r.ok === false && r.reason === 'approval_required') {
            return {
              ok: false,
              reason: 'approval_required',
              userAction: 'this send/write action needs the user\'s per-action approval; ask them to run it from the Workspace panel',
            };
          }
          return r;
        });
      }
      return Promise.resolve({ ok: false, reason: 'unknown_action' });
    }
    return { definition: CONNECTORS_TOOL_DEFINITION, execute: execute };
  }

  return { CONNECTORS_TOOL_DEFINITION: CONNECTORS_TOOL_DEFINITION, createConnectorsTool: createConnectorsTool };
});
