# Official ACP SDK — Implementation Plan

> For the implementer: execute tasks sequentially using `executing-plans`; mark steps with checkboxes. This document does not automatically authorize implementation: the user has currently asked only for the plans to be written down.

**Goal:** replace manual JSON-RPC framing, correlation, and protocol dispatch with the official `@agentclientprotocol/sdk`, preserving the current user-facing contract.

**Architecture:** `src/acp.ts` remains a thin adapter for the process and SDK connection. The SDK owns ACP messages; `Sessions` owns lifecycle, history, and permissions; the native adapter owns the VS Code interface. Do not move UI or business policy into the SDK.

**Stack:** TypeScript, `@agentclientprotocol/sdk` 1.7.0, compatible `zod`, ACP v1 over stdio, esbuild/CommonJS output.

**Basis:** the direction approved in the conversation and [01-typescript-build.md](01-typescript-build.md). Version 1.7.0 and the API below were verified against the public SDK tag; if selecting a different version, recheck its contract.

## Preconditions and Boundaries

- Complete plan 01 first. `src/*.ts`, the `dist/*.js` build, and current tests must work with the existing transport.
- Do not add an OpenCode HTTP client, a shared service, experimental ACP v2, or other transport modes.
- Use the stable entry point `@agentclientprotocol/sdk`, fluent `client()`, and `ndJsonStream()`. Do not use the deprecated `ClientSideConnection`.
- SDK 1.7.0 is published as ESM. Include it and `zod` in CommonJS bundles through the existing esbuild setup; do not mark them external or attempt to manually `require` the ESM package.
- The SDK has the peer dependency `zod: ^3.25.0 || ^4.0.0`. Specify a compatible direct dependency and pin specific versions in the lockfile; this is not “one package without transitive dependencies.”
- Preserve `shell: false`, the executable path, the separate `opencode acp` process, and the stderr Output channel.
- Preserve ACP v1, `clientCapabilities: {}`, the absence of client filesystem/terminal capabilities, and `mcpServers: []` on new/load. OpenCode continues reading its MCP configuration from the folder configuration.
- Preserve the model bridge, participant/URI `opencode`, native saved/untitled routing, Workspace Trust, and the prohibition on executing trusted Markdown commands.
- Do not change metadata storage, the session list, model selection, attachments, fork, or file Undo.
- Do not create commits or install packages without a separate instruction to execute the plan.

## File Map

| File | Change |
| --- | --- |
| `src/acp.ts` | SDK stream/connection, process lifecycle, and error context |
| `src/sessions.ts` | Typed ACP calls and asynchronous cancellation notification |
| `src/types.ts` | Removal of local ACP type copies; application types remain |
| `src/extension.ts` | Only necessary refinements to event/permission types |
| `test/acp.test.js` | Tests of the process adapter with the SDK rather than its internals |
| `test/sessions.test.js`, `test/extension.test.js` | Regressions for cancellation, permissions, two sessions, and native routing |
| `test/fixtures/agent.cjs` | Schema-compatible responses and separate failure scenarios |
| `package.json`, `package-lock.json` | SDK and peer dependency |
| `README.md`, `AGENTS.md` | Dependency composition and current transport |

The build tool from plan 01 already includes npm dependencies in the bundle. Do not introduce a second pipeline or an additional generic RPC framework.

## Task 1. Pin the Package and Establish SDK Contracts

**Files:** `package.json`, `package-lock.json`, `src/acp.ts`, `src/protocol.ts`.

- [x] Before making changes, run `npm test` and `npm run check`; save the baseline results.
- [x] During execution, install `npm install --save-exact @agentclientprotocol/sdk@1.7.0 zod@3.25.76`. If this pair is unavailable or incompatible with the target environment, stop and agree on a replacement rather than automatically switching to experimental API.
- [x] Check the types `ClientConnection`, `ClientContext`, `SessionNotification`, `RequestPermissionRequest`, `RequestPermissionResponse`, and agent method maps for the exact selected tag.
- [x] Keep `SavedSession`, the session record, history, active turn, and status application-owned. Import protocol request/response/update types from the SDK.
- [x] Do not turn existing additional event fields (`name`, `messageId`) into required ACP fields. If they are outside the SDK contract, read them from `unknown` through a narrow runtime guard; a missing field must retain the existing fallback.

Interim boundary for task 02.1: dependencies and contracts are verified; current optional fields, guards, and application-owned types are preserved without runtime changes. Replacing protocol copies in `src/protocol.ts` with SDK imports remains unfinished: do this together with transport integration and typed session handlers in tasks 2–3, preserving the build and validation of raw `unknown` before SDK normalization. In v1.7.0, `name` is already optional in tool events, and `messageId` is optional in content chunks, but not in all `SessionUpdate` variants.

**Result:** a pinned stable v1 dependency and a clear boundary between protocol and application types.

## Task 2. Connect the SDK in Place of Manual JSON-RPC

**Files:** `src/acp.ts`, `src/sessions.ts`, `test/acp.test.js`.

**Interfaces:** preserve `AcpClient` as an adapter, the `notification` and `failure` events, and the accessible `child`, `failure`, `disposing`, and `dispose()`. Use SDK method maps to type `request(method, params, timeout?)`; custom methods are allowed only for fixtures and must not weaken the types of ACP calls in `Sessions`.

- [x] Connect Node stdio to Web Streams. Core wiring:

```ts
import { Readable, Writable } from "node:stream";
import { client, ndJsonStream } from "@agentclientprotocol/sdk";

const stream = ndJsonStream(
  Writable.toWeb(child.stdin),
  Readable.toWeb(child.stdout),
  { maxMessageBytes: 16 * 1024 * 1024 }
);

const connection = client({ name: "opencode-native-chat" })
  .onRequest("session/request_permission", ({ params }) =>
    onRequest("session/request_permission", params)
  )
  .onNotification("session/update", ({ params }) => {
    emitNotification("session/update", params);
  })
  .connect(stream);
```

Here, `child` is the existing result of `spawn`; `onRequest` is the callback from the adapter options, and `emitNotification` is its `EventEmitter.emit("notification", method, params)`. Type the permission callback as `Promise<RequestPermissionResponse>`. The connection lasts for the process's entire lifetime, not just one prompt; do not use `connectWith` with a callback that finishes after the first response.

- [x] Delegate requests to `connection.agent.request(method, params)` and notifications to `connection.agent.notify(method, params)`. Remove manual `nextId`, the pending response map, StringDecoder, JSON framing, and `receive()/answer()`.
- [x] Preserve the 30-second deadline for ordinary requests and the absence of an overall prompt deadline (`timeout = 0`). An outer wrapper controls the timeout and always clears the timer; the SDK handles correlation. Do not retain a second JSON-RPC ID map.
- [x] On timeout, ensure the pending SDK request is released: use a verified SDK request cancellation API; if it cannot clear one pending request, close the connection and explicitly document the impact on other sessions. Do not settle for `Promise.race` that leaves a request pending forever.
- [x] Clarify the change in limit units: the previous code limited JS buffer length, while SDK `maxMessageBytes` limits message size in bytes. Set 16 MiB per message and add an over-limit test; do not claim byte-for-byte identity with the old implementation.

Interim boundary for task 02.2: the SDK owns serialization and correlation; the standard facade uses method maps, while fixture RPC uses a separate `requestExtension`. SDK 1.7.0 has no public API to forcibly terminate one pending request: the deadline closes the **shared connection**, rejecting requests from all its sessions and terminating the process. `maxMessageBytes` limits each incoming line to 16 MiB of **bytes**, not the length of the overall UTF-16 buffer; a Unicode regression checks this difference. For a safe interim state, an SDK protocol-error byte-output guard, an already-parsed envelope check, bounded EOF/exit-context cleanup, and asynchronous cancel rejection handling are connected. This does not complete the remaining lifecycle, typed incoming boundary, fixture/schema, and native UI checks in tasks 3–5.

**Result:** serialization and correlation belong to the SDK; the application lifecycle remains unchanged.

## Task 3. Preserve Fail-Closed Behavior and Process Lifecycle

**Files:** `src/acp.ts`, `src/sessions.ts`, `test/acp.test.js`, `test/fixtures/agent.cjs`.

On invalid JSON in `ndJsonStream`, SDK 1.7.0 sends a JSON-RPC parse error and continues reading. Our client currently closes the connection. Do not treat these behaviors as equivalent.

- [x] Preserve fail-closed behavior through a wrapper around the byte output passed to `ndJsonStream`: SDK 1.7.0 writes parse-error responses directly there, bypassing `stream.writable`. Each SDK `writeJson` passes a complete serialized message in one write. Check only this SDK-generated outgoing JSON: a response with `id: null` and code `-32700`/`-32600` triggers failure and rejects the write; other bytes are passed to stdin. Do not write a second incoming NDJSON parser. Release the writer lock on dispose and test this wrapper with a separate regression test.
- [x] Check valid JSON with an invalid JSON-RPC envelope. If the SDK does not terminate the connection or write a protocol error, add a narrow envelope check on already-parsed `stream.readable` messages, without duplicating framing or correlation.
- [x] Stream limit violations, write errors, and unexpected EOF must terminate pending requests and emit one failure event. Do not turn a process crash into “everything completed successfully.”
- [x] Connect `connection.signal`/`connection.closed` to the existing failure path, noting that `closed` resolves on closure and does not itself contain an exit code. Preserve the `code`, `signal`, method, executable, and cwd context at the adapter level.
- [x] Make `dispose()` idempotent: close the SDK connection and end stdin; if the process is still alive, send SIGTERM after 2 seconds and SIGKILL after 3 seconds. Clear timers on `close`; do not present voluntary closure as an unexpected crash.
- [x] Preserve handlers for `spawn` error, stdin error, stderr, and process close. Protect against SDK close/process close races and unhandled rejected promises.
- [x] Because SDK `notify()` is asynchronous, handle rejection when sending `session/cancel`; do not make cancellation fire-and-forget without an error handler. Preserve closure of a stuck connection after 5 seconds.
- [x] When the shared connection fails, aborting all active turns closes their Quick Picks. A user Stop remains cancellation; a crash remains failed. A subsequent connection must clear the old `ready` and allow reloading the saved session.

Boundary for task 02.3: the lifecycle implementation from task 02.2 is preserved without another rewrite. Separate regressions check rejection of all pending requests, one failure event, no forwarding of SDK parse-error bytes, release of the byte writer, EOF/process-close timers/listeners, and asynchronous cancel rejection. Two active sessions use the real `choosePermission` with an API double: Stop remains cancellation, the neighboring turn becomes failed, and both pickers close; a new connection clears `ready` and restores saved history. This is fixture evidence, not a native UI observation.

The local `PermissionParams` copy is removed: consumers use SDK `RequestPermissionRequest`/`RequestPermissionResponse`. Raw unknown is checked before optional normalization; a malformed title and a nonexistent ACP permission kind do not open UI. The typed object contains only validated fields used by the UI. The full SDK `SessionNotification`/`SessionUpdate` union is not yet adopted: the old loose update guard accepts broader payloads, and the stable 1.7.0 entry point does not export their schema parsers. Replace this boundary together with schema-compatible fixtures in task 4, without unchecked assertions, private schema imports, or weakened raw optional guards. Therefore, the deferred type item from task 1 remains unfinished; tasks 4–5 and editor checks are not marked complete.

**Result:** the SDK does not weaken existing security, resource cleanup, or cancellation.

## Task 4. Align Fixtures with the SDK and Preserve Regressions

**Files:** `test/fixtures/agent.cjs`, `test/acp.test.js`, `test/sessions.test.js`, `test/extension.test.js`.

- [x] Do not add the SDK inside the fixture process: an independent fake agent tests real stdio and does not share the client implementation.
- [x] Allow session creation/initialization before the prompt in ACP transport tests. Align standard responses with SDK schemas without adding invented required fields.
- [x] Separate protocol assertions from test-only data. The fixture response fields `permission`/`cwd` are not guaranteed by ACP: for integration tests, put the necessary data in tool `rawOutput` or `_meta` rather than weakening SDK schemas.
- [x] Preserve checks for out-of-order responses, split UTF-8, remote error, timeout, process exit, invalid stdout, permissions, and SIGKILL of a stubborn process. Custom RPC `echo`/`fail` remain fixture-only; use the SDK's designated custom-method path.
- [x] Add regressions for an oversized message, invalid envelope, asynchronous cancel write failure, and unexpected EOF during an active request. Tests must check settlement of the pending promise and the absence of a stuck turn, not private SDK maps.
- [x] Preserve lifecycle tests: load replay, two cwd values/two sessions, one prompt per session, invalid option ID, permission dismissal/abort, bounded cancellation, idle/active crash.
- [x] Preserve native adapter tests: saved/untitled routes, a foreign scheme, metadata-only persistence, the model bridge without starting ACP, Markdown safety, and explicit approval/rejection.
- [x] If necessary, add a check for explicit approval `yes`: the current `undefined`, arbitrary option ID, and rejection `no` do not replace a positive scenario.

Boundary for task 02.4: the fixture remains an independent stdio process; test-only `permission`/`cwd` were moved to `PromptResponse._meta`, and tool `rawOutput` was preserved. Standard traffic is validated against the public `@agentclientprotocol/sdk/schema/schema.json` from the exact 1.7.0 tag, including negative controls without optional salvage. Completed transport/lifecycle regressions from tasks 2–3 were reused, not duplicated; positive approval `yes` was already tested in sessions, and explicit Allow/Reject in the adapter.

The deferred type item from task 1 is complete: loose `SessionUpdate` is removed, and history/onUpdate/render consumers use the official SDK union; raw `unknown` passes through a minimal projection of supported text/tool/info events. Invalid optional fields are checked before normalization; tool `messageId` is read through a narrow guard as an extension field, not a required union property. Unsupported variants are safely ignored. Application records/status/turn remain in `sessions.ts`. Build and strict types pass; full suite: 86 total / 85 pass / 1 existing replacement fail, with the original assertion preserved. This is not a green suite or native UI evidence; task 5 was not executed.

**Result:** tests prove the existing application guarantees on the new SDK transport.

## Task 5. Final Verification and Documentation

**Files:** `README.md`, `AGENTS.md`, the entire agreed diff.

- [x] Update the transport description: the SDK handles JSON-RPC; the adapter handles process lifecycle and policy. List the SDK, peer dependency, and build; do not write “there are no new dependencies.”
- [x] Run:

```bash
npm run build
npm run check-types
npm test
npm run check
git diff --check
git status --short
```

Expected: exit code 0 and successful execution of old and new regressions. The project has no separate lint step.

- [x] Review the diff for a duplicate RPC parser/correlation map, experimental SDK imports, client filesystem/terminal capabilities, a new HTTP client, and weakened permission policy. None of these changes must be present.
- [ ] Run the native API smoke test on the built extension; it does not replace sending a request.
- [ ] Separately verify in real VS Code: response and streaming; real tool cards; explicit approval and rejection; Stop during a response and a permission request; the next request; window reload and continuation of the saved session.
- [ ] Run the manual check without `--extensionTestsPath`, with isolated editor profile/extensions from the project instructions and manual Workspace Trust. Do not publish raw logs without checking for secrets.
- [x] Record results separately: fixture/backend tests, smoke, and manual native UI. Leave unverified items explicitly unverified; SDK migration alone does not prove native Send.

Boundary for task 02.5: README/AGENTS describe exact SDK 1.7.0 / zod 3.25.76, CommonJS bundling, and the SDK/adapter policy split. Fresh build, strict types, check, and diff-check pass. `npm test` was run, but exit **1**: 86 total / 85 pass / 1 original replacement fail; skipped/todo/cancelled — 0. The command execution item is checked for execution, not for exit 0 from all commands. The agreed baseline exception allows completion of the automated migration work, but not a claim that the suite is green or the release is ready.

Aggregate review fixes after 02.5: the existing reader preserves validated optional image/resource-link fields, annotations, and `_meta` in supported tool content; live/history and an independent fixture `session/load` regression were added, and the session-info callback was separated out. There are now 90 tests; clean exact `npm ci`, build/types/check/audit, and focused 6/6 pass. Latest `npm test` under host load: 90 total / 83 pass / 6 fail / 1 cancelled, skipped/todo — 0. Additional sequential run: 90 total / 86 pass / 4 fail, cancelled/skipped/todo — 0. Besides the byte-identical replacement baseline, short transport deadline/test timeouts are observed; diagnostics with an ordinary deadline of 30 s produce the expected protocol errors. Assertions and deadlines were unchanged. A baseline-only full-suite result after the fixes requires rechecking on an unloaded host; this is not approval.

The diff was reviewed by the implementer; independent whole-plan review and the commit remain with the coordinator. Fixture/backend tests do not replace the editor: the new native API smoke test and manual UI checks were not run because manual Workspace Trust/user participation was unavailable. The corresponding items remain unverified. Historical UI observations before the TypeScript/build migration are preserved separately; there are no new UI confirmations. Before distributing bundles/VSIX, a separate check of license texts/notices for the SDK (Apache-2.0) and zod (MIT) is required.

## Sources for the Verified Contract

- [Official TypeScript library](https://agentclientprotocol.com/libraries/typescript).
- [SDK 1.7.0: package.json](https://github.com/agentclientprotocol/typescript-sdk/blob/v1.7.0/package.json) — ESM and peer dependency `zod`.
- [SDK 1.7.0: fluent client example](https://github.com/agentclientprotocol/typescript-sdk/blob/v1.7.0/src/examples/client.ts).
- [SDK 1.7.0: ACP API](https://github.com/agentclientprotocol/typescript-sdk/blob/v1.7.0/src/acp.ts) — `client`, connection, typed methods.
- [SDK 1.7.0: stream](https://github.com/agentclientprotocol/typescript-sdk/blob/v1.7.0/src/stream.ts) — NDJSON, the limit, and parse-error behavior.
- [OpenCode V2 ACP](https://opencode.ai/v2/docs/cli/acp/) — protocol v1, private server, sessions, and credentials.

**Completion criterion:** the custom RPC implementation is replaced by the SDK, all application guarantees are preserved, and changes are confirmed by checks with explicitly stated UI evidence boundaries.
