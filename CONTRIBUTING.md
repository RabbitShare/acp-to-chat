# Contributing to OpenCode Native Chat

The [README](README.md) is for users. This guide covers source setup, development checks, documentation, and distribution constraints. Detailed contracts and historical verification evidence live in [docs/development.md](docs/development.md).

## Build and run

Use **Node.js 22.19 or newer** and npm. Install and build from a clean checkout:

```bash
git clone https://github.com/RabbitShare/acp-to-chat.git
cd acp-to-chat
npm ci
npm run build
```

The editor loads `dist/main.js`. Edit source files, not generated bundles. Generated bundles, `node_modules/`, and `.effect-machine/` are ignored by Git.

### Extension Development Host

Open the extension directory in VS Code and press **F5** with the **OpenCode Native Chat** launch configuration. Its **build extension** prelaunch task rebuilds bundles automatically. Open your target project in the resulting Extension Development Host window.

Alternatively, run this from the extension directory. Replace the final path with your target project:

```bash
EXTENSION_DIR="$(pwd)"
code --new-window \
  --user-data-dir="$EXTENSION_DIR/test/.editor-profile" \
  --extensions-dir="$EXTENSION_DIR/test/.editor-extensions" \
  --extensionDevelopmentPath="$EXTENSION_DIR" \
  --enable-proposed-api=RabbitShare.opencode-native-chat \
  /absolute/path/to/your/project
```

Use `code-insiders` if your editor does not permit proposed APIs; compatibility still depends on its API version. The integration targets **VS Code 1.140.0**, not arbitrary Insiders builds.

After source changes, rebuild and run **Developer: Reload Window** in the development host. Runtime argument changes require a full editor restart.

For manual checks, do not use `--extensionTestsPath`. Use isolated profile/extensions directories and grant Workspace Trust manually. Logs and editor profiles can contain prompts and secrets; review them before sharing.

## Checks

After runtime changes:

```bash
npm test
npm run check
```

`pretest` builds the bundles. `precheck` builds them and runs strict TypeScript checking. The checks cover fixture-based unit tests, syntax, the manifest, and launch/tasks configuration—not native editor compatibility.

Tests launch a real child process from `test/fixtures/agent.cjs`, with no model, credentials, or installed OpenCode. The VS Code API is replaced by a double.

Before running a test directly, build first:

```bash
npm run build
node --test test/extension.test.js
node --test --test-name-pattern='session-type participant' test/extension.test.js
```

Put test runner flags before the file path. For scope-specific checks and verification history, see [Checks](docs/development.md#checks).

### Native editor verification

The **Native API smoke test** F5 configuration checks activation and lazy draft opening. It does not launch ACP or send a prompt. It waits for manual Workspace Trust; do not disable Trust or set it programmatically.

Real Send, incremental streaming, tools, permissions, Stop, selectors, eager New, and restart recovery need separate native observations. Rebuild before verification and record editor/backend versions and the tested build. Historical results do not verify new bundles.

See the [native configuration checklist](docs/development.md#model--agent--reasoning-current-implementation) and [verification history](docs/development.md#checks).

## Architecture and contracts

Asynchronous orchestration uses **Effect 4.0.2** and executable **Effect Machine 0.40.0** statecharts for the shared connection, session load/configuration, and each turn. **TypeScript 7.0.2** checks the source; esbuild bundles runtime ESM dependencies into CommonJS for the extension host. Protocol framing and request correlation remain SDK-owned.

Read the repository's `AGENTS.md` before changing orchestration, native routing, or ACP boundaries. Keep runtime machine ownership and fail-closed validation intact.

- [Effect runtime and machine ownership](docs/development.md#effect-runtime-and-machine-ownership)
- [Transport policy and resource limits](docs/development.md#transport-and-limits)
- [Model / Agent / Reasoning](docs/development.md#model--agent--reasoning-current-implementation)
- [Slash commands and file context](docs/development.md#slash-commands-dynamic-suggestions)
- [Local template sources, substitutions, and restrictions](docs/development.md#local-template-expansion)
- [Development plans](docs/plans/README.md)

Verify proposed API contracts against the public source of the editor version being tested, not `main` or a local installation:

- [VS Code 1.140.0 session API declarations](https://github.com/microsoft/vscode/blob/1.140.0/src/vscode-dts/vscode.proposed.chatSessionsProvider.d.ts)
- [Full contract sources](docs/development.md#contract-sources)
- [ACP v1](https://agentclientprotocol.com/protocol/v1/overview)

### Machine visualizer

Run the official Effect Machine devtools from the extension directory:

```bash
npm run visualize
```

Open `http://127.0.0.1:5173`. The watcher discovers `ConnectionMachine`, `SessionMachine`, and `TurnMachine` from `src/machines/`. It does not connect to the running extension.

After machine changes, also build the static site:

```bash
npm run visualize:build
```

Inspect `.effect-machine/site/machines.json` for all three machine exports marked Ready without diagnostics. Serve `.effect-machine/site` with a local static host bound to loopback. Rebuild when machine definitions change.

The graph and simulation explore topology only: no Effects, guards, resolvers, invocations, or ACP requests run. Discovery evaluates trusted project modules and is not a sandbox. Keep machine imports free of IO and runtime `vscode` imports. Never expose the unauthenticated devtools or static host to untrusted networks.

See [visualizer limits and checks](docs/development.md#machine-visualizer-and-topology-simulation).

## Launch environment troubleshooting

`opencodeNativeChat.env` is a user-level, machine-specific setting. Literal string overrides are merged over the environment inherited by VS Code without changing the extension host's environment. Local slash template discovery uses the same launch environment snapshot. The setting is not synchronized or configurable by a workspace; shell expressions and substitutions are not evaluated.

If certificate validation fails, fix the server/proxy certificate, system clock, or trust configuration. Adding a trusted CA does not fix an expired certificate.

Only for an explicitly chosen, temporary insecure workaround:

```json
{
  "opencodeNativeChat.env": {
    "NODE_TLS_REJECT_UNAUTHORIZED": "0"
  }
}
```

**Warning:** This disables TLS certificate validation for OpenCode and processes inheriting its environment. HTTPS traffic, including credentials, can be intercepted. Remove the override after fixing the cause and run **Developer: Reload Window**.

## README images and demos

Keep the README focused on the product: benefits, opening a session, user settings, and actionable limitations. Put build instructions and internal contracts here or in `docs/development.md`.

The README banner is an illustration, not a native UI screenshot. Its editable source is [docs/media/banner.html](docs/media/banner.html); the rendered PNG is `images/opencode-native-chat.png`. Render the `#banner` element at 1200 × 460 pixels after editing the source.

For a real demo, capture the tested extension in native VS Code Chat. Show the Command Palette action, session selectors, a streamed response, and tool activity. Record the editor/backend versions. Redact prompts, credentials, sensitive paths, and project contents.

Use PNG/JPEG screenshots or a short GIF for inline media. For a longer video, link from a screenshot to the hosted recording. Do not invent demo URLs or present mockups as native verification.

The [publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension) requires README image URLs to resolve to HTTPS and disallows user-provided SVG images. With this repository's GitHub metadata, `vsce` can rewrite relative links; verify the branch/base URLs and uploaded assets before distributing a package. The banner source stays development-only under `docs/`.

## Packaging and distribution

**Do not publish the current proposed-API extension to Marketplace.** Microsoft's [proposed API guide](https://code.visualstudio.com/api/advanced-topics/using-proposed-api#sharing-extensions-using-the-proposed-api) allows sharing VSIX packages, not Marketplace publication. Enabling APIs through startup arguments does not remove that restriction or make an incompatible editor compatible.

Packaging and distribution need separate verification, including bundled dependency license notices, the generated runtime bundles, package contents, README media/links, and native editor checks. A documentation change or green unit tests do not constitute release approval.

Keep development files excluded through `.vscodeignore`. Do not add dependencies or change the chosen native Chat/ACP architecture as part of documentation or packaging work.
