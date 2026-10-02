# TypeScript and Build — Implementation Plan

> For the implementer: execute tasks sequentially using `executing-plans`; mark steps with checkboxes. This document does not automatically authorize implementation: the user has currently asked only for the plans to be written down.

**Goal:** migrate the runtime to TypeScript with `import`/`export`, preserving the extension's behavior and a compatible CommonJS build.

**Architecture:** source files use ES modules; `esbuild` builds JavaScript for the Node extension host. `tsc --noEmit` checks types separately. A small entry point imports `vscode`, while the native adapter remains accessible to unit tests without a real editor.

**Stack:** TypeScript, esbuild, Node.js built-in test runner, VS Code 1.140.0.

**Basis:** the user approved TypeScript, `import`/`export`, a small build setup, and the official ACP SDK. This plan covers only the language and build migration; the SDK is covered in [02-acp-sdk.md](02-acp-sdk.md).

## Order and Boundaries

- Execute this plan first; it must finish with a working extension using the existing ACP client.
- Do not combine the language migration with transport replacement, new functionality, or chat routing fixes.
- Preserve native Chat through `chatSessionsProvider`; do not add a Webview, Agent Host, or VS Code patches.
- Preserve `opencode acp`, `shell: false`, ACP v1, and the existing executable settings.
- The participant ID, session type, and URI scheme are `opencode`; the extension ID is `local.opencode-native-chat`.
- Preserve the current model bridge: `requiresCustomModels: true`, `supportsAutoModel: false`, `targetChatSessionType: "opencode"`. Do not return to the old Auto fallback.
- Preserve Workspace Trust, explicit permission selection, cancellation after 5 seconds, and metadata-only `workspaceState`.
- Do not add runtime dependencies at this stage. The development tools have been approved by purpose; choose compatible specific versions and pin them in the lockfile.
- Do not create commits or install packages until the user instructs you to execute the plan.

## File Map

| File | Change |
| --- | --- |
| `src/main.ts` | New thin entry point importing `vscode` |
| `src/extension.js` → `src/extension.ts` | Native adapter, Quick Pick, metadata; no behavior changes |
| `src/sessions.js` → `src/sessions.ts` | Types for the current lifecycle and history |
| `src/acp.js` → `src/acp.ts` | Types for the existing transport, without the SDK |
| `src/types.ts` | Only the necessary shared types for records, history, and the current ACP contract |
| `types/vscode*.d.ts` | Declarations from the public VS Code `1.140.0` tag |
| `tsconfig.json`, `scripts/build.mjs` | Type checking and build |
| `package.json`, `package-lock.json` | Commands, development dependencies, entry point |
| `test/*.test.js` | Imports of built modules; existing scenarios are preserved |
| `scripts/check.cjs` | Validation of the new manifest and built JavaScript |
| `.vscode/launch.json`, `.vscode/tasks.json` | Build before F5 and source maps |
| `.gitignore`, `README.md`, `AGENTS.md` | Artifacts and current development instructions |

Keep `test/fixtures/agent.cjs` and `test/editor-smoke.cjs` in JavaScript: these are independent executable fixtures, not the extension runtime. Do not migrate the entire tree to TypeScript for consistency alone.

## Task 1. Record Baseline Behavior and Editor Types

**Files:** `test/extension.test.js`, `test/sessions.test.js`, `test/acp.test.js`, `types/vscode*.d.ts`.

- [ ] Before making changes, run `npm test` and `npm run check`; save the results as the baseline. If tests already fail, do not attribute the failures to the migration or fix them outside the agreed scope.
- [ ] Preserve participant checks for a saved session, a foreign scheme, an already-cancelled request, and `opencode:/untitled-*` on the first Send.
- [ ] Preserve model bridge checks: metadata without starting ACP, rejection of direct generation, zero token count.
- [ ] Download the stable `vscode.d.ts` and declarations for the four proposals (`chatSessionsProvider`, `chatParticipantPrivate`, `chatParticipantAdditions`, `chatProvider`) from `https://raw.githubusercontent.com/microsoft/vscode/1.140.0/src/vscode-dts/`. Place them in `types/`; use the same tag for declaration dependencies.
- [ ] Do not obtain proposed API declarations from `main`, a local installation, or an automatically downloaded latest version. Do not hide missing types with `any`, a global index signature, or by disabling strict mode.

**Result:** a known baseline verification result and reproducible declarations for the target editor.

## Task 2. Migrate the Runtime and Add the Build

**Files:** `src/*.ts`, `tsconfig.json`, `scripts/build.mjs`, `package.json`, `package-lock.json`, `.gitignore`.

**Interfaces:** `register`, `renderUpdate`, `choosePermission`, `Sessions`, and `AcpClient` retain their external responsibilities. The entry point calls `activateWithApi(vscode, context)`; this adapter export replaces the previous `activate(context)` with its internal `require("vscode")`.

- [ ] During execution, install only development tools: `npm install --save-dev --save-exact typescript esbuild @types/node`. Check that the selected versions are compatible with Node in the target extension host; do not also add `@types/vscode` if the vendored `vscode.d.ts` already declares the module.
- [ ] Migrate the three runtime files to `.ts`, replace CommonJS with ES imports/exports, and add minimal types. Handle errors as `unknown` with narrowing; do not assume JSON data is automatically validated.
- [ ] Keep local ACP types only for the subset in use. These are temporary types until plan 02, not a new implementation of ACP schemas.
- [ ] Add the entry point:

```ts
import * as vscode from "vscode";
import { activateWithApi } from "./extension";

export function activate(context: vscode.ExtensionContext) {
  return activateWithApi(vscode, context);
}
```

- [ ] The native adapter receives the typed editor API as an argument. Do not import runtime `vscode` in the testable `extension.ts`, `sessions.ts`, and `acp.ts`; type-only imports are allowed. Do not rewrite the test double to cover the entire VS Code namespace: limit the boundary to members actually used.
- [ ] Add `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noEmit": true,
    "types": ["node"],
    "lib": ["ES2022", "DOM"]
  },
  "include": ["src/**/*.ts", "types/**/*.d.ts"]
}
```

- [ ] Add `scripts/build.mjs`. Four small bundles are needed so that tests continue checking individual modules while the extension host loads `main`:

```js
import { build } from "esbuild";

await build({
  entryPoints: ["src/main.ts", "src/extension.ts", "src/sessions.ts", "src/acp.ts"],
  outbase: "src",
  outdir: "dist",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "es2022",
  external: ["vscode"],
  sourcemap: true,
  sourcesContent: false
});
```

- [ ] In `package.json`, set `main: "./dist/main.js"`; preserve the other contributions and activation events. Do not add `"type": "module"`: the existing `.js` tests remain CommonJS.
- [ ] Add the commands `build: "node scripts/build.mjs"`, `check-types: "tsc --noEmit"`, `pretest: "npm run build"`, `precheck: "npm run build && npm run check-types"`. Keep `test` and `check` as separate commands. Do not add ESLint, tsx, Vitest, or a task runner.
- [ ] In `.gitignore`, add `node_modules/` and `dist/`, preserving the editor profile exclusions. The lockfile must remain in Git.

**Result:** strictly type-checked source files and CommonJS bundles without changes to ACP behavior.

## Task 3. Switch Checks and Launches to Built Code

**Files:** `test/*.test.js`, `scripts/check.cjs`, `.vscode/launch.json`, `.vscode/tasks.json`, `README.md`, `AGENTS.md`.

- [ ] Replace imports of `../src/acp`, `../src/sessions`, and `../src/extension` with `../dist/acp`, `../dist/sessions`, and `../dist/extension`. Do not move fixtures or the editor smoke test.
- [ ] In `scripts/check.cjs`, check `manifest.main === "./dist/main.js"`; check the syntax of `dist/main.js`, `dist/extension.js`, `dist/sessions.js`, `dist/acp.js`, and the remaining JS/CJS tests. Preserve all checks for the current model bridge and Workspace Trust.
- [ ] Add a build task for F5:

```json
{
  "version": "2.0.0",
  "tasks": [{
    "label": "build extension",
    "type": "npm",
    "script": "build",
    "problemMatcher": []
  }]
}
```

- [ ] In `.vscode/launch.json`, add `preLaunchTask: "build extension"` and `outFiles: ["${workspaceFolder}/dist/**/*.js"]` to both configurations; preserve the proposed API flag and smoke entry point.
- [ ] Update README and AGENTS: dependency installation and a build are now required. To run an individual test directly, first run `npm run build`, then `node --test test/extension.test.js`. Use `npm ci` for a clean checkout once the lockfile exists.
- [ ] Do not remove manual confirmations of the current native Chat or claim that they automatically remain valid after the migration.

**Result:** tests, CLI, and F5 use one consistent set of artifacts.

## Task 4. Final Verification

- [ ] Run from the project root:

```bash
npm run build
npm run check-types
npm test
npm run check
git diff --check
git status --short
```

Expected: exit code 0, all current tests pass, and four bundles exist. There is no separate lint step; `check-types` and `check` do not pretend to be one.

- [ ] Review the diff: no runtime `require`/`module.exports` in `src/*.ts`, duplicate runtime in `.js`, unexpected dependencies, or security changes. The CommonJS exceptions are generated bundles and retained test fixtures.
- [ ] Run the smoke test on the built extension in VS Code 1.140.0. This proves activation and the open command, not native Send.
- [ ] Separately verify a native response, incremental streaming, a tool card, and Stop followed by the next request. Preserve Workspace Trust; do not work around `Language model unavailable` by reconfiguring OpenCode credentials.
- [ ] Mark approval/rejection and recovery after restart as confirmed only with separate observations. If manual verification is unavailable, record the limitation; do not claim full UI compatibility.

## Sources

- [VS Code: bundling extensions](https://code.visualstudio.com/api/working-with-extensions/bundling-extension) — `format: "cjs"`, external `vscode`, separate `tsc --noEmit`.
- [VS Code 1.140.0: declarations](https://github.com/microsoft/vscode/tree/1.140.0/src/vscode-dts).
- This project's `README.md` and `AGENTS.md` — the native contract and evidence boundaries.

**Next stage:** execute [02-acp-sdk.md](02-acp-sdk.md) only after this plan's final verification.
