# Plans for further work

Updated October 5, 2026. After the plans were saved, the TypeScript/SDK migrations were executed separately; the user requested a temporary editing restriction, investigation of test failures, and then verification of the bundles in the editor. The fourth document retains the future model/reasoning selection plan. Recording other tasks here does not automatically authorize their execution or Git operations.

## Current stopping point

- TypeScript/esbuild and SDK 1.7.0 with zod 3.25.76 have been introduced: `src/*.ts` and CommonJS bundles in `dist/` are current. The native UI on the new bundles requires a separate run.
- The user reported a message editing/retry defect: the response appears "every other time", and the old message/response is not replaced as expected.
- A new request introduced a temporary edit/Retry restriction: empty session capabilities and a check in the shared handler before the ACP prompt. The previous replacement expectation was replaced with tests for rejection without changing backend history and for an ordinary new Send; this does not implement rollback.
- The user reported the result of checking the sources at a specific tag and the complete list of ACP handlers: **OpenCode 2.0.21 does not provide replacement or rollback of a completed message in the same session through ACP**. This is a version limitation, not an open search for a method. The current temporary restriction is agreed; the future replacement/fork UX requires a separate decision, and the "every other time" symptom requires separate diagnosis.
- [Plan 03, section 4.1](03-native-resend-and-verification.md#41-a-branch-before-the-selected-message-contract-and-saved-option) retains the v2.0.21 source review and an option: a manual selective fork **before the message** in OpenCode, followed by a separate explicit branch attach by ID/cwd through ACP `session/load`. This is not implemented, is not automatic edit/Retry, and does not authorize implementation; proactive snapshots were not selected.
- The temporary `opencode.jsonc` remains in the root and requests permission only for `pwd`. Its removal was approved after verification; before deleting it, confirm that the user has not changed the file.
- Fresh baseline before the restriction: 90 tests, 89 pass, 1 replacement failure; the previous transport deadline failures did not reproduce. For subsequent results, see the current verification section in the root README.
- Current result on October 5: 103/103 unit tests, build/strict types/check pass. After fixing the smoke runner and model discovery, native Send, streaming, tool/Allow/Reject/Escape, both Stop scenarios, and history/continuation after Reload were manually confirmed. The user requested retaining the implementation for now; a full restart, the native UI edit/Retry restriction, and temporary config cleanup remain incomplete. Detailed evidence and boundaries are in README.

## Documents and order

1. [01-typescript-build.md](01-typescript-build.md) — the previously saved migration plan for TypeScript, `import`/`export`, and a small build step. Do not combine it with the resubmission fix.
2. [02-acp-sdk.md](02-acp-sdk.md) — the previously saved migration plan for the official ACP SDK; follows plan 01.
3. [03-native-resend-and-verification.md](03-native-resend-and-verification.md) — an independent track for editing/Retry, fork, and native validation: the ACP 2.0.21 limitation, UX agreement, missing-response diagnosis, remaining native UI checks, cleanup, and final verification.
4. [04-model-and-reasoning.md](04-model-and-reasoning.md) — a plan for backend model and reasoning effort/variant selection through ACP with a session-specific native picker. Not yet implemented.

**Dependency rule:** plans 01 and 02 may be executed on a separate request without completing plan 03; plan 02 depends only on plan 01. Plan 03 does not block the migrations and is not their mandatory first stage.

Before migration, record the existing failing test as the baseline: do not hide or weaken it, and do not attribute its prior failure to the migration. This failure does not block starting the migration, but it does not imply a green final suite or release readiness. Plans 01 and 02 and their final verification requirements are unchanged; their versions and APIs must be rechecked during execution. The current dependency restrictions in `AGENTS.md` change only within a separately requested migration.

## Boundaries

- Work only in this project. Do not access `combinezone`.
- Native Chat through `chatSessionsProvider` and ACP; no Webview, separate chat, built-in Agent Host, or VS Code changes.
- Public sources for the editor version under test are read-only; do not read files from the installed VS Code.
- History remains in OpenCode; `workspaceState` contains metadata only. Do not introduce a separate conversation store as a workaround.
- Do not declare the entire MVP verified based on unit tests, a backend response, or smoke. Each UI scenario requires separate observations.
- Do not create commits, push, or create an MR automatically. At the stopping point, project files appeared as untracked; an empty `git diff` does not prove the absence of changes.

Tasks without completed diagnosis are described as checks and decision branches, not as a ready technical solution.
