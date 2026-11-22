# CompanionDesk skill contract (v0, minimal)

CompanionDesk is a general-purpose local AI companion by default. Extra
capabilities attach through **skills**: small, declarative objects that only
contribute prompt lines and context lines to the assistant. A skill never
changes storage, network, permission, or billing behavior, and cannot execute
code on the user's behalf.

## Skill shape

A skill is a plain object in `src/skills.js` (or contributed later by a
module that calls `createSkills(extra)`):

| field | type | meaning |
| --- | --- | --- |
| `id` | string, unique | stable identifier |
| `name` | string | human label for settings UI |
| `description` | string | one line, shown in docs/settings |
| `systemPrompt` | string[] | extra system-prompt lines, may be empty |
| `enabled(db)` | bool | active for the current database? |
| `context(db, helpers)` | string[] | context-pack lines, may be empty |

`helpers` currently exposes `todayIso()` and `addDaysIso(iso, days)`.

## Rules

1. The `general` skill is always active and defines the base voice.
2. A skill activates only when its `enabled()` returns true; the `student`
   module activates only when course data exists, so a fresh install behaves
   as a general assistant with nothing imported.
3. Skills must not invent facts: the base voice instructs the model to say so
   when the context lacks an answer.
4. A future extension (third-party skill) should be a JSON-declarable object;
   loading arbitrary code for skills is out of scope until a signed
   distribution story exists.

## Current skills

- `general`: base companion voice.
- `student`: courses, deadlines, syllabus import framing. Assets:
  `prompts/syllabus-extract.md`.

## Web build note

`src/web/bridge.js` mirrors this contract with local constants until the web
build script bundles `src/skills.js`; behavior is kept identical on purpose.
