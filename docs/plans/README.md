# Plans for further work

Status as of October 2, 2026. The user stopped diagnosis and requested only that further plans be saved. These documents **do not authorize continued implementation**, model execution, package installation, configuration changes, or Git operations without a new request.

## Current stopping point

- The extension runs on JavaScript with a custom ACP transport. TypeScript, a build step, and the SDK have not yet been introduced.
- The user reported a message editing/retry defect: the response appears "every other time", and the old message/response is not replaced as expected.
- A failing test was added to `test/extension.test.js`: `editing a completed native request replaces its turn instead of appending another`. There are no runtime fixes.
- The temporary `opencode.jsonc` remains in the root and requests permission only for `pwd`. Its removal was approved after verification; before deleting it, confirm that the user has not changed the file.
- The last successful full run **before adding the new test**: 41 passed and a successful `npm run check`. This is not a current green status: the new test failed when run separately.

## Documents and order

1. [03-native-resend-and-verification.md](03-native-resend-and-verification.md) — the diagnosis stopping point, fixing resubmission after identifying the cause, remaining native UI checks, cleanup, and final verification.
2. [01-typescript-build.md](01-typescript-build.md) — the previously saved migration plan for TypeScript, `import`/`export`, and a small build step. Do not combine it with the resubmission fix.
3. [02-acp-sdk.md](02-acp-sdk.md) — the previously saved migration plan for the official ACP SDK; follows plan 01.

The recommendation is to resolve the current defect first and establish a verifiable starting point. The user may choose a different order, but the existing failing test must not be hidden by a migration or labeled a migration regression. Plans 01 and 02 are unchanged; their versions and APIs must be rechecked during execution. The current dependency restrictions in `AGENTS.md` change only within a separately requested migration.

## Boundaries

- Work only in this project. Do not access `combinezone`.
- Native Chat through `chatSessionsProvider` and ACP; no Webview, separate chat, built-in Agent Host, or VS Code changes.
- Public sources for the editor version under test are read-only; do not read files from the installed VS Code.
- History remains in OpenCode; `workspaceState` contains metadata only. Do not introduce a separate conversation store as a workaround.
- Do not declare the entire MVP verified based on unit tests, a backend response, or smoke. Each UI scenario requires separate observations.
- Do not create commits, push, or create an MR automatically. At the stopping point, project files appeared as untracked; an empty `git diff` does not prove the absence of changes.

Tasks without completed diagnosis are described as checks and decision branches, not as a ready technical solution.
