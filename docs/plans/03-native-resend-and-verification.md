# Resending and the remaining native checks

> For the implementer: this is a saved continuation plan, not an instruction to perform the work. The user stopped the investigation. Resume it only upon a new request; mark completed items and record evidence separately.

**October 5 update:** the user resumed work and chose a temporary editing prohibition. Empty session capabilities were added to the manifest to disable checkpoint editing/attachments in 1.140.0; the shared handler rejects native Retry and shortened/changed history before the ACP prompt. The unsupported replacement test was replaced by regressions for the prohibition and the next ordinary Send, covering saved/untitled/direct handler routes. Fresh baseline before this change: 90 total / 89 pass / 1 replacement fail; transport deadlines now passed without changes. This is a new contract, not rewind or a fix for the separate “every other time” UI symptom. Bundle/native evidence is recorded separately in README.

**Current stopping point on October 5:** the CLI smoke entry point and discovery of the static model bridge on a clean profile were fixed. Automated results: 103/103 and successful build/types/check; native API smoke, the model in the picker, Send/streaming/tools/permissions/Stop and restoration after Reload were confirmed separately. The user asked to keep the current implementation for now. Native edit/Retry and full restart lack unambiguous manual confirmation; the temporary `opencode.jsonc` has not been deleted. Continue these checks, cleanup and subsequent features only upon a new instruction. Model/reasoning selection is saved in [document 04](04-model-and-reasoning.md), not implemented.

**Goal:** agree on correct editing/resending UX given the limitations of ACP 2.0.21, identify the cause of missing responses, and complete the remaining checks of the current extension.

**Architecture:** VS Code native Chat sends a request to participant `opencode`, which uses the shared ACP handler. `Sessions` owns the lifecycle and history representation; OpenCode stores backend history. Bypassing this through a Webview, another chat, an HTTP client for the shared service, or an editor patch is prohibited.

**Stack when the investigation stopped, before migration 01:** JavaScript, Node.js built-in test runner, ACP v1 over stdio; manual testing with VS Code 1.140.0 and OpenCode V2 2.0.21. After the separately commissioned migration 01, runtime code is in `src/*.ts` and is built into CommonJS bundles in `dist/`; the ACP transport remains custom. TypeScript/SDK are separate plans, not part of this fix.

**Basis:** the user's report about resending, the paused investigation, `README.md`, `AGENTS.md`, current source code and the test. The user additionally reported the result of checking the source of the specific OpenCode 2.0.21 tag and the complete list of ACP handlers: there is no replacement or rewind of a completed message through ACP in the same session. A final UX for this limitation has not yet been agreed.

## 1. What has already been confirmed

- [x] Native response `OPENCODE_NATIVE_OK`: user confirmation.
- [x] Incremental streaming: separate user confirmation.
- [x] Real `pwd` tool: screenshot of the `shell` and `pwd` cards, correct cwd `/Users/e.zaykov/Documents/trash/opencode-vscode`, completion metadata `status: completed`, `truncated: false`, `exit: 0`.
- [x] Stop during generation and the next request `AFTER_STOP_OK` in the same session: user confirmation.
- [x] Restoring a saved session after **Developer: Reload Window**, visible conversation and reproduction of `RESTORE_TEST_42`: user confirmation.
- [x] Explicit rejection in the permissions Quick Pick for `pwd` with a temporary `ask` rule: user confirmation.

These are manual observations before migration 01, not automated UI tests or confirmation of the new bundles. Tool evidence does not prove that raw stdout is shown inside the card or establish the number of executions from the “2 steps” label. Stop was not timed and does not prove there was no impact on other sessions in the process. Reloading the window is not the same as fully exiting and restarting the editor.

Before the new test was added, the full run showed 41 passing tests and a successful `npm run check`. The scoped code/test/security review of the model bridge previously finished without blocking findings or Critical/High security findings; this is not a review of the future fix or release approval. There was no separate Spec review of the model bridge against an agreed bridge spec.

## 2. Exact point where the investigation stopped

**User symptom:** when resending, a response appears “every other time”; the previous item is not replaced. A screenshot was attached in the conversation. The action mechanics (editing text, Retry, Enter/button) still need clarification; the message text alone cannot reliably reconstruct the sequence of UI actions.

**Reproduced defect:** the test calls the native participant twice with `context.history: []`, different request IDs and the texts `original`, `replacement`. Both requests receive their own fixture response. Reopening history returns two user turns instead of one:

```text
actual:   ['original', 'replacement']
expected: ['replacement']
```

The command has already been run and finished with exit code 1:

```bash
node --test --test-name-pattern='editing a completed native request' test/extension.test.js
```

The test proves that saved history does not match the expected replacement. It **does not reproduce** the missing response “every other time” and does not test the editor's actual model.

**Contract clarification:** this test's expectation—replacing a completed turn in the existing ACP session—is not supported by the OpenCode 2.0.21 API. After agreeing on the UX, the test must verify the chosen contract rather than demand a nonexistent operation. For now the test remains unchanged and fails; this is not grounds for adding an invented RPC or trimming only local history.

**Source of the limitation:** the initial check of the specific tag and complete list of ACP handlers was reported by the user. A separate source review of OpenCode v2.0.21, commit `8a8bd622a3d7dc29ccf30ec17f84e363ed95ed72`, was then performed; exact links are saved in section 4.1. This is source inspection, not runtime verification or native UI evidence. The statement applies to OpenCode 2.0.21 ACP and completed messages, not all versions, internal APIs, or cancellation of an active prompt through `session/cancel`.

**Code observations before migration 01:** `src/extension.js` passes only the current text to `backend.prompt` and does not synchronize the shortened `chatContext.history`. `src/sessions.js` appends a user turn and sends `session/prompt`; there is no existing rewind/replace path. This explains the reproduced history accumulation, but not yet the entire UI symptom. The current paths for future investigation are `src/extension.ts` and `src/sessions.ts`; the migration preserves this baseline and does not fix resending.

**Open hypotheses, not proven causes:** mismatch between native and backend history; a race between cancelling the old turn and a new request; checkpoints/editing within native Chat itself. Runtime code had not yet been changed when work stopped; migration 01 does not fix resending.

## 3. Files and contracts

- `src/extension.ts` (before migration 01: `src/extension.js`): participant for saved/untitled URIs, provider, `historyFor`, shared `requestHandler`, permissions Quick Pick, metadata persistence.
- `src/sessions.ts` (before migration 01: `src/sessions.js`): `create`, `load`, `update`, `prompt`, `requestPermission`, active-turn cancellation and reconnect.
- `src/acp.ts` (before migration 01: `src/acp.js`): child-process transport. Change it only if the investigation shows a necessary change to the protocol path.
- `test/extension.test.js`: the red test already added, native routes and bridge regressions.
- `test/sessions.test.js`, `test/fixtures/agent.cjs`: lifecycle, history, cancellation; the fixture must not pretend to support a nonexistent backend API.
- `test/editor-smoke.cjs`, `.vscode/launch.json`, `scripts/check.cjs`: smoke and launch/manifest checks.
- `opencode.jsonc`: temporary configuration for permission checks, not a permanent part of the product.
- `README.md`: current limitations and results of manual checks.

Reading the editor's public source code in `/Users/e.zaykov/Documents/trash/vscode-reference-1.140.0` is permitted. The clone is pinned to tag `1.140.0`, commit `07f806f999227108933c2e30515b26eecc1fda74`; do not modify it, build it, or install packages in it.

Locations already examined in the same public tag:

- `src/vs/workbench/contrib/chat/common/chatService/chatServiceImpl.ts`: `resendRequest` and request removal/forwarding when retrying.
- `src/vs/workbench/contrib/chat/browser/widget/chatWidget.ts`: sending an edited request, `finishedEditing`, checkpoints and `supportsCheckpoints`.
- `src/vs/workbench/api/common/extHostChatAgents2.ts`: converting the request and history before calling the participant.
- `src/vscode-dts/vscode.proposed.chatParticipantPrivate.d.ts`: request `id`, `attempt`, context.
- `src/vscode-dts/vscode.proposed.chatSessionsProvider.d.ts`: session history and handler contract.

If the editor version has changed, check its public tag first. Do not use `main` or installed editor files as the contract source.

## 4. Resuming the investigation

- [ ] Clarify the exact UI action: editing a sent message or retrying a response, whether the previous request has finished, which message changes, and what exactly remains old. Do not treat these scenarios as one.
- [ ] Reproduce with two safe text markers without tools: the original request “Reply exactly EDIT_ORIGINAL_OK”, then replace it with “Reply exactly EDIT_REPLACEMENT_OK”. Check the current UI and history after reopening.
- [ ] Separately retry a completed response and edit an earlier message when a subsequent turn exists. Record the expected fate of subsequent turns according to the native contract rather than inventing it.
- [ ] Record the editor/OpenCode version, action, expected and actual result. Check `request.id`, `request.attempt`, the contents of `context.history`, and the active-turn boundary. If temporary logs are needed, do not log entire prompts, credentials or tool payloads.
- [ ] Repeat the existing red test as initial evidence. After agreeing on the UX, replace the unsupported expectation with a regression for the chosen behavior; record the reason for the change. Do not hide the problem by deleting a check to obtain a green run.
- [ ] Compare VS Code native history, local `record.history` and backend replay through `session/load`. Simply deleting a local turn is not a fix if OpenCode returns the old context after reload.
- [ ] Check the Stop/new-request race: whether the old ACP prompt has finished by the next handler, whether `Prompt already active` appears, and whether an update from the old request enters the new stream.
- [x] Record the limitation established by the user: OpenCode 2.0.21 does not provide replacement or rewind of a completed message in the same session through ACP. Searching for such a handler in this version is no longer an open task.
- [x] Save exact links to the commit and handlers from the separate source review in section 4.1. This is not runtime/UI verification.
- [x] The user chose to temporarily prohibit editing. The attach/fork scenario from section 4.1 remains a separate future stage; do not silently create a new session or HTTP path.
- [ ] Check how the chosen UX can be implemented through the target editor's proposed API: whether editing/Retry can be disabled or a request safely rejected before the ACP prompt, preserving consistent history and a clear message to the user. If not, agree on a native UI limitation; do not patch VS Code.

**Stage result:** a proven cause of history accumulation and a separate explanation of the “every other time” symptom, or a precise description of what still cannot be reproduced. Do not attribute both symptoms to one cause without observations.

### 4.1. A branch before the selected message: contract and saved option

**User requirement:** a branch strictly **before** the selected message, without the message itself, its response or subsequent history in the context. A full fork of the original session does not meet this requirement.

**Confirmed by v2.0.21 source code**, commit `8a8bd622a3d7dc29ccf30ec17f84e363ed95ed72`:

- TUI `/fork` supports selective fork: [DialogFork](https://github.com/anomalyco/opencode/blob/8a8bd622a3d7dc29ccf30ec17f84e363ed95ed72/packages/tui/src/routes/session/dialog-fork.tsx) calls backend `session.fork` with `before: message.id` and receives a new session ID. [Projector](https://github.com/anomalyco/opencode/blob/8a8bd622a3d7dc29ccf30ec17f84e363ed95ed72/packages/core/src/session/projector.ts#L106-L226) excludes the selected message and subsequent messages.
- Standard ACP [`session/fork`](https://github.com/anomalyco/opencode/blob/8a8bd622a3d7dc29ccf30ec17f84e363ed95ed72/packages/cli/src/acp/service.ts#L286-L292) passes only `sessionID` to the backend, copies the entire history and performs replay; `before` is not exposed.
- The TUI action is not among ACP available slash commands: the [catalog](https://github.com/anomalyco/opencode/blob/8a8bd622a3d7dc29ccf30ec17f84e363ed95ed72/packages/cli/src/acp/catalog.ts#L87-L119) uses server `command.list`, not the TUI registry. Do not send `/fork <id>` through `session/prompt`: it may become a model request rather than a selective fork. An HTTP/CLI `api` bypass has not been chosen and is prohibited by the current architecture.

**Saved minimal option without changing transport:** the user manually creates a selective fork in OpenCode; in the future, add a separate explicit extension action to open/attach the prepared branch by session ID and cwd through ACP `session/load`. The original session is preserved; the branch opens as a separate resource `opencode:/<branchId>`. Do not import all backend sessions. This is not implemented yet, is not automatic native edit/Retry, and is not a fully agreed UX. Recording an option in the plan does not authorize implementation.

Future checks and tasks require a separate instruction:

- [ ] Check that the same persisted backend session ID is accessible to the selected ACP executable/profile/storage; establish the branch's authoritative cwd rather than guessing it from the current workspace.
- [ ] Provide explicit session ID/cwd input, validation and Workspace Trust. On rejection or a load error, do not add incorrect metadata to the list.
- [ ] Wait for successful `session/load` and replay; only then save `id`, `cwd`, `label`, `created` in `workspaceState`, without conversation content or new checkpoint metadata.
- [ ] Open a separate `opencode:/<branchId>`; do not overwrite the original resource or untitled alias. Do not duplicate an already tracked branch.
- [ ] Check using original history with subsequent turns: the branch prefix excludes the selected message, its response and everything after it; the original session remains unchanged. Do not count a full fork as success.
- [ ] Check that load/replay does not resend old prompts or execute old tools. Fork does not undo past file/tool side effects and is not file Undo; a new Send can invoke new tools.
- [ ] Separately check new Send and Stop in the branch in native UI; separately check branch restoration after Reload Window and a full restart. Source review, fixtures and smoke do not replace these observations.

**An automatic operation before an arbitrary old message** requires a confirmed ACP `before`/extension contract. Proactive snapshots were considered but not chosen: they cover only future nonempty boundaries saved in advance, a full fork of an empty session produces `ForkEmptyError`, total storage grows as O(n²), and new checkpoint metadata and cleanup are required. Do not introduce this pipeline as a hidden implementation of the saved option.

## 5. Fixing after the cause is established

- [ ] Add a minimal regression for the identified cause of the missing response, if reproduced; observe its failure before changing runtime code.
- [ ] Fix the shared path for saved/untitled native requests, not a single UI entry point. Preserve current IDs, metadata-only storage and the prohibition on direct generation through the model bridge.
- [ ] Check ordinary message addition: two different new requests remain two turns rather than incorrectly replacing each other.
- [ ] Check repetition of the same text: an identical prompt alone does not mean editing. Match requests only using the verified contract, not a text heuristic.
- [ ] Check editing/Retry of the last turn and an earlier turn according to the agreed UX. When the operation is prohibited, no new ACP prompt must be sent or backend history changed; for another agreed scenario, check its explicit boundaries. Do not demand an unavailable replacement in the existing session.
- [ ] Check the saved session after `session/load` and after window reload: backend and UI continue with consistent history.
- [ ] Check the agreed editing/Retry scenario after cancellation or an error, and prevention of a second simultaneous prompt in one ACP session. Check that updates from the old turn do not appear in the new response.
- [ ] Separately repeat the user's UI scenario several times in a row. A green fixture run does not confirm that “every other time” has disappeared in the editor.

## 6. Unfinished permission checks

The temporary `opencode.jsonc` file currently contains only:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permissions": [
    { "action": "shell", "resource": "pwd", "effect": "ask" }
  ]
}
```

Global settings were not changed. Rejection is confirmed; the Allow once check was proposed, but the user reported the resending bug instead of a result.

- [ ] Resume checking in a native session with this cwd after reload. Send a new request, do not use the broken Retry: “Run pwd once through a tool and show the result. Do not use other tools”.
- [ ] Select **Allow once / Allow once**, not Allow always. Record the Quick Pick appearing, the selected option, the completed tool and correct cwd. If the picker is absent, the approval scenario is not considered verified.
- [ ] Send a new similar request and close the Quick Pick with Escape. Check that the requested tool is not approved/executed and that the next request without tools succeeds.
- [ ] Separately check Stop while the Quick Pick is open: the picker closes, permission is not sent as approval, and the next request works.
- [ ] If OpenCode automatically allows `pwd`, check the configuration actually applied and saved approvals. Do not broaden permissions or change global configuration without agreement.
- [ ] After completing the check, read `opencode.jsonc` and compare it with the temporary content created. Delete only this file, and only if it is unchanged. If the user made changes, preserve the file and ask how to finish cleanup.
- [ ] Reload after cleanup and ensure the temporary rule is no longer an active test condition. Do not promise a global permissions state that was not checked.

## 7. Recovery after a full restart

- [ ] In a saved native session, send “Reply exactly FULL_RESTART_TEST_42. Do not use tools” and wait for the response.
- [ ] Fully close the editor being tested and restart the development window with the same workspace and profile. This is a separate scenario from Developer: Reload Window.
- [ ] Select the previous OpenCode session from the list, not a new one. Check history, absence of discrepancies after the agreed editing/Retry scenario, and correct cwd.
- [ ] Send “What marker was in your last response? Reply only with the marker. Do not use tools”. Expect `FULL_RESTART_TEST_42`.
- [ ] Record the result separately from backend reload and window reload. On error, preserve safe details about the URI, session ID and failure stage, not credentials.

## 8. Smoke and final regression

- [ ] After runtime changes, run the full checks from the root:

```bash
npm test
npm run check
git status --short
```

Tests/check are expected to exit with code 0 after the fix. Take the test count from actual output, not the previous 41. `check` checks syntax and manifest/launch, not editor compatibility. Because of untracked files, inspect changed files separately: `git diff` is not yet sufficient.

- [ ] Complete the corrected **Native API smoke test** in real VS Code. The latest successful full run of the corrected runner is not yet confirmed. Use `.vscode/launch.json` or the CLI from README; Workspace Trust is granted manually, not disabled.
- [ ] Check opening `opencode:/…` separately through renderer logs: `ChatWidget#firstRender: session=opencode:/…` and `[ChatViewPane] loadSession done … uri=opencode:/…`. In 1.140.0, `activeChatPanelSessionResource` returns Local sessions and is unsuitable for checking OpenCode.
- [ ] Do not send a prompt in smoke or present a successful open command as native Send evidence.
- [ ] Run manual native testing without `--extensionTestsPath`, with isolated `--user-data-dir` and `--extensions-dir` from the project instructions. Preserve the selected profile for a full restart.
- [ ] After the fix, repeat the native response, streaming, tool card, explicit rejection/approval, Stop and next request. If the shared connection lifecycle is affected, separately check two sessions: normal cancellation of one and the documented impact of a 5-second timeout on both.
- [ ] Check the diff for weakened Workspace Trust, auto-approval, trusted Markdown, client filesystem/terminal capabilities, and conversation content entering `workspaceState`.
- [ ] Perform a final code/test/security review of the changed runtime; check compliance with the agreed solution. Do not transfer old model-bridge approvals to new changes.
- [ ] Update `README.md` and this checklist with actual results. Distinguish fixtures, real backend, API smoke and manual UI. Leave unverified scenarios unverified.
- [ ] Remove secrets, requests and sensitive data before sharing logs/screenshots. Do not include editor profiles/extensions or temporary evidence logs in publication.

**Completion criterion:** the agreed editing/resending UX accounts for the absence of replace/rewind for a completed message in the existing OpenCode 2.0.21 ACP session and is confirmed by tests and real UI; the “every other time” symptom is checked separately; Allow once, closing permission without approval, and full restart are checked; temporary configuration is removed safely; final checks and limitations are recorded. Do not claim release readiness before that.

## 9. Independent migration track

Plans 01 and 02 do not require this plan to be completed: plan 03 is an independent edit/fork/native validation track, not a prerequisite for starting migrations. Plan 02 depends only on plan 01.

- [ ] Upon a separate instruction, execute [01-typescript-build.md](01-typescript-build.md) independently of completing plan 03. Before migration, record the existing red test as the baseline; do not hide or weaken it, or attribute the prior failure to migration. Preserve existing replacement/Retry regressions. Do not fix this bug by moving to TypeScript.
- [ ] Upon a separate instruction, after completing plan 01, execute [02-acp-sdk.md](02-acp-sdk.md) independently of completing plan 03. Do not assume the SDK itself provides rewind/backend replacement.
- [ ] After each migration, rerun its required checks; previous manual successes do not prove native compatibility of a new build/transport.

Attachments, OpenCode model/agent pickers, importing all backend sessions, deletion, automatic fork and file Undo remain outside the current MVP. A separate explicit attach of a manually created branch is saved in section 4.1, but is not implemented and requires a new instruction and UX clarification. These are known limitations, not automatically agreed tasks. Packaging/distribution, commit/push/MR and broader version support require a separate decision; proposed API must not be treated as grounds for Marketplace publication.
