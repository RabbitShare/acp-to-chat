# Plans for further work

Status as of October 2, 2026. The user stopped diagnosis and requested only that further plans be saved. These documents **do not authorize continued implementation**, model execution, package installation, configuration changes, or Git operations without a new request.

## Current stopping point

- At the diagnosis stopping point, before migration 01, the extension ran on JavaScript with a custom ACP transport; TypeScript, a build step, and the SDK had not yet been introduced. After the separately requested migration 01, `src/*.ts` and CommonJS bundles in `dist/` are current; the custom ACP transport is retained, and the SDK has not yet been introduced.
- The user reported a message editing/retry defect: the response appears "every other time", and the old message/response is not replaced as expected.
- A failing test was added to `test/extension.test.js`: `editing a completed native request replaces its turn instead of appending another`. There are no runtime fixes.
- The user reported the result of checking the sources at a specific tag and the complete list of ACP handlers: **OpenCode 2.0.21 does not provide replacement or rollback of a completed message in the same session through ACP**. This is a version limitation, not an open search for a method. The editing/Retry UX still needs agreement; the "every other time" symptom requires separate diagnosis.
- [Plan 03, section 4.1](03-native-resend-and-verification.md#41-a-branch-before-the-selected-message-contract-and-saved-option) retains the v2.0.21 source review and an option: a manual selective fork **before the message** in OpenCode, followed by a separate explicit branch attach by ID/cwd through ACP `session/load`. This is not implemented, is not automatic edit/Retry, and does not authorize implementation; proactive snapshots were not selected.
- The temporary `opencode.jsonc` remains in the root and requests permission only for `pwd`. Its removal was approved after verification; before deleting it, confirm that the user has not changed the file.
- The last successful full run **before adding the new test**: 41 passed and a successful `npm run check`. This is not a current green status: the new test failed when run separately.

## Documents and order

1. [01-typescript-build.md](01-typescript-build.md) — the previously saved migration plan for TypeScript, `import`/`export`, and a small build step. Do not combine it with the resubmission fix.
2. [02-acp-sdk.md](02-acp-sdk.md) — the previously saved migration plan for the official ACP SDK; follows plan 01.
3. [03-native-resend-and-verification.md](03-native-resend-and-verification.md) — an independent track for editing/Retry, fork, and native validation: the ACP 2.0.21 limitation, UX agreement, missing-response diagnosis, remaining native UI checks, cleanup, and final verification.

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
