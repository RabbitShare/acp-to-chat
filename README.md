# OpenCode Native Chat

Experimental extension: OpenCode sessions in **native VS Code Chat** through the proposed `chatSessionsProvider` API.
No webview, separate chat, or changes to VS Code source. This is **not** a provider for the built-in Agent Host.

## Requirements

- VS Code 1.140.0 or a compatible Insiders build. The API was verified against the 1.140.0 source; proposed APIs may change.
- An installed OpenCode V2 with `opencode acp` and configured provider authentication.
- An open, trusted local folder. For a multi-root workspace, the extension asks you to choose a working directory.
- Native VS Code Chat must be enabled. The extension does not require a Copilot subscription, but it does not replace the editor's chat infrastructure.

Development requires Node.js and npm: `npm ci` installs the TypeScript/esbuild tools and runtime dependencies pinned in the lockfile.
The `src/*.ts` source files are checked in strict mode and built into CommonJS bundles in `dist/`.
The thin `src/main.ts` entry point loads the VS Code API; the editor runs `dist/main.js`, and unit tests run the other three bundles.
Runtime dependencies are pinned exactly: `@agentclientprotocol/sdk@1.7.0` and `zod@3.25.76`.
`zod` is a direct dependency for the SDK peer requirement (`^3.25.0 || ^4.0.0`). esbuild includes the ESM SDK and `zod` in CommonJS bundles; they do not remain external.
A separate extension server is not needed: the extension launches `opencode acp` over stdio.

## Running without installing a VSIX

In a clean checkout, first install dependencies and build the extension from its root:

```bash
npm ci
npm run build
npm run check-types
```

Then, from a terminal, launch a separate development window with the desired project:

```bash
code --new-window \
  --user-data-dir="$HOME/Documents/trash/opencode-vscode/test/.editor-profile" \
  --extensions-dir="$HOME/Documents/trash/opencode-vscode/test/.editor-extensions" \
  --extensionDevelopmentPath="$HOME/Documents/trash/opencode-vscode" \
  --enable-proposed-api=local.opencode-native-chat \
  /absolute/path/to/your/project
```

If Stable rejects the proposed API, use `code-insiders` with the same arguments.
Microsoft officially recommends Insiders for proposed APIs. The Stable 1.140.0 source also explicitly allows enabling them by ID with this flag.

In the window that opens, run **OpenCode: New Native Chat Session** from the Command Palette. Enter messages in the standard Chat panel.
Sessions are registered as type `OpenCode`; their exact appearance in menus depends on the VS Code version.

Alternatively, open the extension directory in VS Code and press F5 with the **OpenCode Native Chat** configuration.
Both F5 configurations run the **build extension** task before launch and use sourcemaps from `dist/`; run `npm ci` beforehand.
For actual work, open the desired folder in the Extension Development Host window.

If the GUI cannot find the executable, specify an absolute path in user settings:

```json
{
  "opencodeNativeChat.command": "/absolute/path/to/opencode"
}
```

This is an executable path, not a shell command. The extension adds the `acp` argument.
Configure authentication beforehand with `opencode auth login`; the extension uses existing OpenCode credentials.

## First version

- Creating and reopening sessions, streaming text responses, reasoning, and tool statuses.
- Permissions are requested through the standard VS Code Quick Pick. Escape, closing it, and cancellation never mean approval.
- The Stop button sends ACP `session/cancel`. If the agent does not finish cancelling within 5 seconds, the connection closes.
- One active request per session. Cancelling a hung process may interrupt other sessions in the same process.
- `workspaceState` stores only session IDs, working directories, labels, and creation times. OpenCode stores history.
- The list includes sessions created by this extension in the current workspace, not all OpenCode sessions.
- Editing sent messages and native Retry are temporarily disabled: ACP OpenCode 2.0.21 does not replace completed turns. Send follow-ups as new messages. After a rejected edit/Retry, reopen the saved session. If editor caching prevents history from being restored, run **Developer: Reload Window** and reopen it. This recovery requires separate native UI verification.

The manifest specifies `chatSessions[].capabilities: {}`. In VS Code 1.140.0, this does not enable `supportsCheckpoints` and removes inline checkpoint editing and unsupported attachments. Editor commands/other entry points may remain available: the shared handler separately rejects `attempt > 0` and shortened/modified native history before sending `session/prompt`. OpenCode history is not truncated or silently moved to a new session.

OpenCode uses its own models, agents, skills, MCP, and permissions from the session directory's configuration.
In the first version, the model and agent come from OpenCode settings; model selection in the standard VS Code UI is not passed to ACP.
When converting a request, VS Code 1.140.0 requires a registered `LanguageModelChat`, even for an external ACP agent.
The synthetic `Auto` fallback unblocks the button, but does not by itself resolve `Language model unavailable`.
The extension registers the **OpenCode (configured)** bridge model only for `opencode` sessions through `targetChatSessionType`
and declares `requiresCustomModels: true`, `supportsAutoModel: false`. Metadata uses the proposed `chatProvider` API.
This is not a separate LLM client: the bridge does not launch OpenCode during model discovery, read credentials, or change its model.
After registration, activation explicitly calls `lm.selectChatModels({ vendor: "opencode" })` and waits for bridge metadata discovery: in VS Code 1.140.0, provider registration alone does not populate the model catalog on a clean profile. Other vendors are not queried; model generation is not invoked.
The ACP handler still produces the response; calling the bridge directly through `LanguageModelChat.sendRequest` fails with an explicit error.
Token limits are unknown and counting is unsupported: the bridge returns zeros, like the Copilot CLI session provider in 1.140.0.
These values do not limit ACP requests or represent the actual capacity of the OpenCode model.
If `Auto` remains after reload, select **OpenCode (configured)** in the model picker.
In a manual VS Code 1.140.0 run after adding the bridge, the user confirmed the `OPENCODE_NATIVE_OK` response in native Chat.
The user also confirmed text appearing incrementally in a separate manual streaming scenario.
A manual tool run was also confirmed by a screenshot: `shell` and `pwd` cards, the `pwd` command in the extension directory,
a result with `status: completed`, `exit: 0`, and a response with the correct working directory.
The user confirmed stopping during generation and a successful subsequent request in the same session (`AFTER_STOP_OK`).
Restoring a saved session after **Developer: Reload Window** was also confirmed: the previous conversation and another `RESTORE_TEST_42` response.
The user confirmed explicit rejection through the permissions Quick Pick for `pwd` with a temporary project-level `ask` rule.
These are manual confirmations, not automated UI tests. Explicit approval
and recovery after a full editor restart have not yet been confirmed.
These observations predate the TypeScript/build migration and do not automatically confirm native UI with the new bundles.
The participant is registered with ID `opencode`, matching the session type, and routes native Send to the same ACP handler as the content provider.
`opencode acp` launches a private server rather than connecting to a shared background service.

Attachments, OpenCode model/agent pickers, importing all existing sessions, deletion, fork, and integrating file changes with VS Code Undo are not yet implemented.
OpenCode itself makes file changes. The extension displays the tool but does not apply its changes a second time.
The extension does not provide ACP filesystem/terminal capabilities and is not a sandbox for OpenCode.
OpenCode permission settings still apply: a request appears only if OpenCode asks for permission.

## Transport and limits

Stable SDK `client()` / `ndJsonStream()` handles NDJSON parsing/serialization, JSON-RPC IDs, and correlation over stdio.
The adapter manages the child process, deadlines, fail-closed behavior, and resource cleanup; `Sessions` manages application state and permission/cancel policy.
Invalid JSON/envelopes, limit violations, write errors, and unexpected EOF close the shared connection and settle pending requests.
Ordinary ACP requests have a 30-second deadline; `session/prompt` has no overall deadline. A timeout closes the connection and process, affecting its other sessions.
Each incoming message is limited to 16 MiB of **bytes**; the previous JS buffer-length limit in UTF-16 is not equivalent to this bound.
After stdout EOF, the adapter waits no more than 100 ms for process termination to obtain the exit code/signal; if the process is still alive, it reports unexpected EOF and starts cleanup. Later exit context in the original error is not guaranteed.

## Checks

```bash
cd "$HOME/Documents/trash/opencode-vscode"
npm ci
npm run check-types
npm test
npm run check
```

`npm test` first builds bundles through `pretest`; `npm run check` first builds and type-checks through `precheck`.
Check verifies the syntax of bundles and remaining JS/CJS tests, the manifest, and launch/tasks JSON, but not editor compatibility.
Tests use the Node.js built-in runner and a real child ACP fixture process, without an LLM, API keys, or a separate test framework.
The VS Code boundary double in unit tests does not prove compatibility with the real editor.

Before running a single file directly, update the bundles:

```bash
npm run build
node --test test/extension.test.js
```

Historical baseline: `editing a completed native request replaces its turn instead of appending another` required unsupported replacement of a completed turn (before migration: 41 pass / 1 fail; SDK migration before aggregate review fixes: 86 total / 85 pass / 1 fail). After the user's separate decision to temporarily prohibit editing, this test was replaced with checks for rejection without changing ACP history, ordinary new Send, and saved/untitled/direct handler protection. This changes the user contract; it does not implement replacement through the SDK.

Before launching through the CLI, run `npm run build`; F5 builds the extension automatically.
Run the real API smoke test with the **Native API smoke test** configuration or this command:

```bash
code --new-window \
  --user-data-dir="$HOME/Documents/trash/opencode-vscode/test/.editor-profile" \
  --extensions-dir="$HOME/Documents/trash/opencode-vscode/test/.editor-extensions" \
  --extensionDevelopmentPath="$HOME/Documents/trash/opencode-vscode" \
  --extensionTestsPath="$HOME/Documents/trash/opencode-vscode/test/editor-smoke.cjs" \
  --enable-proposed-api=local.opencode-native-chat \
  "$HOME/Documents/trash/opencode-vscode"
```

The smoke test checks activation, registration, and execution of the open command, but does not send a prompt or launch OpenCode.
In VS Code 1.140.0, `activeChatPanelSessionResource` returns only Local sessions, so it is not suitable for verifying OpenCode.
Actual opening of an external session is checked separately through the renderer log: `ChatWidget#firstRender: session=opencode:/…`
and `[ChatViewPane] loadSession done … uri=opencode:/…`. Successful command execution alone is not enough.
CLI extension tests use in-memory storage and do not inherit saved folder trust.
If the editor asks for Workspace Trust, the test waits up to three minutes: run **Workspaces: Manage Workspace Trust**
and trust only the current folder in the test window itself. The user makes the decision; the test does not set trust or disable protection.

Final automated verification of the TypeScript/build migration after review fixes and separating independent scenarios: 59 pass / 1 fail, including 18 new boundary tests; the original replacement baseline is preserved. The full suite is not green.
Automated SDK migration verification before aggregate review fixes: build, strict type-check, and check pass; `npm test` reports 86 total / 85 pass / 1 previous replacement fail.
Historical result after aggregate review fixes: optional structured tool content fields were preserved in live/history and independent `session/load` replay; the session-info callback is tested separately. There were 90 tests at that point. Clean `npm ci`, build, strict types, check, and audit passed; focused regressions were 6/6.
Historical `npm test` under heavy host load: 90 total / 83 pass / 6 fail / 1 cancelled; besides the replacement baseline, five previous transport tests did not receive the fixture within their short deadline, and another scenario reached its test timeout. Sequential run `node --test --test-concurrency=1 test/*.test.js`: 90 total / 86 pass / 4 fail, with no cancelled/skipped/todo; the baseline and three short transport deadlines remained. Diagnostics with the previous ordinary 30 s deadline confirmed the expected invalid-ID/EOF/byte-limit errors. Original assertions/deadlines were preserved; a fresh rerun is below.
Before the current stage, the smoke test and native UI had not been run with bundles after the TypeScript/build and SDK migrations. No model was run, and Trust and credentials were not changed; the historical confirmations above do not replace verification of the new bundles.

Fresh run on October 5 before prohibiting edit/Retry: 90 total / 89 pass / 1 replacement fail, with no cancelled/skipped. Previous transport deadline failures did not recur; deadlines and assertions were not weakened. The final automated run after the prohibition, review regressions, and the smoke entry-point fix: **101/101 pass**, with no cancelled/skipped/todo; `npm run check` with build, strict types, and syntax/manifest/launch/tasks passed. The multi-turn regression checks a matching first turn and a shortened/modified second turn; ordinary identical Send and continuation after replay are tested separately.

The October 5 CLI smoke test found a bug in the runner itself: VS Code 1.140.0 calls `run(testPath, callback)`, but the previous smoke test treated the path as an API and failed on `workspace.isTrusted`. String detection and loading host `vscode` were fixed; a new unit test first reproduced the same TypeError, then passed. A rerun with a new isolated profile, `test/.editor-profile/smoke-20261005`, reached the Trust wait but failed with `[waitForWorkspaceTrust] Trust was not granted within 180000ms`: manual trust was not granted. The smoke success marker and opening `opencode:/…` were not confirmed. A CLI exit code without a smoke success marker does not mean a successful smoke test. Workspace Trust remains the user's decision; no model was run.

The next October 5 rerun in VS Code 1.140.0 after manual Workspace Trust **succeeded**: `OpenCode native API activation and open command passed`. The renderer log for run `20261005T111407` separately confirmed `ChatWidget#firstRender: session=opencode:/untitled-… items=0` and `[ChatViewPane] loadSession done … uri=opencode:/untitled-…`. Activation of the new bundles, the command, and actual opening of an empty external session were verified. No prompt or ACP process was started; model response, streaming, tools, permissions, Stop, and recovery require a subsequent manual run without `--extensionTestsPath`.

A subsequent manual run on a clean profile exposed the absence of **OpenCode (configured)**: renderer log `20261005T111551` confirmed provider registration and opening `opencode:/…`, but not resolution of this vendor's catalog. Based on the public 1.140.0 source, explicit discovery of only `opencode` was added during activation. A new unit test first confirmed the absence of discovery, then passed; waiting for incomplete discovery and forwarding its error with cleanup were also tested. The fresh full suite **103/103 pass** and `npm run check` succeeded. After **Developer: Reload Window**, the user confirmed that the model appeared; the renderer log separately contains `[LM] Resolved language models for vendor opencode` with `name: "OpenCode (configured)"`, `targetChatSessionType: "opencode"`, and selection `opencode/configured`. This is native evidence for the catalog, not a model response; the previous smoke test refers to the build before this additional change.

After the discovery fix, on October 5 the user confirmed the **`NATIVE_CURRENT_OK`** response to a text request without tools in native Chat with the new bundles. This confirms real Send and a response through the model bridge/ACP after the TypeScript/SDK migrations. This check does not confirm incremental streaming, tools/permissions, Stop, recovery, or the edit/Retry prohibition in UI.

With the next request in the same session, on October 5 the user confirmed **text appearing incrementally** in response to a request for 30 short tips without tools. This is a separate manual confirmation of incremental streaming with the new bundles and an ordinary subsequent Send after a completed turn.

Then, on October 5 the user confirmed a successful **`pwd` through shell with one-time approval in Quick Pick** scenario, with a tool card and a result showing the project's working directory. The temporary pwd-only `ask` rule in `opencode.jsonc` remained in place. This manually confirms tools and explicit Allow with the new bundles; Reject, Escape, and Stop while waiting for permission are checked separately.

In a separate repeated `pwd` request, on October 5 the user confirmed a successful **explicit Reject in Quick Pick** check: rejection does not execute the command. Escape and Stop while waiting for permission have not yet been checked with the new bundles.

On October 5 the user rejected the next separate `pwd` request by dismissing Quick Pick with **Escape**, without executing the command. Afterwards, the user confirmed the **`AFTER_ESCAPE_OK`** response to an ordinary new Send in the same session. This manually confirms fail-closed dismissal and continuation afterwards with the new bundles.

On October 5 the user confirmed **Stop during incremental streaming** of a long response without tools: generation stopped, and the next request in the same session returned **`AFTER_STOP_CURRENT_OK`**. Cancellation while waiting for permission remains a separate scenario.

In a separate scenario, on October 5 the user pressed **Stop while the permission Quick Pick was open**, without selecting approval: the user confirmed Quick Pick closure and no execution of `pwd`. The next ordinary Send returned **`AFTER_PERMISSION_STOP_OK`**. This manually confirms cancellation of a pending permission and continuation with the new bundles.

After **Developer: Reload Window**, on October 5 the user opened the same saved OpenCode session, confirmed that the previous conversation was visible, and received **`RESTORED_CURRENT_OK`** on a new request. This is native confirmation of `session/load`/continuation after reloading the new bundles; a full restart of the isolated editor instance is checked separately.

After a suggestion to check edit/Retry, the user asked to leave the current implementation as is for now. Further manual testing stopped. The remark "it works" does not specify Edit availability or the Retry result, so the native prohibition of these operations and a full restart are not marked as verified. The temporary pwd-only `ask` rule in `opencode.jsonc` remains for now; cleanup is a separate unfinished item, and global settings were not changed.

For manual verification, use the first CLI example **without** `--extensionTestsPath`, with isolated profile/extensions directories.
Grant Workspace Trust manually in the editor window, only for the selected folder. After rebuilding, run **Developer: Reload Window**.
For the new bundles:

- [x] Native API smoke: activation and opening a session, without a prompt; renderer evidence on October 5.
- [x] Response in native Chat with the new bundles: the user confirmed `NATIVE_CURRENT_OK` on October 5 after the discovery fix.
- [x] Incremental streaming in native Chat with the new bundles: the user confirmed text appearing incrementally on October 5.
- [x] Real tool card and explicit one-time approval in Quick Pick: the user confirmed successful `pwd` on October 5.
- [x] Explicit rejection in the permission Quick Pick with the new bundles: the user confirmed the Reject scenario on October 5.
- [x] Escape in the permission Quick Pick with the new bundles and subsequent Send: the user confirmed no command execution and `AFTER_ESCAPE_OK` on October 5.
- [x] Stop during a response and a successful subsequent request: the user confirmed `AFTER_STOP_CURRENT_OK` on October 5.
- [x] Stop while waiting for permission and a successful subsequent request: the user confirmed Quick Pick closure, no execution of `pwd`, and `AFTER_PERMISSION_STOP_OK` on October 5.
- [x] Window reload, visible history preservation, and continuation of the same session: the user confirmed `RESTORED_CURRENT_OK` on October 5.
- [ ] Full restart of the isolated editor instance and continuation of the saved session.
- [ ] Native UI for the temporary editing/Retry prohibition; handler regressions are confirmed separately by unit tests.

Startup errors appear in Chat. Process stderr is available in the **OpenCode Native Chat** Output channel; check logs for secrets before sharing them.

Plans for the next stages: [map](docs/plans/README.md), [model and reasoning selection](docs/plans/04-model-and-reasoning.md). Backend model/effort selection is not yet implemented; it is a separate stage, not part of the current editing prohibition.

## Contract sources

- Vendored `types/vscode*.d.ts` files come from the public VS Code 1.140.0 tag; the full upstream MIT notice is preserved unchanged in [types/LICENSE.vscode.txt](types/LICENSE.vscode.txt), from [LICENSE.txt 1.140.0](https://raw.githubusercontent.com/microsoft/vscode/1.140.0/LICENSE.txt). This is attribution for Microsoft's declarations, not a license assignment for the project's own code.
- [VS Code proposed API](https://code.visualstudio.com/api/advanced-topics/using-proposed-api)
- [chatSessionsProvider 1.140.0](https://github.com/microsoft/vscode/blob/1.140.0/src/vscode-dts/vscode.proposed.chatSessionsProvider.d.ts)
- [Native chatSessions registration](https://github.com/microsoft/vscode/blob/1.140.0/src/vs/workbench/contrib/chat/browser/chatSessions/chatSessions.contribution.ts)
- [Session-scoped model metadata (`chatProvider`) 1.140.0](https://github.com/microsoft/vscode/blob/1.140.0/src/vscode-dts/vscode.proposed.chatProvider.d.ts)
- [Copilot CLI model provider 1.140.0](https://github.com/microsoft/vscode/blob/1.140.0/extensions/copilot/src/extension/chatSessions/copilotcli/node/copilotCli.ts)
- [OpenCode V2 ACP](https://opencode.ai/v2/docs/cli/acp/)
- [ACP v1](https://agentclientprotocol.com/protocol/v1/overview)
- [SDK 1.7.0: package and peer dependency](https://github.com/agentclientprotocol/typescript-sdk/blob/v1.7.0/package.json)
- [SDK 1.7.0: stable client](https://github.com/agentclientprotocol/typescript-sdk/blob/v1.7.0/src/acp.ts) and [NDJSON stream](https://github.com/agentclientprotocol/typescript-sdk/blob/v1.7.0/src/stream.ts)

The SDK is distributed under Apache-2.0, and `zod` under MIT. Before distributing bundles/VSIX, include the corresponding license texts and attribution notices from the installed packages; bundling does not remove these requirements. Packaging and distribution were not verified in this migration.

Do not publish the extension to Marketplace with proposed APIs. A local run does not install the extension globally or change user settings.
