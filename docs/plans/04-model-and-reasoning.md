# Model / Agent / Reasoning — status and original plan

> The user requested a fourth document as a separate plan. The feature was later implemented upon a separate instruction; it does not lift the temporary edit/Retry prohibition. Neither this document nor automated GREEN authorizes Git operations or a release.

## Current status as of October 5, 2026

- Backend-confirmed Model (`model`), Agent (`mode`) and Reasoning (`effort`) are implemented: guards/projection in `src/protocol.ts`, snapshots/revision/pending/recovery/`config` event in `src/sessions.ts`, union/marker/input-state lifecycle in `src/session-options.ts`, routing/eager New in `src/extension.ts`.
- New/load/update/set catalogs are replaced in full; the setter passes literal values. The UI does not compute fallback or variants: Reasoning is hidden without effort choices, and a removed currentValue is explicitly locked unavailable. Configuration remains ephemeral, storage contains only `id/cwd/label/created`, and global settings/credentials are unchanged.
- The user agreed to three inline native option groups and selection before the first Send through **OpenCode: New Native Chat Session**: cwd, one empty ACP session, no generation until Send. The latest clarification requires the sidebar instead of a Chat tab: after public `vscode.open`, `workbench.action.chat.openInSidebar` moves the same REAL session and closes the tab; complete native evidence for this route has not yet been collected. Generic draft/welcome remain lazy/default until materialization; replacing inline pickers with Quick Pick was not chosen.
- After the sidebar follow-up, the user confirmed selection through OpenCode New, but not through the top “+”. The first `chat/newSession` action for the selected OpenCode chat was added to the manifest: “+” invokes the same eager New. Other chat types and explicit generic draft commands remain unchanged. Native verification of the menu follow-up has not yet been performed.
- API 1.140.0 clarification: the catalog is controller-wide, selection events are broadcast, and there is no separate per-resource catalog API. A union of unique REAL groups, hidden locked marker `opencode_session` (`when: "false"`, draft `unconfigured`), resource-owned `when`, own `ChatSession.options` and immutable bindings replace the initial assumption of an independent catalog for each input state. Revision-scoped UI IDs/observed/pending state suppress echoes; ACP values do not change.
- Busy/stale/unavailable selections are rejected; the prompt reserves a turn and waits for the accepted config operation. Its failure adds no history/prompt; Stop before the prompt starts sends no cancel and does not cancel the setter. An RPC error/malformed set requires a fresh load, without optimistic rollback or automatic replay of selections/tools/permissions.
- Automated status/counts, historical evidence and the current native checklist are in [README](../../README.md#model--agent--reasoning-current-implementation). Final reviews are complete, and test review findings are resolved. Native rendering/isolation, a real backend-confirmed trace, the new lazy smoke and regressions for the new bundles have not yet been checked in the editor. Universal isolation of resource-less/reused renderer scopes is not claimed.

## Original plan and agreed clarifications

The sections below preserve the source review and original proposal structure. Checkboxes are a historical plan, not the current list of unverified backend functions; actual status is above. UX/API assumptions were corrected according to the agreed implementation. Native evidence remains open.

**Goal:** select the real OpenCode model, agent and reasoning effort/variant from native Chat for a specific session, rather than merely showing the model bridge.

**Architecture:** the catalog and current values come from OpenCode through ACP `configOptions`. Changes are sent through `session/set_config_option`; OpenCode continues to own the model, credentials and provider-specific parameters. Native session input state shows three pickers: Model, Agent and Reasoning. No Webview, HTTP client for the shared service, or manual writes to global configuration.

**Starting point before implementation:** TypeScript/esbuild and SDK 1.7.0 were already integrated. `src/extension.ts` registered only `OpenCode (configured)`; the standard VS Code model picker did not control the backend. `src/sessions.ts` did not yet retain `configOptions` from new/load, and `src/protocol.ts` did not provide a select projection.

## 1. Verified contracts

### OpenCode 2.0.21

Public source code at commit `8a8bd622a3d7dc29ccf30ec17f84e363ed95ed72` was checked:

- [ACP service](https://github.com/anomalyco/opencode/blob/8a8bd622a3d7dc29ccf30ec17f84e363ed95ed72/packages/cli/src/acp/service.ts): `session/new` and `session/load` return `configOptions`; `setSessionConfigOption` accepts a string value and handles `model`, `effort`, `mode`.
- [Config options](https://github.com/anomalyco/opencode/blob/8a8bd622a3d7dc29ccf30ec17f84e363ed95ed72/packages/cli/src/acp/config-option.ts): `model` has `category: model`, `effort` has `category: thought_level`, both have `type: select`. `effort` is present only when the selected model has variants; the list includes `default`.
- `model.currentValue` is `provider/model`; option identifiers must be passed literally. A model ID can contain additional `/` characters; do not parse it as a fixed pair of segments.
- The ACP parser in the selected tag supports a `/variant` suffix, but separate Model and Reasoning require sending the literal model value and effort separately. Do not automatically substitute the CLI `#variant` syntax into an ACP value. Agent uses a separate `configId: "mode"` and a literal value from options.
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

- Show Model, Agent and Reasoning as session-specific native option groups. Obtain the agent catalog from `mode` and reasoning levels from the current model: do not invent universal `low/medium/high` levels.
- Reasoning means effort/variant, **not** a toggle for showing `agent_thought_chunk`. Reasoning rendering remains independent of the selected level.
- If the backend does not provide effort or choices are empty, hide Reasoning; do not pretend the effort was applied. For a nonempty catalog, show a removed currentValue as locked unavailable.
- Display the model bridge as a technical bridge, and the actual selection as the backend model. Check the native UI so the two elements do not report contradictory information about the selected model. Replacing the bridge with a real catalog in the built-in model picker is not automatically part of this minimal option; if that is specifically required, agree on it separately before implementation.
- For OpenCode New, first determine cwd, create an empty ACP session and open it in the sidebar: the user agreed to full pickers before the first Send. The two-step opening route and its limitations are described in README. A generic untitled draft retains backend-default until materialization. In multi-root, catalogs belong to individual sessions/cwd values, not a shared mixed selector.
- Changes affect only the selected session. Do not create a new session, import all sessions, change `opencode.jsonc`, or save the catalog/credentials in `workspaceState`.
- During an active prompt, do not silently apply a selection: block the change and preserve current values. Changes become available after completion/Stop.
- On busy/stale/membership rejection, show an error and the confirmed snapshot. An error from a sent RPC or malformed success means uncertain state, not rollback: clear selections and require a fresh load before a future prompt. On shared-connection timeout, preserve the existing message about the impact on other sessions.

## 3. Minimal changes by file

| File | Responsibility |
| --- | --- |
| `src/protocol.ts` | Runtime guards and projection of the select config options used, before SDK optional normalization |
| `src/sessions.ts` | Session-owned options; reading new/load; handling updates; applying selection and serializing it relative to prompts |
| `src/extension.ts`, `src/session-options.ts` | Eager New/native routing and three groups; focused owner for union/marker, subscription lifecycle and display of backend current values |
| `src/acp.ts` | Only if the stable method map/notification boundary requires a directly related change; not a new transport |
| `test/fixtures/agent.cjs` | Independent catalogs for two cwd values, model/effort responses and updates, errors and ordering evidence |
| `test/sessions.test.js`, `test/extension.test.js` | Regressions for backend selection, UI boundary, new/load and cancellation |
| `README.md`, `AGENTS.md` | New user-facing contract only after implementation and verification |

No new npm dependencies are needed. Use protocol types from the already pinned SDK; retain runtime guards, as types do not prove wire input validity.

## 4. Stages and checks

- [ ] Before implementation, verify the installed OpenCode version and the editor's public tag; if the version differs, recheck the contract above. Save the current suite result as the baseline.
- [ ] Agree on selection before the first Send and native session option groups. Three inline groups through eager OpenCode New were later agreed; generic drafts remain lazy/default, without substitution by Quick Pick.
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

- [ ] In the editor, first run lazy draft smoke without ACP/prompt, not eager Product New; then run separately agreed native testing with manual Workspace Trust.
- [ ] Ensure the three pickers appear for the correct REAL session and cwd, change backend selection and do not break Send. A changed UI label alone is insufficient; check A/B and generic/reused scopes separately.
- [ ] Check literal model/mode/effort and the accepted full config snapshot through a safe backend trace without generation. Real prompts were not run during the automated stage; separately agree on native responses after model changes and their possible cost. The text “what model are you?” is not evidence of the actual provider/model.
- [ ] Check a model without effort, a switching error, Stop/next request, reload and a full restart with the previous session. Account for a new model potentially having a different cost; agree on the specific run with the user.
- [ ] Update docs with actual results, separating fixtures/backend from native UI. Delete temporary verification configs only after checking for user changes.

## Sources

- [OpenCode V2 ACP](https://opencode.ai/v2/docs/cli/acp/) and [Models](https://opencode.ai/v2/docs/models/) — current V2 documents, not a replacement for the v2.0.21 source contract.
- The OpenCode 2.0.21 and VS Code 1.140.0 source code pinned above.
- [Plan 03](03-native-resend-and-verification.md) — edit/Retry and native evidence; this stage must not reintroduce unsupported message replacement.

**Completion criterion:** model/mode/effort are session-specific and actually applied through ACP before the prompt; the UI shows backend-confirmed values; errors/ordering/reload are covered by tests and a manual native run. The backend/native adapter are implemented, automatically verified and have passed final review. Without separate native evidence, this stage is not declared fully verified in the editor or release-ready.
