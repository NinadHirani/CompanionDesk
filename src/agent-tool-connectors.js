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
    description: 'read connector catalog states, or raise a user-facing connect request that the user must approve in the Workspace panel; it never connects, grants or touches credentials (Gate 2 AI-access decision, 27 Nov 2026)',
    capability: 'ordinary',
    critical: false,
    schema: {
      properties: {
        action: { type: 'string', required: true, maxLength: 14, enum: ['list', 'request_connect'] },
        connector_id: { type: 'string', maxLength: 64 },
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
    function execute(args) {
      if (!isPlainObject(args)) return Promise.resolve({ ok: false, reason: 'bad_request' });
      if (args.action === 'list') {
        var connectors = catalog.list().map(function (e) {
          return { id: e.id, name: e.name, state: catalog.state(e.id) || 'discovered', costNote: e.costNote, limits: e.limits };
        });
        return Promise.resolve({ ok: true, connectors: connectors, requests: requests.list() });
      }
      if (args.action === 'request_connect') {
        return Promise.resolve(requests.request(args.connector_id, { reason: args.reason }));
      }
      return Promise.resolve({ ok: false, reason: 'unknown_action' });
    }
    return { definition: CONNECTORS_TOOL_DEFINITION, execute: execute };
  }

  return { CONNECTORS_TOOL_DEFINITION: CONNECTORS_TOOL_DEFINITION, createConnectorsTool: createConnectorsTool };
});
