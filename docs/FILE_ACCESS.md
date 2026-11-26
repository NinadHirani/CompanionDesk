# File access (Gate 4, shipped read-only)

This page documents the file-access policy and execution core that ships inside CompanionDesk. It is generated from `src/agent-tool-file-access.js` and held in sync by `tests/file-access-doc.test.js`, so the doc and the code cannot drift.

## Safeguards

Target visibility: every decision names the normalized absolute target path, including inside refusals. Destructive confirmation: a write to an existing path (or one whose existence is unknown) needs an explicit confirmed argument, and a delete ALWAYS does; no default path destroys anything silently. OS sandbox respect: File operations always run inside the OS sandbox and its permissions; this policy never bypasses them. When the OS refuses an operation, the OS's own reason is surfaced unchanged.

Scoped roots start unset by default and stay optional (broad access is the approved mode); roots() shows what is set, nothing auto-set.

## Actions

| action | io adapter method | confirmation rule |
| --- | --- | --- |
| `read` | readFile | none |
| `list` | listDir | none |
| `write` | writeFile | confirmed=true when the file exists or its existence is unknown (overwrite_requires_confirmation); existsHint=false marks a new file and needs no confirmation |
| `delete` | deletePath | always confirmed=true (delete_requires_confirmation) |
| `mkdir` | mkdir | none |

The tool definition is capability `sensitive`, critical false; its schema caps paths at 500 characters and content at 500 characters.

## Execution

The io adapter is injected, never reached for: tests use a fake, and main.js builds the fs-backed adapter. The executor enforces MAX_WRITE_BYTES = 65,536 bytes (the same byte cap as the file-output gate) and refuses larger writes with `content_too_large`; OS failures surface the OS own reason verbatim. Read and list do not need confirmation; an `existsHint: true` mkdir reports changesNothing.

Status 27 Nov 2026: file_access is the second registered agent tool in main.js, wired through this policy. It executes nothing outside driver-driven runs, and the run-driver itself stays closed and design-only. No device validation is claimed. Noted for the owner: the schema 500-character content cap and the executor 65,536-byte cap are both shipped; which one binds depends on where argument validation runs. Aligning them is Ninad call, not a silent change.
