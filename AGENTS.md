# OpenCode Native Chat

## Boundaries

- Work only in this project; `combinezone` is a different repository. Communicate with the user in Russian.
- The goal is an extension with native Chat through `chatSessionsProvider` and ACP. Webviews, a separate chat, VS Code core patches, and the built-in Agent Host are outside the chosen architecture.
- There are no new npm dependencies; package installation and compilation are not needed for development. Agree on adding dependencies with the user.
- Verify proposed API contracts against the public source of **the editor version being tested**, not `main` or files from the local VS Code installation. Links for 1.140.0 are in README.

## Request path

- `src/extension.js` is the entry point, native adapter, permissions Quick Pick, and metadata in `workspaceState`; `src/sessions.js` handles the ACP lifecycle, history, permissions, and cancellation; `src/acp.js` handles newline-delimited JSON-RPC over child-process stdio.
- Launch `opencode acp` with `shell: false`, not an HTTP client for a shared service. `opencodeNativeChat.command` is an executable path, not a command string with arguments.
- The participant ID, session type, and URI scheme must match: `opencode`. The extension ID for the CLI is different: `local.opencode-native-chat`.
- The native participant routes Send to the same `requestHandler` as the content provider. When changing routing, check both saved resources and `opencode:/untitled-*` for the first request.
- OpenCode stores history and replays it through `session/load`; `workspaceState` stores only `id`, `cwd`, `label`, and `created`. The extension's list does not import all OpenCode sessions.
- The model, agent, skills, MCP, and permissions come from OpenCode. The VS Code model selection is currently not passed to ACP.
- One process serves multiple sessions; each session allows one active prompt. Stop sends `session/cancel`; after 5 seconds, a hung connection is closed, affecting the process's other sessions.
- Preserve Workspace Trust and explicit permission choices: Escape, closing Quick Pick, and cancellation do not approve a tool. The client does not declare filesystem/terminal capabilities; the extension is not a sandbox.

## Checks

- After runtime changes: `npm test` and `npm run check`. The latter checks syntax and manifest/launch, but not editor compatibility.
- One file: `node --test test/extension.test.js`; one scenario: `node --test --test-name-pattern='session-type participant' test/extension.test.js`. Put runner flags before the file path.
- Unit tests launch a real child process, `test/fixtures/agent.cjs`, without a model, credentials, or an installed OpenCode. They replace the VS Code API with a double; this is not native UI evidence.

## Editor verification and known blocker

- For manual verification, use the **OpenCode Native Chat** configuration in `.vscode/launch.json` or the CLI command from README with `--enable-proposed-api=local.opencode-native-chat`. After editing the extension, run **Developer: Reload Window**.
- Run manual checks without `--extensionTestsPath`; isolate them with `--user-data-dir` and `--extensions-dir`. Artifacts in `test/.editor-profile/` and `test/.editor-extensions/` are excluded from Git; logs may contain prompts and secrets.
- **Native API smoke test** checks activation and the open command; it does not send a prompt. CLI extension tests use in-memory storage; the smoke test waits up to three minutes for manual Workspace Trust. Do not disable Trust or set it programmatically.
- In VS Code 1.140.0, `activeChatPanelSessionResource` returns only Local sessions. Confirm that OpenCode opened through the renderer log: `ChatWidget#firstRender: session=opencode:/…` and `[ChatViewPane] loadSession done … uri=opencode:/…`.
- `supportsAutoModel: true` unblocks Send but **does not remove** the `LanguageModelChat` requirement when converting a request in VS Code 1.140.0. `Language model unavailable` occurs before the ACP handler; do not try to fix it by reconfiguring OpenCode credentials.
- Backend responses and fixture tests do not prove native Send. An editor response, incremental streaming, real tools, approval/rejection, Stop during a response, and recovery after restart require separate observations; do not claim that the smoke test verifies them.
