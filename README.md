# OpenCode Native Chat

Experimental extension: OpenCode sessions in **native VS Code Chat** through the proposed `chatSessionsProvider` API.
No webview, separate chat, or changes to VS Code source. This is **not** a provider for the built-in Agent Host.

## Requirements

- VS Code 1.140.0 or a compatible Insiders build. The API was verified against the 1.140.0 source; proposed APIs may change.
- An installed OpenCode V2 with `opencode acp` and configured provider authentication.
- An open, trusted local folder. For a multi-root workspace, the extension asks you to choose a working directory.
- Native VS Code Chat must be enabled. The extension does not require a Copilot subscription, but it does not replace the editor's chat infrastructure.

Development requires Node.js and npm: `npm ci` installs the TypeScript/esbuild tools pinned in the lockfile.
The `src/*.ts` source files are checked in strict mode and built into CommonJS bundles in `dist/`.
The thin `src/main.ts` entry point loads the VS Code API; the editor runs `dist/main.js`, and unit tests run the other three bundles.
There are no runtime npm dependencies or ACP SDK yet: the stdio transport remains custom. A separate extension server is not needed.

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

OpenCode uses its own models, agents, skills, MCP, and permissions from the session directory's configuration.
In the first version, the model and agent come from OpenCode settings; model selection in the standard VS Code UI is not passed to ACP.
When converting a request, VS Code 1.140.0 requires a registered `LanguageModelChat`, even for an external ACP agent.
The synthetic `Auto` fallback unblocks the button, but does not by itself resolve `Language model unavailable`.
The extension registers the **OpenCode (configured)** bridge model only for `opencode` sessions through `targetChatSessionType`
and declares `requiresCustomModels: true`, `supportsAutoModel: false`. Metadata uses the proposed `chatProvider` API.
This is not a separate LLM client: the bridge does not launch OpenCode during model discovery, read credentials, or change its model.
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

Known baseline: `editing a completed native request replaces its turn instead of appending another` fails
with the original expectations (original pre-migration run: 41 pass / 1 fail). The migration does not fix replacement/resend or make the entire suite green.

Before launching through the CLI, run `npm run build`; F5 builds the extension automatically.
Run the real API smoke test with the **Native API smoke test** configuration or this command:

```bash
code --new-window \
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
The smoke test and native UI were not run with the new bundles: manual Workspace Trust and user participation were unavailable in this run.
No model was run, and Trust and credentials were not changed; the historical confirmations above do not replace verification of the new bundles.

Manual verification: open a session, get a response, check approval and rejection, cancel a request, restart the window, and continue the saved session.
Startup errors appear in Chat. Process stderr is available in the **OpenCode Native Chat** Output channel; check logs for secrets before sharing them.

## Contract sources

- Vendored `types/vscode*.d.ts` files come from the public VS Code 1.140.0 tag; the full upstream MIT notice is preserved unchanged in [types/LICENSE.vscode.txt](types/LICENSE.vscode.txt), from [LICENSE.txt 1.140.0](https://raw.githubusercontent.com/microsoft/vscode/1.140.0/LICENSE.txt). This is attribution for Microsoft's declarations, not a license assignment for the project's own code.
- [VS Code proposed API](https://code.visualstudio.com/api/advanced-topics/using-proposed-api)
- [chatSessionsProvider 1.140.0](https://github.com/microsoft/vscode/blob/1.140.0/src/vscode-dts/vscode.proposed.chatSessionsProvider.d.ts)
- [Native chatSessions registration](https://github.com/microsoft/vscode/blob/1.140.0/src/vs/workbench/contrib/chat/browser/chatSessions/chatSessions.contribution.ts)
- [Session-scoped model metadata (`chatProvider`) 1.140.0](https://github.com/microsoft/vscode/blob/1.140.0/src/vscode-dts/vscode.proposed.chatProvider.d.ts)
- [Copilot CLI model provider 1.140.0](https://github.com/microsoft/vscode/blob/1.140.0/extensions/copilot/src/extension/chatSessions/copilotcli/node/copilotCli.ts)
- [OpenCode V2 ACP](https://opencode.ai/v2/docs/cli/acp/)
- [ACP v1](https://agentclientprotocol.com/protocol/v1/overview)

Do not publish the extension to Marketplace with proposed APIs. A local run does not install the extension globally or change user settings.
