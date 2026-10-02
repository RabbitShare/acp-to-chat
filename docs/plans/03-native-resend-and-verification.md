# Resending and the remaining native checks

> For the implementer: this is a saved continuation plan, not an instruction to perform the work. The user stopped the investigation. Resume it only upon a new request; mark completed items and record evidence separately.

**Goal:** identify and fix the cause of incorrect message replacement/resending, then complete the remaining checks of the current extension.

**Architecture:** VS Code native Chat sends a request to participant `opencode`, which uses the shared ACP handler. `Sessions` owns the lifecycle and history representation; OpenCode stores backend history. Bypassing this through a Webview, another chat, an HTTP client for the shared service, or an editor patch is prohibited.

**Current stack:** JavaScript, Node.js built-in test runner, ACP v1 over stdio; manual testing with VS Code 1.140.0 and OpenCode V2 2.0.21. TypeScript/SDK are separate plans, not part of this fix.

**Basis:** the user's report about resending, the paused investigation, `README.md`, `AGENTS.md`, current source code and the test. This is an investigation plan: there is no agreed solution for rewinding/replacing backend history yet.

## 1. What has already been confirmed

- [x] Native response `OPENCODE_NATIVE_OK`: user confirmation.
- [x] Incremental streaming: separate user confirmation.
- [x] Real `pwd` tool: screenshot of the `shell` and `pwd` cards, correct cwd `/Users/e.zaykov/Documents/trash/opencode-vscode`, completion metadata `status: completed`, `truncated: false`, `exit: 0`.
- [x] Stop during generation and the next request `AFTER_STOP_OK` in the same session: user confirmation.
- [x] Restoring a saved session after **Developer: Reload Window**, visible conversation and reproduction of `RESTORE_TEST_42`: user confirmation.
- [x] Explicit rejection in the permissions Quick Pick for `pwd` with a temporary `ask` rule: user confirmation.

These are manual observations, not automated UI tests. Tool evidence does not prove that raw stdout is shown inside the card or establish the number of executions from the “2 steps” label. Stop was not timed and does not prove there was no impact on other sessions in the process. Reloading the window is not the same as fully exiting and restarting the editor.

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

**Code observations:** `src/extension.js` passes only the current text to `backend.prompt` and does not synchronize the shortened `chatContext.history`. `src/sessions.js` appends a user turn and sends `session/prompt`; there is no existing rewind/replace path. This explains the reproduced history accumulation, but not yet the entire UI symptom.

**Open hypotheses, not proven causes:** mismatch between native and backend history; a race between cancelling the old turn and a new request; checkpoints/editing within native Chat itself. Runtime code has not been changed yet.

## 3. Files and contracts

- `src/extension.js`: participant for saved/untitled URIs, provider, `historyFor`, shared `requestHandler`, permissions Quick Pick, metadata persistence.
- `src/sessions.js`: `create`, `load`, `update`, `prompt`, `requestPermission`, active-turn cancellation and reconnect.
- `src/acp.js`: child-process transport. Change it only if the investigation shows a necessary change to the protocol path.
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
- [ ] Repeat the existing red test. Do not delete or weaken it to obtain a green run; if its assumptions differ from the real API, correct the assumptions with evidence.
- [ ] Compare VS Code native history, local `record.history` and backend replay through `session/load`. Simply deleting a local turn is not a fix if OpenCode returns the old context after reload.
- [ ] Check the Stop/new-request race: whether the old ACP prompt has finished by the next handler, whether `Prompt already active` appears, and whether an update from the old request enters the new stream.
- [ ] Check the supported OpenCode V2/ACP path for replacement, rewind or fork, if needed. Not finding a method does not prove lack of support: check current official documentation and the capabilities of the specific version. Do not call invented RPC methods.
- [ ] Before changing behavior, choose the minimal solution based on evidence. If the current backend does not support the required replacement in the same session, agree on a limitation or different UX with the user. Do not silently create a new session, hidden history or an alternative HTTP path.

**Stage result:** a proven cause of history accumulation and a separate explanation of the “every other time” symptom, or a precise description of what still cannot be reproduced. Do not attribute both symptoms to one cause without observations.

## 5. Fixing after the cause is established

- [ ] Add a minimal regression for the identified cause of the missing response, if reproduced; observe its failure before changing runtime code.
- [ ] Fix the shared path for saved/untitled native requests, not a single UI entry point. Preserve current IDs, metadata-only storage and the prohibition on direct generation through the model bridge.
- [ ] Check ordinary message addition: two different new requests remain two turns rather than incorrectly replacing each other.
- [ ] Check repetition of the same text: an identical prompt alone does not mean editing. Match requests only using the verified contract, not a text heuristic.
- [ ] Check editing/Retry of the last turn and an earlier turn; ensure there are no unexpected duplicates, old responses or repeated tool side effects.
- [ ] Check the saved session after `session/load` and after window reload: backend and UI continue with consistent history.
- [ ] Check replacement/Retry after cancellation or an error, and prevention of a second simultaneous prompt in one ACP session. Check that updates from the old turn do not appear in the new response.
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
- [ ] Select the previous OpenCode session from the list, not a new one. Check history, absence of duplicates after the editing fix, and correct cwd.
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

**Completion criterion:** agreed replacement/resending behavior is confirmed by tests and real UI; Allow once, closing permission without approval, and full restart are checked; temporary configuration is removed safely; final checks and limitations are recorded. Do not claim release readiness before that.

## 9. Subsequent separate stages

- [ ] Upon a separate instruction, execute [01-typescript-build.md](01-typescript-build.md), preserving the resulting replacement/Retry regressions. Do not fix this bug by moving to TypeScript.
- [ ] After completing plan 01, execute [02-acp-sdk.md](02-acp-sdk.md). Do not assume the SDK itself provides rewind/backend replacement.
- [ ] After each migration, rerun its required checks; previous manual successes do not prove native compatibility of a new build/transport.

Attachments, OpenCode model/agent pickers, importing all backend sessions, deletion, fork and file Undo remain outside the current MVP. These are known limitations, not automatically agreed tasks. Packaging/distribution, commit/push/MR and broader version support require a separate decision; proposed API must not be treated as grounds for Marketplace publication.
