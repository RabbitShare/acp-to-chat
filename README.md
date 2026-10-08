# ACP to Chat

Use **OpenCode in VS Code's native Chat** through the Agent Client Protocol (ACP).

The extension, **OpenCode Native Chat**, connects the editor to your local `opencode acp` process. It uses your existing OpenCode configuration and credentials, with no webview, separate chat interface, or patched editor.

> **Experimental.** This project uses proposed VS Code APIs and runs as a development extension. It is not a Marketplace release or a general-purpose provider for arbitrary ACP agents.

## Features

- Create OpenCode sessions and reopen their saved conversations.
- Stream responses, reasoning, and tool activity in native Chat.
- Choose Model, Agent, and available Reasoning options from the session's OpenCode catalog.
- Discover session-specific slash commands with native `/` suggestions.
- Approve or reject tool permissions through VS Code Quick Pick.
- Stop an active response and continue the conversation.

OpenCode manages models, agents, skills, MCP servers, permissions, and conversation history. The extension supplies the native editor interface.

## Requirements

- **VS Code 1.140.0** is the compatibility baseline. Other versions, including Insiders, may need API changes.
- **OpenCode V2** with `opencode acp` and provider authentication already configured.
- **Node.js and npm** to build the extension from source.
- An open, trusted local workspace with native VS Code Chat enabled.

A Copilot subscription is not required by the extension. VS Code's native Chat infrastructure must still be available.

## Quick start

### 1. Build the extension

```bash
git clone https://github.com/RabbitShare/acp-to-chat.git
cd acp-to-chat
npm ci
npm run build
```

### 2. Launch a development window

Run this from the extension directory. Replace the final path with the project you want OpenCode to work on:

```bash
EXTENSION_DIR="$(pwd)"
code --new-window \
  --user-data-dir="$EXTENSION_DIR/test/.editor-profile" \
  --extensions-dir="$EXTENSION_DIR/test/.editor-extensions" \
  --extensionDevelopmentPath="$EXTENSION_DIR" \
  --enable-proposed-api=local.opencode-native-chat \
  /absolute/path/to/your/project
```

Use `code-insiders` instead of `code` if your editor does not permit the proposed APIs. Compatibility still depends on its API version.

Alternatively, open the extension directory in VS Code and press **F5** with the **OpenCode Native Chat** launch configuration. It builds the extension automatically. Open your target project in the resulting Extension Development Host window.

### 3. Start a conversation

1. Grant Workspace Trust only if you trust the project.
2. Run **OpenCode: New Native Chat Session** from the Command Palette.
3. Choose a working directory when prompted. The extension opens an empty session in the Chat sidebar.
4. Select the available session options, enter a message, and press **Send**.

Creating a session does not generate a response; generation starts on Send. The top **+** in OpenCode Chat uses the same New Session action.

## Configuration

If VS Code cannot find OpenCode, set its executable path:

```json
{
  "opencodeNativeChat.command": "/absolute/path/to/opencode"
}
```

This setting accepts an executable path, not a shell command or arguments. The extension adds `acp` itself. Configure provider authentication in OpenCode before using the extension.

### Model / Agent / Reasoning: current implementation

The inline selectors use values confirmed by OpenCode for the current session. Reasoning is hidden when the backend offers no effort choices. Selectors are locked while a response or configuration change is pending.

The standard VS Code model entry **OpenCode (configured)** is a compatibility bridge, not the actual backend model selector. If VS Code reports `Language model unavailable`, check that this entry is available; changing OpenCode credentials will not fix an editor-side bridge problem.

Generic empty drafts remain lazy and use backend defaults until the first Send. Use **OpenCode: New Native Chat Session** when you want selectors before sending a message.

See [session configuration details and the native verification checklist](docs/development.md#model--agent--reasoning-current-implementation).

### Slash commands: dynamic suggestions

Type `/` in a materialized OpenCode session to see commands advertised by its ACP backend.

The extension currently expands supported local Markdown, JSON, and JSONC text templates before sending them. This works around an OpenCode ACP command-streaming issue; it is not equivalent to every OpenCode command source. Unknown commands, missing templates, and unsupported metadata are rejected rather than silently executed.

Additional Markdown template directories can be configured with `opencodeNativeChat.commandTemplateDirectories`. Relative paths use the session's working directory. This is a fallback for local definitions; it does not add commands to the advertised catalog.

See [supported template sources, substitutions, and restrictions](docs/development.md#local-template-expansion).

## Limitations and safety

- Editing sent messages and native **Retry** are disabled. Send a new message instead. After a rejected edit, reopen the saved session; if necessary, run **Developer: Reload Window** first.
- File attachments, importing all existing OpenCode sessions, session deletion, fork, and integration with VS Code Undo are not implemented.
- The session list contains sessions created by this extension in the current workspace, not your entire OpenCode history.
- Tool permission prompts appear only when OpenCode requests approval. Escape, dismissal, and cancellation never approve a tool.
- OpenCode executes tools and changes files with its own permissions. **The extension is not a sandbox.**
- Session selectors, the New Session action, and recovery still have incomplete native UI verification. Automated tests do not establish compatibility with every editor build.

### Transport and limits

The extension launches a private OpenCode process over stdio. One process can serve multiple sessions, with one active request per session. A transport timeout or forced shutdown of a hung cancellation can interrupt other sessions in that process.

Only session metadata is stored in VS Code workspace state; OpenCode stores conversation history. Process diagnostics appear in the **OpenCode Native Chat** Output channel. Review logs for secrets before sharing them.

See [transport policy and resource limits](docs/development.md#transport-and-limits).

## Development

### Checks

```bash
npm test
npm run check
```

These commands build the extension, run fixture-based unit tests, and check strict TypeScript, syntax, and editor configuration files. Tests do not require a model, API keys, or an installed OpenCode. The VS Code API is replaced by a test double; native UI checks are separate.

After changing source files, rebuild and run **Developer: Reload Window** in the development host.

### Contract sources

The integration targets public VS Code 1.140.0 proposed API declarations and ACP v1. Proposed APIs can change between editor releases.

- [Development reference, contract sources, and verification history](docs/development.md)
- [Development plans](docs/plans/README.md)
- [VS Code 1.140.0 session API declarations](https://github.com/microsoft/vscode/blob/1.140.0/src/vscode-dts/vscode.proposed.chatSessionsProvider.d.ts)
- [VS Code proposed API guidance](https://code.visualstudio.com/api/advanced-topics/using-proposed-api)
- [Agent Client Protocol](https://agentclientprotocol.com/protocol/v1/overview)

Do not publish this proposed-API extension to Marketplace. Packaging and distribution, including bundled dependency license notices, still require separate verification.
