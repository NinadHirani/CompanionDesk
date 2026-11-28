// Gate 2 slice 3j.9, Stage C (28 Nov 2026): the per-call approval delivery
// path, decision D2 resolved as the OUT-OF-RENDERER surface. The preload
// contract stays untouched: the renderer keeps ZERO run-control or
// approval channels, and step arguments still never reach it (D6). When a
// run parks at awaiting_approval, MAIN shows a native dialog built from
// the orchestrator's own run state. Approve issues the exact one-run
// approval (tool + args digest) and resumes through the driver, which
// stays the ONLY orchestrator caller. Deny, dismissal, or any presenter
// failure leaves the run parked (D3): nothing here can start a run, only
// answer one that already paused. Fail-closed at every branch: no exact
// args match, no resume.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else if (typeof define === 'function' && define.amd) define([], factory);
  else root.CompanionDeskApprovalDialog = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULT_MAX_ARGS_CHARS = 400;
  var MAX_FIELD = 160;
  var TITLE = 'CompanionDesk needs your approval';
  var BUTTONS = ['Approve', 'Deny'];

  function bounded(text, max) {
    var s = String(text === undefined || text === null ? '' : text);
    if (s.length > max) return s.slice(0, max) + '\u2026';
    return s;
  }

  // Pure: builds the main-side dialog copy. Field bounds are hard so a
  // hostile goal, tool name, or args blob can never blow up the dialog.
  function buildApprovalPrompt(opts) {
    opts = opts || {};
    var maxArgsChars = opts.maxArgsChars === undefined ? DEFAULT_MAX_ARGS_CHARS : opts.maxArgsChars;
    if (typeof maxArgsChars !== 'number' || !Number.isFinite(maxArgsChars) || maxArgsChars <= 0) {
      throw new TypeError('maxArgsChars out of range');
    }
    var tool = bounded(opts.tool, MAX_FIELD);
    var runId = bounded(opts.runId, MAX_FIELD);
    var goal = bounded(opts.goal, MAX_FIELD);
    var description = bounded(opts.description, MAX_FIELD);
    var argsText;
    try {
      argsText = JSON.stringify(opts.args);
      if (typeof argsText !== 'string') argsText = '(unprintable arguments)';
    } catch (e) {
      argsText = '(unprintable arguments)';
    }
    argsText = bounded(argsText, maxArgsChars);
    var message = 'Tool "' + tool + '" in run ' + runId + ' needs your one-time approval.';
    if (description) message += ' It ' + description.charAt(0).toLowerCase() + description.slice(1);
    var detail = 'Goal: ' + goal + '\n\nStep asks for: ' + argsText +
      '\n\nApproving continues the run with these exact arguments. Denying leaves the run parked.';
    return { title: TITLE, message: message, detail: detail, buttons: BUTTONS.slice() };
  }

  function createApprovalSurface(opts) {
    opts = opts || {};
    var driver = opts.driver;
    var orchestrator = opts.orchestrator;
    var desk = opts.desk;
    var presenter = opts.presenter;
    var registry = opts.registry;
    var maxArgsChars = opts.maxArgsChars === undefined ? DEFAULT_MAX_ARGS_CHARS : opts.maxArgsChars;
    if (!driver || typeof driver.resume !== 'function') throw new TypeError('approval surface needs a driver with resume');
    if (!orchestrator || typeof orchestrator.getRun !== 'function') throw new TypeError('approval surface needs an orchestrator with getRun');
    if (!desk || typeof desk.request !== 'function') throw new TypeError('approval surface needs an approvals desk with request');
    if (typeof presenter !== 'function') throw new TypeError('approval surface needs a presenter');
    if (registry !== undefined && (!registry || typeof registry.get !== 'function')) throw new TypeError('approval surface registry must expose get');
    if (typeof maxArgsChars !== 'number' || !Number.isFinite(maxArgsChars) || maxArgsChars <= 0) {
      throw new TypeError('maxArgsChars out of range');
    }

    // One dialog per pause. The run must still be awaiting approval when
    // the answer comes back; anything else refuses without touching it.
    async function offer(runId) {
      if (typeof runId !== 'string' || runId.length === 0) return { ok: false, reason: 'run_id_invalid' };
      var state;
      try {
        state = orchestrator.getRun(runId);
      } catch (err) {
        return { ok: false, reason: 'run_state_unavailable' };
      }
      if (!state || state.state !== 'awaiting_approval' || !state.pendingApproval ||
          typeof state.pendingApproval.tool !== 'string' || state.pendingApproval.tool.length === 0) {
        return { ok: false, reason: 'no_pending_approval' };
      }
      var pending = state.pendingApproval;
      var def = registry ? registry.get(pending.tool) : null;
      var prompt;
      try {
        prompt = buildApprovalPrompt({
          runId: runId,
          tool: pending.tool,
          args: pending.args,
          goal: state.goal,
          description: def && def.description ? def.description : '',
          maxArgsChars: maxArgsChars,
        });
      } catch (err) {
        return { ok: false, reason: 'prompt_build_failed' };
      }
      var answer;
      try {
        answer = await presenter(prompt);
      } catch (err) {
        return { ok: false, reason: 'presenter_failed' };
      }
      if (answer !== 'approve') return { ok: true, decided: 'denied', runId: runId };
      var req;
      try {
        req = desk.request({ tool: pending.tool, args: pending.args });
      } catch (err) {
        return { ok: false, reason: 'approval_request_error' };
      }
      if (!req || req.ok !== true) {
        return { ok: false, reason: String((req && req.reason) || 'approval_request_refused') };
      }
      // The driver stays the only orchestrator caller, so the resume (and
      // the driving that follows it) goes through it, never direct.
      var report;
      try {
        report = driver.resume(runId, { approvalId: req.approval.id });
      } catch (err) {
        return { ok: false, runId: runId, reason: 'resume_error' };
      }
      return report;
    }

    return { offer: offer };
  }

  return { createApprovalSurface: createApprovalSurface, buildApprovalPrompt: buildApprovalPrompt, TITLE: TITLE, BUTTONS: BUTTONS };
});
