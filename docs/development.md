# Development notes

Technical reference and verification history for OpenCode Native Chat. For setup and everyday use, see the [project README](../README.md).

Historical results below apply to the builds and scenarios explicitly named. They do not establish native UI compatibility or release readiness for later changes.

## Requirements

- VS Code 1.140.0 or a compatible Insiders build. The API was verified against the 1.140.0 source; proposed APIs may change.
- An installed OpenCode V2 with `opencode acp` and configured provider authentication.
- An open, trusted local folder. For a multi-root workspace, the extension asks you to choose a working directory.
- Native VS Code Chat must be enabled. The extension does not require a Copilot subscription, but it does not replace the editor's chat infrastructure.

Development requires Node.js and npm: `npm ci` installs the TypeScript/esbuild tools and runtime dependencies pinned in the lockfile.
The `src/*.ts` source files are checked in strict mode and built into CommonJS bundles in `dist/`.
The thin `src/main.ts` entry point loads the VS Code API; the editor runs `dist/main.js`, and unit tests run the other three bundles.
Runtime dependencies are pinned exactly: `@agentclientprotocol/sdk@1.7.0`, `zod@3.25.76`, `yaml@2.9.1`, and `jsonc-parser@3.3.1`.
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
EXTENSION_DIR="$(pwd)"
code --new-window \
  --user-data-dir="$EXTENSION_DIR/test/.editor-profile" \
  --extensions-dir="$EXTENSION_DIR/test/.editor-extensions" \
  --extensionDevelopmentPath="$EXTENSION_DIR" \
  --enable-proposed-api=RabbitShare.opencode-native-chat \
  /absolute/path/to/your/project
```

If Stable rejects the proposed API, use `code-insiders` with the same arguments.
Microsoft officially recommends Insiders for proposed APIs. The Stable 1.140.0 source also explicitly allows enabling them by ID with this flag.

In the window that opens, run **OpenCode: New Native Chat Session** from the Command Palette. After cwd selection, the command creates an empty ACP session and moves it to the native Chat sidebar; generation starts only on Send.
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
- After the prompt starts, the Stop button sends ACP `session/cancel`. If the agent does not finish cancelling within 5 seconds, the connection closes. Stop before the prompt starts is described below.
- One active request per session. Cancelling a hung process may interrupt other sessions in the same process.
- `workspaceState` stores only session IDs, working directories, labels, and creation times. OpenCode stores history.
- The list includes sessions created by this extension in the current workspace, not all OpenCode sessions.
- Editing sent messages and native Retry are temporarily disabled: ACP OpenCode 2.0.21 does not replace completed turns. Send follow-ups as new messages. After a rejected edit/Retry, reopen the saved session. If editor caching prevents history from being restored, run **Developer: Reload Window** and reopen it. This recovery requires separate native UI verification.

In the manifest, `supportsCheckpoints` remains absent/false: inline checkpoint editing is not enabled. For approved dynamic slash suggestions, only `supportsPromptAttachments: true` is enabled; other attachments are not enabled. Editor commands/other entry points may remain available: the shared handler separately rejects `attempt > 0` and shortened/modified native history before sending `session/prompt`. OpenCode history is not truncated or silently moved to a new session.

OpenCode uses its own models, agents, skills, MCP, and permissions from the session directory's configuration.
Actual Model/Agent/Reasoning selection uses separate native session options described below; the standard VS Code LanguageModelChat picker remains a technical bridge, not the OpenCode catalog.
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
Historically, in a manual VS Code 1.140.0 run after adding the bridge, the user confirmed the `OPENCODE_NATIVE_OK` response in native Chat.
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

Attachments, importing all existing sessions, deletion, fork, and integrating file changes with VS Code Undo are not yet implemented.
OpenCode itself makes file changes. The extension displays the tool but does not apply its changes a second time.
The extension does not provide ACP filesystem/terminal capabilities and is not a sandbox for OpenCode.
OpenCode permission settings still apply: a request appears only if OpenCode asks for permission.

## Model / Agent / Reasoning: current implementation

After cwd selection, **OpenCode: New Native Chat Session** (`opencode.newSession`) performs one `session/new`, saves only `id/cwd/label/created`, and opens the real `opencode:/<sessionId>` in the sidebar. In VS Code 1.140.0, the route has two steps: public `vscode.open` with `preview: false` opens a Chat editor, then `workbench.action.chat.openInSidebar` moves the same session and closes the original tab. The tab may appear briefly during the move; the move command uses the active Chat editor. Standard `workbench.action.chat.open` does not accept a session URI, and New Sidebar creates a new untitled draft, so it does not replace this route. The contract was verified against the public [move actions](https://github.com/microsoft/vscode/blob/1.140.0/src/vs/workbench/contrib/chat/browser/actions/chatMoveActions.ts#L141-L162) and [widget service](https://github.com/microsoft/vscode/blob/1.140.0/src/vs/workbench/contrib/chat/browser/widget/chatWidgetService.ts#L114-L160). Before the first Send, there are no prompts, tools, or turns. Cancelling cwd selection creates no session. Inline **Model**, **Agent**, and, when choices exist, **Reasoning** are available in the new empty session. Selection is inline, not in the settings menu or a separate Quick Pick.

Standard generic draft/welcome and `opencode:/untitled-*` remain lazy: activation, bridge discovery, and the initial input-state query do not launch ACP or ask for cwd. Until materialization, these drafts use backend defaults without selecting a real session's configuration; creation occurs on the first Send. Selection before the first Send is provided through the OpenCode New command, which opens a REAL session in the sidebar.

In the selected OpenCode chat, the top **"+"** uses the same OpenCode New command so pickers are available before the first Send. The extension adds it as the first action in the proposed `chat/newSession` menu (`1_open@0`; standard New Chat has order 1); `chatSessionType == opencode` restricts the action to OpenCode, and Workspace Trust and an available cwd are required. Other chat types, explicit generic New Chat, and lazy draft commands are unchanged. The menu and primary-action selection contract was verified against the public [new actions](https://github.com/microsoft/vscode/blob/1.140.0/src/vs/workbench/contrib/chat/browser/actions/chatNewActions.ts#L68-L127), [menu extension point](https://github.com/microsoft/vscode/blob/1.140.0/src/vs/workbench/services/actions/common/menusExtensionPoint.ts#L555-L560), and [split button](https://github.com/microsoft/vscode/blob/1.140.0/src/vs/platform/actions/browser/menuEntryActionViewItem.ts#L471-L481) source. Unit verification of the manifest/adapter does not prove the actual primary action in the editor.

- The catalog and selected values come from confirmed ACP `configOptions` in `session/new`, `session/load`, `config_option_update`, and the `session/set_config_option` response. Each valid snapshot replaces the entire previous one, including an empty catalog.
- Raw guards validate consumed fields and unique config/group/value IDs before SDK optional normalization; flat or single-level grouped choices are allowed. A malformed present catalog is rejected atomically; a malformed update preserves the previous snapshot. Absent/null new/load means an empty catalog. Provider extras and `_meta` do not become trusted UI fields.
- Model uses `configId: "model"`, Agent uses `"mode"`, and Reasoning uses `"effort"`. Literal values from current options are sent to ACP: model IDs with additional `/`, agent names, and effort are not parsed or replaced with fixed lists. Reasoning means effort/variant, not enabling/hiding `agent_thought_chunk` text.
- The UI shows backend-confirmed `currentValue`, not optimistic success. A current value missing from a nonempty catalog is shown as locked unavailable, without a fallback or sending a local placeholder to ACP. Model/Agent without a catalog are also unavailable. Reasoning is hidden if effort is absent or its flat/grouped choices are empty. After changing Model, the entire catalog, including Reasoning, comes from backend confirmation.
- One setter is reserved synchronously. Loading, pending config, and an active/reserved prompt lock selection; delivered busy/stale/unavailable selections are rejected with an error. Send reserves a turn and waits for an already-accepted config operation; its failure sends no prompt and adds no user history. Stop while waiting sends no `session/cancel` and does not declare an already-sent setter cancelled.
- An RPC error or malformed set response makes configuration uncertain: previous selections are cleared. A fresh `session/load` is required before a future prompt, even on the same connection. Reopen/load restores a confirmed snapshot; the old setter is not retried automatically. Replay is not forwarded to the waiting Send's stream and does not open permissions UI for old tools.

The public **VS Code 1.140.0 API has no separate per-resource catalog API**: groups are shared by session type, and selection events are broadcast. `src/session-options.ts` publishes a controller-wide union of unique groups for live REAL resources; for the current resource, it sets only its own selections and leaves foreign selections undefined. `ChatSession.options` separately returns its own selections and marker. The hidden locked `opencode_session` group with `when: "false"` contains owning tokens and `unconfigured`; REAL groups are filtered through `chatSessionOption.opencode_session`. A binding is permanently tied to the original URI, not the active tab/mutable marker. Revision-scoped local choice IDs and pending/echo observation prevent repeated setters on broadcast. This is a version-specific workaround, not proof of universal isolation for resource-less/reused renderer scopes.

The **OpenCode (configured)** bridge is still needed to convert native requests, but does not prove which ACP model is selected. Catalogs/selections are not saved in `workspaceState`; global configuration and credentials are unchanged. Skills, MCP, and permissions remain with OpenCode.

**Automated status on October 5, 2026:** the backend and native adapter are implemented; after strengthening review regressions and the menu follow-up, `npm test` reports **152/152 pass**, with no fail/cancelled/skipped; `npm run check` with build, strict types, and syntax/manifest/launch/tasks passes. The fixture and boundary double test literal values, isolation, ordering, recovery, and lazy/eager routes, but not native rendering. Final reviews of the main implementation, requirements, security, documentation, and tests are complete; test-review findings were closed in a separately verified follow-up. Separate Standards/Spec/security/test reviews of the menu follow-up are complete; priority, gating, and icon tests were also verified with six in-memory mutations. Release readiness is not claimed without native evidence.

**Native evidence for the new feature remains incomplete.** After the sidebar follow-up, the user confirmed the chat/selection through OpenCode New and reported missing pickers when using the top "+"; the menu follow-up fixes this separate route but has not yet been checked by the user. This is a narrow manual observation, without a confirmed backend trace, exact version/build correlation, or completion of the entire checklist. All manual observations in the following sections are historical: before Model/Agent/Reasoning and eager New. The current modified smoke test has also not yet been run in the editor. After separate agreement, verification requires official VS Code 1.140.0 with isolated profile/extensions directories and manual Trust, without changing credentials or real model prompts to check configuration:

- [ ] Eager New: one new with the selected cwd, the same REAL session in the sidebar, and inline pickers before Send; the original tab is closed, the marker hidden, and prompts/tools/turns absent; cancelling cwd opens nothing. Repeat from a regular editor and another Chat editor; separately check focus changes during two-step opening.
- [ ] Top "+" in OpenCode Chat: OpenCode New is the primary action, with the same eager/sidebar semantics and pickers before Send after cwd selection. In Local/other chat types, "+" remains standard; also check transition from a generic OpenCode draft, reload, and menu/Trust gating.
- [ ] A/B side by side with the same cwd and, separately, multi-root with different cwd: own catalogs/selections, switching/refresh/close/reopen without another session's setter or duplicates.
- [ ] Generic draft/welcome after A/B: no foreign visible REAL groups, setter/new/cwd dialog before Send; check the first Send only with a separately approved controlled fixture run.
- [ ] Confirmed literal model/mode/effort, hiding absent/empty effort, locked unavailable without fallback. Picker labels and the text "which model are you?" are not confirmation.
- [ ] Controlled pending/Send/Stop and a failing setter: response before prompt, zero prompt/history append on error, zero cancel before prompt starts; active prompt lock and subsequent unlocking.
- [ ] Uncertain recovery, Reload, and full restart: fresh load snapshot without old setter replay or duplicated history/tools/approval; storage contains metadata only. A narrow permission-reject/Stop regression with the new bundles is separate.

The verification record must connect build/editor/backend versions and URI/sessionId/cwd to the visual result and a safe trace of the accepted backend response/update. For real OpenCode without generation, the exact setter and matching confirmed full `configOptions` are required, not only an outbound request; agree on the trace source separately. A controlled fixture in the native editor tests routing/ordering, but not real OpenCode persistence or inference. Do not publish prompts, credentials, or tool payloads; explicitly state any missing multi-root/reused-scope/restart evidence.

## Slash commands: dynamic suggestions

The extension receives the list from ACP **`available_commands_update`** after new/load and when commands change. The catalog is stored separately for each session, validated atomically before optional salvage, and does not enter history or `workspaceState`. A new valid list replaces the previous one; an empty list clears it; a malformed update leaves the previous snapshot. Stale commands are cleared when the connection is lost and a fresh load starts. Contract source: [OpenCode V2 ACP, Commands](https://opencode.ai/v2/docs/cli/acp/#commands). These are ACP commands, not the full set of terminal UI actions.

Native UI uses the proposed **`chatSessionCustomizationProvider`**: the provider returns Prompt items for a specific session URI. VS Code reads this list when `/` is typed. Each item points to a read-only virtual `opencode-command:/…prompt.md` containing only a name, with no instructions, tools, model/agent metadata, or body. Files exist in extension memory; nothing is written to the project. Registration is limited to session type `opencode`; there is no separate Commands button or Quick Pick. Public 1.140.0 source: [proposal](https://github.com/microsoft/vscode/blob/1.140.0/src/vscode-dts/vscode.proposed.chatSessionCustomizationProvider.d.ts), [catalog projection](https://github.com/microsoft/vscode/blob/1.140.0/src/vs/workbench/contrib/chat/common/customizationHarnessService.ts#L592-L625), [native completion gate](https://github.com/microsoft/vscode/blob/1.140.0/src/vs/workbench/contrib/chat/browser/widget/input/editor/chatInputCompletions.ts#L247-L289).

In 1.140.0, this completion provider requires **`supportsPromptAttachments: true`**. The user approved the change: this is the only enabled capability; checkpoints/edit/Retry and file/tool/MCP attachments remain disabled. Runtime accepts only live issued virtual command references belonging to its session. External user prompt files and foreign/forged/stale references are rejected before ACP Send, rather than silently imported or ignored. References are checked again after waiting for config/load and asynchronously reading the template, before adding a turn and sending a prompt. Virtual file content is not sent to ACP; on Send, the extension expands a local text template and sends an ordinary text prompt without a slash prefix. The old `request.command`/`request.prompt` split is also supported, including the native history guard.

### Local template expansion

In OpenCode **2.0.21**, a known slash command ends the ACP turn after accepting the command, before the model responds: [preparation/sending](https://github.com/anomalyco/opencode/blob/v2.0.21/packages/cli/src/acp/service.ts), [streamTurn](https://github.com/anomalyco/opencode/blob/v2.0.21/packages/cli/src/acp/event.ts). User observation: the live response is empty; after Reload, the expanded request and saved response are visible. The approved workaround is implemented in `src/command-templates.ts`: the extension does not invoke this branch, repeat the command, poll history, or restart the shared process.

- **The catalog and template are different sources.** `/` names/descriptions still come only from ACP. Before sending, the name must remain advertised in the current session; an unknown or removed command is rejected without history append or `session/prompt`.
- **Automatic local sources**, from lower to higher priority: `OPENCODE_CONFIG_DIR` or `${XDG_CONFIG_HOME:-~/.config}/opencode` (JSON, JSONC, then `command/` and `commands/`); explicit `OPENCODE_CONFIG`; direct `opencode.json(c)` files from the filesystem root to the session cwd; `.opencode/` in the same ancestors (JSON/JSONC, then Markdown); `OPENCODE_CONFIG_CONTENT`. JSONC follows JSON; plural `commands/` follows legacy `command/`. JSON fields `commands` and legacy `command` are supported; a canonical entry wins over a same-named legacy entry. Relative `OPENCODE_CONFIG` is resolved from the child ACP process cwd, not the active editor. Sources and order were verified against [discovery](https://github.com/anomalyco/opencode/blob/v2.0.21/packages/core/src/config/discovery.ts), [configuration entries](https://github.com/anomalyco/opencode/blob/v2.0.21/packages/core/src/config.ts), and [command plugin](https://github.com/anomalyco/opencode/blob/v2.0.21/packages/core/src/config/plugin/command.ts).
- Only the requested `.md` and standard config files are read; there is no disk scan. Nested names correspond to relative paths, for example `team/review.md` for `/team/review`; native suggestions may hide such names. Each Send rereads sources **after** config/load waits; changing a supported template does not require an extension Reload. A new suggestion appearing depends on a new ACP advertisement.
- If there is no standard definition, **`opencodeNativeChat.commandTemplateDirectories`** specifies additional Markdown directories. Relative paths are resolved from the session cwd; nesting corresponds to the name. This is a fallback, not an override of standard sources or a way to add a command to the ACP catalog. Multiple matches are rejected as ambiguous.
- YAML frontmatter is removed; empty frontmatter is allowed. Only `description` and a text body are allowed; a JSON entry allows `description` and `template`. `$ARGUMENTS` is substituted as literal user input; `$1`, `$2`, … use quoted arguments, and the last number receives the remainder joined with spaces. Without placeholders, nonempty arguments are appended after a blank line. Substitution is single-pass: `$1`/`$ARGUMENTS` inside the arguments themselves are not expanded again. The `yaml` **2.9.1** and `jsonc-parser` **3.3.1** parsers were approved by the user and are included in CommonJS bundles: jsonc-parser through its ESM entry point, yaml through its Node CJS export.
- **Unsupported:** `agent`, `model`, `subagent`/`subtask`, other metadata; shell substitutions `!\`…\``; `{env:…}`/`{file:…}`; YAML aliases; an empty template; a result starting with `/`. A parse error or unsupported definition does not fall back to another command or send the original slash string. The source, arguments, and assembled prompt are limited to **256 KiB UTF-8**. Arguments are validated before tokenization; output size is checked by fragments before joining, and repeated placeholders do not recompute the remainder. Parser/IO errors do not expose file contents or arguments. The extension executes nothing from the template; the text "do not use tools" remains a model instruction, not sandbox policy.
- Commands from plugins, MCP, remote/well-known, and other dynamic sources without a supported local definition are rejected. ACP does not provide provenance/template information and cannot verify whether a plugin overrode a same-named local command: there is no full equivalence with OpenCode command execution. Built-in `/compact` without a local text template is also unavailable through this workaround; a fixture command with this name does not prove real compaction.
- **History:** while the record is live, a pair of the original native slash input and sent text is stored in memory. Native history shows the original input; the guard compares it with the saved pair and does not expand the old template again. Pairs are not written to `workspaceState`. A fresh `session/load`, including Reload/restart, restores text saved by OpenCode without the original slash input. After recovery with previous native history, consistent history must be reopened/reloaded; a mismatch does not permit edit/Retry. Model/Agent/Reasoning, permissions, and active Stop retain the ordinary ACP lifecycle. The turn is already reserved while reading the template; Stop before RPC adds no turn and sends no cancel.

**Automated checks on October 7, 2026:** `npm test` reports **261/261 pass**; `npm run check` (build, strict types, syntax/manifest/launch/tasks) and `git diff --check` pass. RED was observed for the missing implementation, transport forwarding instead of expansion, boundary scenarios, oversized arguments/placeholder amplification, and empty frontmatter; GREEN includes source precedence, literal arguments, changed/deleted templates, adapter cwd isolation and relative fallback, revocation during reading without references, exact/+1 UTF-8 output bounds, fresh history replay, busy/Stop before RPC, and the edit/Retry prohibition. Amplification is tested in a separate child with a heap limit/deadline so RED does not crash the runner. Ordinary template tests prohibit file reads outside the repo but use real fixtures inside it. Scoped Standards/Spec/Security/Test reviews after fixes concluded with `approved`; independent in-memory mutations removing the output bound or final advertisement guard and substituting adapter cwd now cause the corresponding RED, while unmutated checks are GREEN. This is a real child fixture without a model plus a VS Code double, **not native live-fix evidence**. Real model prompts were not run automatically. After build and Developer: Reload Window, the user separately checks `/aw-just-answer`, incremental streaming, permissions/Stop, and the next ordinary Send; release approval is not claimed.

**Limits:**
- Suggestions are available after **OpenCode: New Native Chat Session** or materialization of the first Send. An empty generic draft does not launch ACP for the catalog and has no dynamic list before the first Send.
- Only names containing letters, ASCII digits, `_`, `.`, and `-` are suggested. Native completion in 1.140.0 replaces `:` with spaces; `/` and other unsupported characters are not inserted losslessly. Such names remain in the backend catalog but are hidden from suggestions, with the reason logged to Output. Manual input requires a supported local name/template; `:` and traversal segments are rejected. The extension does not rename commands.
- Global native names `clear`, `models`, `debug`, `fork`, and `vscode-pet` are not published as ACP suggestions: the [parser](https://github.com/microsoft/vscode/blob/1.140.0/src/vs/workbench/contrib/chat/common/requestParser/chatRequestParser.ts#L231-L241) gives them priority over customization. Typing these names manually may also execute an editor action instead of an OpenCode command. Builtins limited to other session types do not block same-named ACP commands.
- The catalog is limited to 512 commands; names to 256, descriptions to 8192, and input hints to 2048 UTF-16 code units. Projection JSON is limited to 256 KiB UTF-8; the shared temporary notification buffer before a new response is limited to 1 MiB and 128 unknown IDs. Exceeding a limit is rejected in full, without truncating or replacing the previous valid catalog. Limits protect native completion from data-volume amplification relative to the ACP transport limit.
- Unknown commands and commands without a supported local template are rejected before the prompt. Expanded commands use the model; real runs require separate agreement.

**Automated verification history:** the static `/compact` slice on October 5, 2026 had initial RED/GREEN 7, focused GREEN 11/11 after separating scenarios, and a full suite of 163/163. This static manifest entry was replaced with a dynamic source to avoid duplicating `/compact` or promising it without ACP advertisement. The dynamic slice on October 6 had backend RED 4, adapter RED 6, reference guard RED 4, and an initial full suite of 179/179. After review, fixes for URI scope/pre-send race/native collisions, limits, and separating independent tests, final `npm test` reports **214/214 pass**, with no fail/cancelled/skipped. In-memory mutation checks removing fresh/failed-load clearing or pre-send validation cause the corresponding regressions to fail. Standards/Spec/Security/Test findings are closed; this does not grant native/release approval. The fixture/API double test the catalog, literal payload, and history/permission guards, **not native rendering or real compaction**.

**Manual confirmation on October 6:** after updating the extension, the user replied "they appeared" when checking `/` suggestions. This confirms suggestions appearing in native UI, but not the specific catalog contents, command execution, or the remaining scenarios below.

The next user screenshot shows the selected native `/aw-just-answer` suggestion and the argument text `how do I make a television?` in the input field. The name and arguments are displayed without distortion before Send. The screenshot does not prove the ACP payload or command execution; file context `extension.ts` is also visible above, but file-attachment support is not enabled.

- [x] Dynamic `/` suggestions appearing in native UI — confirmed by the user.
- [ ] Specific `/compact` and a user command in REAL OpenCode Chat; no ACP suggestions in other session types.
- [ ] Dynamic addition/removal, A/B and multi-root isolation; lazy generic draft before the first Send and its materialized alias after Send.
- [x] Selecting `/aw-just-answer` and preserving the visible name/arguments without Send — user screenshot.
- [ ] Read-only preview of the virtual file.
- [ ] Separately approved real OpenCode `/compact`, subsequent ordinary Send, recovery after Reload/restart, and preservation of the edit/Retry prohibition.

## Transport and limits

Stable SDK `client()` / `ndJsonStream()` handles NDJSON parsing/serialization, JSON-RPC IDs, and correlation over stdio.
The adapter manages the child process, deadlines, fail-closed behavior, and resource cleanup; `Sessions` manages application state and permission/cancel policy.
Invalid JSON/envelopes, limit violations, write errors, and unexpected EOF close the shared connection and settle pending requests.
Ordinary ACP requests have a 30-second deadline; `session/prompt` has no overall deadline. A timeout closes the connection and process, affecting its other sessions.
Each incoming message is limited to 16 MiB of **bytes**; the previous JS buffer-length limit in UTF-16 is not equivalent to this bound.
After stdout EOF, the adapter waits no more than 100 ms for process termination to obtain the exit code/signal; if the process is still alive, it reports unexpected EOF and starts cleanup. Later exit context in the original error is not guaranteed.

## Checks

```bash
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
EXTENSION_DIR="$(pwd)"
code --new-window \
  --user-data-dir="$EXTENSION_DIR/test/.editor-profile" \
  --extensions-dir="$EXTENSION_DIR/test/.editor-extensions" \
  --extensionDevelopmentPath="$EXTENSION_DIR" \
  --extensionTestsPath="$EXTENSION_DIR/test/editor-smoke.cjs" \
  --enable-proposed-api=RabbitShare.opencode-native-chat \
  "$EXTENSION_DIR"
```

The smoke test checks activation and registration and directly invokes the lazy draft command `workbench.action.chat.openNewChatSessionInPlace.opencode` with `sidebar`, not eager `opencode.newSession`. It does not send a prompt or launch OpenCode. Current success marker: `OpenCode native API activation and lazy draft open command passed`; the renderer is checked separately.
In VS Code 1.140.0, `activeChatPanelSessionResource` returns only Local sessions, so it is not suitable for verifying OpenCode.
Actual opening of an external session is checked separately through the renderer log: `ChatWidget#firstRender: session=opencode:/…`
and `[ChatViewPane] loadSession done … uri=opencode:/…`. Successful command execution alone is not enough.
CLI extension tests use in-memory storage and do not inherit saved folder trust.
If the editor asks for Workspace Trust, the test waits up to three minutes: run **Workspaces: Manage Workspace Trust**
and trust only the current folder in the test window itself. The user makes the decision; the test does not set trust or disable protection.

### Historical checks before Model / Agent / Reasoning and eager New

The following results and manual confirmations refer to previous builds. The current automated status and unfinished native checklist for the new feature are above.

Historical final automated verification of the TypeScript/build migration after review fixes and separating independent scenarios: 59 pass / 1 fail, including 18 new boundary tests; the original replacement baseline is preserved. The full suite was not green then.
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
For the previous bundles after the TypeScript/SDK migrations, before Model/Agent/Reasoning:

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

Stage map: [plans](plans/README.md), [Model/Agent/Reasoning: status and original plan](plans/04-model-and-reasoning.md). The feature is implemented, automatically verified, and has passed final review; native evidence is still required. The edit/Retry prohibition remains.

## Contract sources

- Vendored `types/vscode*.d.ts` files come from the public VS Code 1.140.0 tag; the full upstream MIT notice is preserved unchanged in [types/LICENSE.vscode.txt](../types/LICENSE.vscode.txt), from [LICENSE.txt 1.140.0](https://raw.githubusercontent.com/microsoft/vscode/1.140.0/LICENSE.txt). This is attribution for Microsoft's declarations, not a license assignment for the project's own code.
- [VS Code proposed API](https://code.visualstudio.com/api/advanced-topics/using-proposed-api)
- [chatSessionsProvider 1.140.0](https://github.com/microsoft/vscode/blob/1.140.0/src/vscode-dts/vscode.proposed.chatSessionsProvider.d.ts)
- [Native chatSessions registration](https://github.com/microsoft/vscode/blob/1.140.0/src/vs/workbench/contrib/chat/browser/chatSessions/chatSessions.contribution.ts)
- [Session-scoped model metadata (`chatProvider`) 1.140.0](https://github.com/microsoft/vscode/blob/1.140.0/src/vscode-dts/vscode.proposed.chatProvider.d.ts)
- [Copilot CLI model provider 1.140.0](https://github.com/microsoft/vscode/blob/1.140.0/extensions/copilot/src/extension/chatSessions/copilotcli/node/copilotCli.ts)
- [OpenCode V2 ACP](https://opencode.ai/v2/docs/cli/acp/)
- [ACP v1](https://agentclientprotocol.com/protocol/v1/overview)
- [SDK 1.7.0: package and peer dependency](https://github.com/agentclientprotocol/typescript-sdk/blob/v1.7.0/package.json)
- [SDK 1.7.0: stable client](https://github.com/agentclientprotocol/typescript-sdk/blob/v1.7.0/src/acp.ts) and [NDJSON stream](https://github.com/agentclientprotocol/typescript-sdk/blob/v1.7.0/src/stream.ts)

The SDK is distributed under Apache-2.0, `zod` and `jsonc-parser` under MIT, and `yaml` under ISC. Before distributing bundles/VSIX, include the corresponding license texts and attribution notices from the installed packages; bundling does not remove these requirements. Packaging and distribution were not verified in this migration.

Do not publish the extension to Marketplace with proposed APIs. A local run does not install the extension globally or change user settings.
