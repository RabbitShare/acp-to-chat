# Model and reasoning selection — plan for a separate stage

> The user requested a fourth document. This file saves the feature plan; its implementation is not part of the current editing prohibition and test investigation. Start implementation upon a separate instruction.

**Goal:** select the real OpenCode model and its reasoning effort/variant from native Chat for a specific session, rather than merely showing the model bridge.

**Architecture:** the catalog and current values come from OpenCode through ACP `configOptions`. Changes are sent through `session/set_config_option`; OpenCode continues to own the model, credentials and provider-specific parameters. Native session input state shows two pickers: Model and Reasoning. No Webview, HTTP client for the shared service, or manual writes to global configuration.

**Current starting point:** TypeScript/esbuild and SDK 1.7.0 are already integrated. `src/extension.ts` registers only `OpenCode (configured)`; the standard VS Code model picker does not yet control the backend. `src/sessions.ts` does not retain `configOptions` from new/load, and `src/protocol.ts` does not provide this application-level projection for the pickers.

## 1. Verified contracts

### OpenCode 2.0.21

Public source code at commit `8a8bd622a3d7dc29ccf30ec17f84e363ed95ed72` was checked:

- [ACP service](https://github.com/anomalyco/opencode/blob/8a8bd622a3d7dc29ccf30ec17f84e363ed95ed72/packages/cli/src/acp/service.ts): `session/new` and `session/load` return `configOptions`; `setSessionConfigOption` accepts a string value and handles `model`, `effort`, `mode`.
- [Config options](https://github.com/anomalyco/opencode/blob/8a8bd622a3d7dc29ccf30ec17f84e363ed95ed72/packages/cli/src/acp/config-option.ts): `model` has `category: model`, `effort` has `category: thought_level`, both have `type: select`. `effort` is present only when the selected model has variants; the list includes `default`.
- `model.currentValue` is `provider/model`; option identifiers must be passed literally. A model ID can contain additional `/` characters; do not parse it as a fixed pair of segments.
- The ACP parser in the selected tag supports a `/variant` suffix, but two separate pickers require sending the literal model value and effort separately. Do not automatically substitute the CLI `#variant` syntax into an ACP value.
- Changing the model may preserve a compatible variant of the same model or reset it. Final model/effort values come from the `configOptions` response, not calculations based on the old UI.
- The backend applies the model to the session through `switchModel`; subsequent prompts use the selection. This does not change the root default in `opencode.jsonc`.
- `config_option_update` is sent when the catalog changes; check the source for the delivery conditions in the specific version. Current V2 documentation may describe additional capabilities of a newer version.

Example ACP request where the model ID must actually be obtained from options:

```json
{
  "sessionId": "ses_example",
  "configId": "model",
  "value": "provider/model-from-options"
}
```

The method is `session/set_config_option`. Reasoning uses `configId: "effort"` and a value from the current effort options. Do not add reasoning parameters to the prompt text or send provider credentials from the extension.

### VS Code 1.140.0

- [chatSessionsProvider](https://github.com/microsoft/vscode/blob/1.140.0/src/vscode-dts/vscode.proposed.chatSessionsProvider.d.ts): `controller.getChatSessionInputState`, `createChatSessionInputState(groups)`, `ChatSessionInputState.onDidChange`/`onDidDispose`, replacement of the entire `groups` array to update options.
- The selection is available through `chatContext.chatSessionContext.inputState`; during creation, also through the `newChatSessionItemHandler` context. `sessionResource` may be absent before session materialization.
- Use the current input-state API for this stage, not deprecated `provideHandleOptionsChange`/`provideChatSessionProviderOptions`.
- [chatProvider](https://github.com/microsoft/vscode/blob/1.140.0/src/vscode-dts/vscode.proposed.chatProvider.d.ts): the current LanguageModelChat bridge is required before the participant is called. Do not remove it and reintroduce `Language model unavailable`.

## 2. UX and boundaries

- Show Model and Reasoning as session-specific native option groups. Obtain reasoning levels from the current model: do not invent universal `low/medium/high` levels.
- Reasoning means effort/variant, **not** a toggle for showing `agent_thought_chunk`. Reasoning rendering remains independent of the selected level.
- If the backend does not provide effort, hide or explicitly disable this picker; do not pretend the effort was applied.
- Display the model bridge as a technical bridge, and the actual selection as the backend model. Check the native UI so the two elements do not report contradictory information about the selected model. Replacing the bridge with a real catalog in the built-in model picker is not automatically part of this minimal option; if that is specifically required, agree on it separately before implementation.
- For a new untitled session, first determine cwd. In multi-root, do not show a shared mixed catalog from different projects. Minimal option: backend-default before materialization, full pickers after successful `session/new`; separately agree on selection before the first Send if it is mandatory.
- Changes affect only the selected session. Do not create a new session, import all sessions, change `opencode.jsonc`, or save the catalog/credentials in `workspaceState`.
- During an active prompt, do not silently apply a selection: block the change and preserve current values. Changes become available after completion/Stop.
- If the RPC is rejected or the option is stale, show an error and restore the confirmed backend state. On shared-connection timeout, preserve the existing message about the impact on other sessions.

## 3. Minimal changes by file

| File | Responsibility |
| --- | --- |
| `src/protocol.ts` | Runtime guards and projection of the select config options used, before SDK optional normalization |
| `src/sessions.ts` | Session-owned options; reading new/load; handling updates; applying selection and serializing it relative to prompts |
| `src/extension.ts` | Two native input-state groups, selection handling, subscription lifecycle and display of backend current values |
| `src/acp.ts` | Only if the stable method map/notification boundary requires a directly related change; not a new transport |
| `test/fixtures/agent.cjs` | Independent catalogs for two cwd values, model/effort responses and updates, errors and ordering evidence |
| `test/sessions.test.js`, `test/extension.test.js` | Regressions for backend selection, UI boundary, new/load and cancellation |
| `README.md`, `AGENTS.md` | New user-facing contract only after implementation and verification |

No new npm dependencies are needed. Use protocol types from the already pinned SDK; retain runtime guards, as types do not prove wire input validity.

## 4. Stages and checks

- [ ] Before implementation, verify the installed OpenCode version and the editor's public tag; if the version differs, recheck the contract above. Save the current suite result as the baseline.
- [ ] Agree on whether selection before the first Send and specifically the built-in model picker are required, or whether two native session option groups suffice. Do not silently expand the minimal UX.
- [ ] Add failing tests for reading `configOptions` from new/load and `config_option_update`; check that history is unaffected. Validate string IDs/currentValue, type select, items, duplicate IDs, and grouped options if they occur in the target backend. Do not read arbitrary provider JSON as a trusted UI catalog.
- [ ] Store model/effort in `SessionRecord`, not `workspaceState`. On load/reconnect, current backend state replaces the old cache; absent options yield an honest backend-default mode.
- [ ] Add a backend method to apply selection through `session/set_config_option`. Validate ID/value against the current session catalog and return confirmed options. Do not equate an optimistic UI selection with a successful RPC.
- [ ] Check that waiting for a configuration change blocks a new prompt until the response, and an active prompt blocks model changes. Several rapid changes must have a defined order without applying stale effort to a new model. An error must release the pending change.
- [ ] Connect `getChatSessionInputState` and native groups; update the entire `groups` array after a backend response/update. Remove subscriptions on `onDidDispose`; programmatic refresh must not loop through `onDidChange`.
- [ ] After changing model, rebuild Reasoning from the returned options. When changing effort, do not reset the selected model. If the backend's current model is absent from the catalog, show an unavailable state, not an arbitrary fallback.
- [ ] Preserve the saved/untitled native request route, edit/Retry protection, model bridge, permissions and metadata-only persistence.

**Required test scenarios:**

- [ ] Default model and effort on new; a different currentValue on load; effort disappearing for a model without variants.
- [ ] Selecting a model with `/` inside the model ID; variants with nonstandard names, literal `default`; no hardcoded levels.
- [ ] The subsequent prompt starts only after successfully changing the relevant session config; the change itself does not create a user turn or invoke a model/tools.
- [ ] Two cwd values/two sessions have independent catalogs and selections; a shared ACP process does not imply a shared active model.
- [ ] Invalid configId/value, malformed update, stale catalog, removed model, RPC error, cancellation and timeout. A backend error is not replaced by a successful UI state.
- [ ] Changing model updates the effort list/selection; rapid selections and Send during a config change do not bypass ordering.
- [ ] Reload/reconnect restores backend model/effort and does not resend old requests or tools.
- [ ] The new UI does not read credentials or invoke the model merely by opening a picker. A change selects configuration, not generation.

## 5. Final verification

```bash
npm test
npm run check
git diff --check
```

`pretest`/`precheck` build bundles; `precheck` also performs strict type checking. Check results and every failure, not just focused tests. Final review covers contracts, tests, security and absence of new dependencies/HTTP/a duplicated model catalog.

- [ ] In the editor, first run smoke without a prompt, then a separate native run with the user's configured models and manual Workspace Trust.
- [ ] Ensure both pickers appear for the correct session and cwd, change backend selection and do not break Send. A changed UI label alone is insufficient.
- [ ] Select two available models and two reasoning variants that actually exist; check confirmed ACP values and separate responses after switching. The text “what model are you?” is not evidence of the actual provider/model.
- [ ] Check a model without effort, a switching error, Stop/next request, reload and a full restart with the previous session. Account for a new model potentially having a different cost; agree on the specific run with the user.
- [ ] Update docs with actual results, separating fixtures/backend from native UI. Delete temporary verification configs only after checking for user changes.

## Sources

- [OpenCode V2 ACP](https://opencode.ai/v2/docs/cli/acp/) and [Models](https://opencode.ai/v2/docs/models/) — current V2 documents, not a replacement for the v2.0.21 source contract.
- The OpenCode 2.0.21 and VS Code 1.140.0 source code pinned above.
- [Plan 03](03-native-resend-and-verification.md) — edit/Retry and native evidence; this stage must not reintroduce unsupported message replacement.

**Completion criterion:** model/effort are session-specific and actually applied through ACP before the prompt; the UI shows backend-confirmed values; errors/ordering/reload are covered by tests and a manual native run. This document alone does not mean that model or reasoning selection has already been implemented.
