# Gate 2 proposals: the scheduling gate and the file-output gate (24 Nov 2026)

Status: DESIGN ONLY. Nothing here is implemented, registered, granted or
enabled. This document exists because Ninad authorized PREPARING the two
remaining Gate 2 tool gates for review on 24 Nov 2026, explicitly NOT
implementation. It follows the Stage B proposal precedent
(docs/STAGE_B_PROPOSAL.md): every claim below was checked against live
main `40ca09b` and the existing tests. The production registry stays
EMPTY (src/main.js comments it and tests pin it); nothing in this
proposal changes that.

Both proposals share one honest dependency stated up front: even if both
gates are later approved, implemented and enabled, NO STEP CAN EXECUTE
until Stage-A decision D1 (the run entry point that turns a user gesture
into a main-side run request) is decided. The tools would be inert,
registered-or-not, until a run can start. That dependency is unchanged
from the run-driver design (docs/RUN_DRIVER_DESIGN.md) and the Stage B
proposal.

Shared boundaries (both gates, unchanged from the implemented stack):

- Capability class `sensitive`: the policy engine requires a FRESH
  one-time approval for sensitive/critical tools on every call; a
  standing grant NEVER authorizes them (policy-engine check order,
  verified in src/policy-engine.js). Both new tools are therefore
  per-call-approval tools by construction, not by convention.
- Exact-tool grants only: wildcard and capability-name grants are
  refused at grant time and can never exist.
- Approval digests: approvals are one-time and bound by digest to the
  exact tool and the exact argument set (src/approval.js, digest over
  canonical JSON); any argument change is a different approval.
- Emergency stop: blocks every authorization while active; reset only
  by explicit user action (src/emergency-stop.js).
- Audit: append-only hash chain, allowlisted short typed fields, actors
  user/agent/system, action regex /^[a-z][a-z0-9_.]{0,47}$/ (verified
  in src/audit.js). An audit append failure poisons the run
  (orchestrator poison rule, unchanged).
- Injection inertness: plan steps and step results are inert data; the
  23-payload red-team corpus (27 tests) keeps passing unchanged. Grants
  are never widened based on content; no content-based policy is added.
- Registry validation: `define()` enforces the critical-namespace and
  destructive-segment refusals; both tool names below avoid those
  namespaces and are registered `critical: false`.
- Enable path: registration into the (currently empty) production
  registry is a SEPARATE owner-approved step after implementation; the
  enable commit is one literal registration plus its wiring-lock test
  update. Tools execute only inside orchestrator runs driven by the
  existing run driver; no direct-call surface is proposed.

======================================================================
PART 1 - The scheduling gate: `schedule_create` (capability sensitive)
======================================================================

## 1. The candidate

A single tool, `schedule_create`, that creates ONE reminder schedule
through the EXISTING M5 schedule book (src/agent-scheduler.js,
createScheduleBook). The adapter is a new pure module,
`src/agent-tool-scheduling.js`, that receives the book instance by
DEPENDENCY INJECTION - it never requires the scheduler module itself,
so the existing wiring lock (tests/agent-scheduler.test.js:422, which
pins that only agent-runtime.js builds the book) needs only an
addition, not a relaxation. The adapter performs exactly one mutation,
`book.create(...)`; it never pauses, resumes, cancels, updates or
ticks. The product-owned tick in main.js stays the ONLY firing path,
and delivery stays opt-in (`proactive_enabled` default false), so a
created schedule can never wake or notify anything until the user
opts in on the product surface.

Proposed definition:

  name:        schedule_create
  description: create one user-approved reminder schedule
  capability:  sensitive            (fresh one-time approval per call)
  critical:    false                (name avoids all critical namespaces)

Argument schema (validated by the registry, then re-validated by the
adapter):

  title:  string, 1..120        (the book's MAX_TITLE, unchanged)
  scope:  const "reminder" ONLY (the book's SCOPES also allow
          "deadline"; the adapter REFUSES deadline in v1 - an
          agent-created deadline is a stronger commitment than this
          gate proposes)
  dueAt:  safe integer > now, and <= now + 365 days (new adapter rule:
          a bounded horizon so a run cannot create far-future clutter)
  notes:  optional string, 0..500 (the book's MAX_NOTES, unchanged)

Every field the book's own create() validates stays validated by the
book; the adapter adds only the scope restriction and the horizon cap.

## 2. Threat model

T1  Runaway schedule creation (a run mass-creates reminders).
    Mitigations: capability `sensitive` means EVERY creation demands a
    fresh one-time approval - no batch can ride one grant or one
    approval; the book cap (MAX_SCHEDULES = 100) is unchanged and
    returns book_full; a duplicate refusal (below) stops identical
    retries.

T2  Approval laundering (an approval quoted inside tool output or
    injected content). Mitigations: approvals are digest-bound to the
    exact tool and args and are one-time; ids quoted in content are
    unknown to the desk; the injection corpus already proves resuming
    with quoted ids executes nothing. Unchanged, covered by the
    existing corpus tests which must keep passing.

T3  Injection via title/notes content. Mitigations: arguments are
    inert, strictly-validated data; strings are length-capped and
    stored verbatim; they reach only the existing allowlisted product
    display paths (schedules list/panel). No content-based policy is
    added; model-driven interpretation stays excluded by design.

T4  Grant widening. Mitigations: the grant is exact-tool only;
    wildcard and capability grants are refused at grant time; the
    sensitive class can never ride a standing grant. The wiring lock
    gains a rule that no file other than the adapter may reference the
    tool name, and the contract file never gains a schedules channel
    (the existing lock already asserts ipc-contract.js never mentions
    'schedules:'; that assertion is kept and strengthened).

T5  Future-action bypass (approve args, then swap the payload).
    Mitigations: the approval digest covers the exact argument set
    including dueAt; any change is a new approval. The book's own
    validation re-runs at create time, so an approval cannot make an
    invalid schedule valid.

T6  Emergency-stop gap. Mitigations: the stop blocks every
    authorization while active, including this tool's; the stop race
    bound (at most one in-flight step completes after a stop) is
    unchanged; a created schedule is immediately visible on the
    product schedules surface and cancellable there by the user; a
    pending un-consumed approval expires by TTL.

## 3. Idempotency, checkpoints, cancellation

- Idempotency: new adapter rule - an exact duplicate
  (scope, title, dueAt) already in the book is refused
  (duplicate_schedule), so a retried step cannot double-create. The
  book's sequence ids are unchanged.
- Checkpoints: none new. The existing guarantees cover this tool:
  audit-first on every transition, save() checkpoints at pauses and
  terminals (saver failsafe: failures logged, never state-changing),
  and the agent_schedules/agent_schedule_scopes tables already persist
  the book through agent-persistence.
- Cancellation: the agent cannot cancel or pause anything (creation
  only, least privilege). The user cancels or pauses on the existing
  product channels (schedules:cancel / schedules:pause), which remain
  the only mutation paths for existing schedules.
- Emergency stop: unchanged and absolute (blocks authorization while
  active).

## 4. Audit semantics

On success, one entry: { actor: 'agent', action: 'schedule.create',
tool: 'schedule_create', decision: 'allowed',
detail: { id, scope, dueAt } } (id string, scope string, dueAt number;
all fit the existing allowlisted schema). Every refusal rides the
existing run.step_denied path with its structural reason - no new
refusal event shape. Hydration skips, if any, ride the existing
hydrate-skip system entry pattern.

## 5. Failure modes

  no_grant                    policy engine (no exact-tool grant)
  approval_required           policy engine (sensitive class)
  approval_invalid/_expired/_consumed   approval desk / executor
  title_invalid / notes_invalid / due_at_past / book_full
                              the book's own validation
  scope_deadline_refused      adapter (v1 scope restriction)
  due_at_too_far              adapter (365-day horizon)
  duplicate_schedule          adapter (idempotency rule)
  audit_append_failed         poison rule -> step failure (unchanged)
  persistence_save_failed     logged, never state-changing (unchanged)

## 6. Tests and CI

New tests/gate2-scheduling-gate.test.js (~16 tests), all through the
REAL stack (registry + policy engine + approval desk + audit +
orchestrator + run driver), mirroring tests/gate2-harmless-tools.test.js:

  1  registry definition validation (sensitive class, critical false,
     schema shape; the critical-namespace refusals apply)
  2  schema rejections: deadline scope refused, past dueAt, horizon
     cap, over-long title/notes, non-string types
  3  deny ladder end to end: no grant -> approval_required even WITH a
     standing grant (sensitive class) -> digest mismatch refused ->
     valid approval authorizes exactly once (executor consumes)
  4  duplicate_schedule refusal on identical (scope, title, dueAt)
  5  book_full refusal at the cap
  6  a full three-step run creates exactly one real schedule and
     audits every transition, including schedule.create
  7  emergency stop active -> every call refused
  8  the created schedule is visible through the product list path
     and cancellable through the product channel
  9  wiring-lock additions: agent-tool-scheduling.js does NOT require
     './agent-scheduler' (DI only); no other file references the tool
     name; ipc-contract.js still never mentions 'schedules:'
  10 the injection corpus stays green (already covered; asserted again)

CI: both existing workflows (CI, CI (macOS + Linux)) on the
implementation commit; full suite + selftest before push.

## 7. Exactly what changes / what stays disabled

NEW:    src/agent-tool-scheduling.js (pure adapter)
        tests/gate2-scheduling-gate.test.js
DOCS:   docs/PRODUCT_BLUEPRINT.md (new 3j.11 section)
        docs/IMPLEMENTATION_ROADMAP.md (Gate 2 status line)
        this proposal moves to "implemented, not enabled"
UNCHANGED: src/agent-scheduler.js (no code change; DI only),
        src/tool-registry.js, src/policy-engine.js, src/approval.js,
        src/audit.js, src/emergency-stop.js, src/agent-orchestrator.js,
        src/agent-run-driver.js, src/db.js (no new tables),
        renderer/preload/ipc-contract (nothing new reaches the
        renderer), main.js (NO registration - the registry stays
        EMPTY until the separately-approved enable step).

STAYS DISABLED: production registration; the run-driver 'scheduled'
kind (Stage-A D7 allowlist keeps exactly ['user']); deadlines scope
for agent-created schedules; any agent cancel/pause/update; delivery
(proactive_enabled stays default false); all renderer surfaces.

## 8. Rollback

Single-commit revert removes the adapter and its tests; no schema
change exists to unwind; the registry was never populated by this
slice; any schedule created during a LATER enable window remains
visible and cancellable on the product surface regardless of the
tool's presence.

======================================================================
PART 2 - The file-output gate: `file_write` (capability sensitive)
======================================================================

## 1. The candidate

A single tool, `file_write`, that writes ONE text file into ONE
user-configured directory. The policy/validation layer is a new pure
module, `src/agent-tool-file-output.js`; the actual disk I/O is an
INJECTED io adapter supplied by main (the only non-pure part) with the
narrow interface { exists(fullPath), realpath(fullPath),
writeFileAtomic(fullPath, content) }. Nothing in the tool requires a
filesystem module, so the pure layer is testable without a disk.

Proposed definition:

  name:        file_write
  description: write one text file into the user's configured folder
  capability:  sensitive            (fresh one-time approval per call)
  critical:    false

Argument schema:

  name:     strict basename, /^[A-Za-z0-9][A-Za-z0-9._-]{0,126}$/,
            MUST end in an allowlisted extension (.ics, .txt, .md).
            No separators, no leading dot, no absolute paths, no
            subdirectories (flat root only in v1).
  content:  string, at most 65536 bytes when encoded UTF-8, valid
            Unicode (lone surrogates refused). Text only.

The natural first content source is the existing pure ICS generator
(src/agent-ics.js, read_only, returns a string), but the tool accepts
any validated text; it never parses content for commands and never
executes it.

## 2. Threat model

T1  Path traversal / absolute path. Mitigations: basename-only regex
    forbids separators and leading dots; the tool has no notion of a
    path beyond name; the io adapter receives root + name, never a
    user-controlled path.

T2  Symlink escape. Mitigations: before any write, the adapter asks
    the io adapter for realpath(root) and refuses unless it equals the
    configured root; the target must NOT exist (refused otherwise),
    which removes the symlink-at-target case; the root is flat and
    pre-existing, so no intermediate component is ever created.

T3  Overwrite/clobber of user files. Mitigation: refuse-if-exists,
    always. Overwrite is out of scope for v1 entirely; a new
    filename is required. A refused write leaves at most a temp file,
    which the io adapter removes on failure (atomic write contract:
    temp file + rename in the same directory, mode 0o600, no execute
    bit).

T4  Large-file / disk exhaustion. Mitigations: 64 KiB byte cap;
    MAX one file per step; the audit records name and byte count
    only.

T5  Executable or binary smuggling. Mitigations: UTF-8 text
    validation, extension allowlist (.ics/.txt/.md), 0o600 mode with
    no execute bit set by the io adapter.

T6  Exfiltration via file content. Mitigations: files land in ONE
    local user-chosen directory; the tool has no network, no upload
    path and no shell; nothing reads the files back in this gate. The
    standing no-content-based-policy boundary is unchanged.

T7  Approval laundering / digest swap. Mitigations: per-call
    one-time approval digest-bound to the exact name AND content; a
    one-byte content change is a different approval; quoted approval
    ids stay dead (corpus-proven).

## 3. Root-directory policy (least privilege)

A single root directory, configured ONLY main-side from a user
setting. Default: UNSET - every call is refused
(file_output_root_unconfigured) even with a grant and a valid
approval, until the user configures a folder on the product surface.
The renderer and the model can never set or widen the root. This is
the fail-closed default and is the recommended policy (decision
D-F2 below).

## 4. Idempotency, checkpoints, cancellation

- Idempotency: refuse-if-exists makes every write one-shot; a retried
  step fails with file_exists and needs BOTH a fresh approval AND a
  different name. There is deliberately no upsert.
- Checkpoints: no database state; the audit entry is the record; the
  persistence save() path is untouched.
- Cancellation: writes cannot be cancelled mid-flight (atomic rename);
  an emergency stop blocks every new authorization; a pending
  approval expires by TTL.
- Emergency stop: unchanged and absolute.

## 5. Audit semantics

On success, one entry: { actor: 'agent', action: 'file.write',
tool: 'file_write', decision: 'allowed', detail: { name, bytes } }.
Content is NEVER audited. Refusals ride the existing run.step_denied
path.

## 6. Failure modes

  file_output_root_unconfigured  default; also after the user clears it
  root_missing / root_realpath_mismatch
                                 io adapter checks
  name_invalid / ext_not_allowed / content_too_large /
  content_not_text               adapter validation
  file_exists                    adapter (never overwrite)
  realpath_escape                adapter via io realpath check
  no_grant / approval_required / approval_invalid/_expired/_consumed
                                 existing ladder
  io_refusal                     allowlisted io error passthrough
  audit_append_failed            poison rule (unchanged)

## 7. Tests and CI

New tests/gate2-file-output-gate.test.js (~18 tests) through the REAL
stack, with a fake io adapter implementing the three-method contract:

  1  registry definition validation; extension allowlist enforcement
  2  root-unconfigured refusal (with grant AND valid approval)
  3  deny ladder end to end incl. digest binding on exact content
  4  traversal/name rejections ('..', separators, absolute, dotfile)
  5  exists refusal; no partial file after refusal (fake io contract)
  6  symlink/realpath refusal cases via the fake io adapter
  7  byte cap and lone-surrogate rejection
  8  atomic write contract: temp+rename, 0o600, no execute bit
  9  audit entry carries name+bytes only (content absent, asserted)
  10 emergency stop refusal; wiring-lock additions (only main may
     require the adapter; ipc-contract unchanged); corpus still green

CI: both workflows on the implementation commit; full suite + selftest
before push.

## 8. Exactly what changes / what stays disabled

NEW:    src/agent-tool-file-output.js (pure validation/policy layer)
        tests/gate2-file-output-gate.test.js
DOCS:   docs/PRODUCT_BLUEPRINT.md (new 3j.12 section)
        docs/IMPLEMENTATION_ROADMAP.md (Gate 2 status line)
        this proposal moves to "implemented, not enabled"
UNCHANGED: src/tool-registry.js, src/policy-engine.js, src/approval.js,
        src/audit.js, src/emergency-stop.js, src/agent-orchestrator.js,
        src/agent-run-driver.js, src/agent-ics.js (a CALLER later, not
        a changed file), src/db.js (no new tables), renderer/preload/
        ipc-contract (unchanged), main.js (NO registration; the io
        adapter and root wiring arrive only WITH the enable step).

STAYS DISABLED: production registration; any root directory (unset by
default); overwrite semantics; subdirectories; any read-back tool;
the run-driver 'scheduled' kind; all renderer surfaces.

## 9. Rollback

Single-commit revert removes the adapter and its tests; no schema
change; no file outside the injected root could ever have been
written because the registry was never populated.

======================================================================
DECISIONS NINAD MUST MAKE BEFORE IMPLEMENTATION
======================================================================

D-S1  Approve the scheduling gate design as proposed (sensitive
      class, reminder scope only, creation-only, 365-day horizon,
      duplicate refusal). Any change to scope or class changes the
      threat model and the tests.

D-S2  Whether the run-driver 'scheduled' kind (Stage-A decision D7)
      is ever enabled, as its own later gate, after D1 (run entry
      point) is decided. Recommendation: defer; nothing in this
      proposal needs it.

D-F1  Approve the file-output gate design as proposed (sensitive
      class, flat root, refuse-if-exists, 64 KiB, three extensions).

D-F2  Root-directory default: UNSET until the user configures one
      (recommended) or a default folder inside the app's own data
      directory. The recommended default fails closed for every
      agent write until the user acts.

D-F3  Extension allowlist: exactly .ics/.txt/.md (recommended) or a
      different set. .json could be added later as its own reviewed
      change.

Recommended order if both are approved: scheduling first (it composes
with the existing, fully-tested scheduler and needs no io adapter),
file output second.

Nothing in this document implements, registers, grants or enables
anything. The production registry remains EMPTY and no run can start
until D1 is decided, exactly as Stage A left it.
