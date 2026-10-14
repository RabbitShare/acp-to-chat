# Native image and binary attachments implementation plan

> **For agentic workers:** Use `executing-plans` for implementation. Track steps with the checkboxes below. Run one final verification and review pass after implementation, not a review after every task.

**Goal:** Forward every included file attachment, including pasted images and arbitrary binary files, to OpenCode without treating it as slash metadata or silently discarding it.

**Architecture:** Extend the existing Effect-native context preparation in `src/session-files.ts` with one typed reference classifier. ConnectionMachine projects negotiated ACP capabilities; TurnMachine retains ownership of preparation, submission, permissions, and cancellation. Text uses embedded text resources, images use image blocks, audio uses audio blocks only when negotiated, and other binary data uses blob resources.

**Tech stack:** Node >=22.19, TypeScript 7.0.2, Effect 4.0.2, Effect Machine 0.40.0, ACP SDK 1.7.0, zod 3.25.76, VS Code 1.140.0 proposed APIs.

**Spec:** This plan's approved contract, `docs/plans/binary-attachments.md#approved-contract--october-14-2026`.

**Requirements source:** User requested all file types and approved sending contents rather than only paths. The reported failing attachment is an image. This document incorporates the revised plan for the Effect migration at baseline `a5432a8`; recheck current files before implementing.

## Approved contract — October 14, 2026

The user approved the ACP-native approach, capability-gating, the limits below, and regression/native verification. This update retains the earlier plan and adds the agreed audio contract and per-attachment binary limit. Saving this plan does not start implementation.

- Text files and exact selections retain the existing 32-reference and 1 MiB combined UTF-8 limits. Count all file/media inputs against the 32-reference ceiling; command metadata does not count as file content.
- Binary attachments have a 4 MiB raw-byte limit per attachment and an 8 MiB combined raw-byte limit per Send, before base64 encoding. These budgets are separate from the text budget.
- Images require `promptCapabilities.image === true`; audio requires `promptCapabilities.audio === true`; embedded text/blob resources require `promptCapabilities.embeddedContext === true`.
- Absent, false, null, or malformed capabilities never approve support. A capability mismatch rejects the entire Send before history/RPC. No silent dropping, truncation, text conversion, resource-link fallback, or audio-as-blob workaround.
- Keep the technical bridge's direct generation rejection; advertise image input there for native Chat. This does not assert that every selected backend model supports vision.
- Preserve unsaved text, Location ranges, slash ownership/freshness, accepted configuration operations, single-flight load, permissions, Stop, lazy drafts, and the edit/Retry prohibition.

### Diagnosis and remaining evidence

`src/session-commands.ts` currently accepts only recognized text-file Uri/Location references or live issued command URIs. A native `ChatReferenceBinaryData` image fails this guard with the screenshot's `Unsupported or foreign prompt reference` error. `src/session-files.ts` also rejects binary content, and `src/extension.ts` advertises `imageInput: false`. Removing only the guard or changing only the bridge cannot implement image forwarding.

The screenshot also contains a `Pasted 259 lines` attachment. Native pasted text and snapshotted files can arrive as string-valued references, not ordinary Uri/Location values. Capture their exact version-pinned conversion contract before finalizing classification; do not accept every string reference as a file or weaken external prompt rejection.

Public source inspected during discussion was OpenCode **2.0.21**, which advertises image/embeddedContext and converts image/blob blocks. The locally installed executable reported **2.0.24**. That version output is not proof of its capability response or media interpretation; recheck its exact public tag and actual initialize response before native testing. Audio support is conditional, not claimed for this executable. Context7 lookup failed; exact public sources remain the contract reference.

## Global constraints

- Work only in this repository. Do not add dependencies without user agreement.
- Keep native Chat/ACP architecture, participant/session/scheme `opencode`, and extension ID `RabbitShare.opencode-native-chat`.
- Validate proposed APIs against public VS Code **1.140.0** sources, not `main` or local installation files.
- Preserve current unsaved text, exact Location ranges, Workspace Trust, and explicit permissions.
- Keep command ownership/freshness validation separate from file classification. External prompt customizations remain rejected; attaching the same file as ordinary file content does not execute it.
- Preserve ACP v1, `clientCapabilities: {}`, `mcpServers: []`, `shell: false`, synchronous turn admission, and application/generation/turn Scope ownership.
- Do not replace the native Scope runner with ManagedRuntime or add Promise orchestration beside the machines. Existing Promise facades remain compatibility boundaries.
- Preserve accepted setter and session-owned load across Stop of a waiting turn. Preserve the active SDK prompt await during cancellation.
- No edit/Retry/checkpoint enablement, history-mismatch fix, HTTP transport, client filesystem/terminal capabilities, or machine snapshot persistence.
- No automatic commits, pushes, editor launches, or real model prompts. Native verification requires separate user authorization.
- Forwarding a format does not guarantee that OpenCode or the selected model can interpret it. Report transport/preparation failures accurately; do not promise universal model support.

## File ownership

| File | Planned responsibility |
| --- | --- |
| `src/session-files.ts` | Classify native references; prepare bounded text/image/blob blocks using Effect IO. |
| `src/session-commands.ts` | Accept classified file inputs while retaining command ownership/freshness guards. |
| `src/acp.ts` | Add typed projected image/audio capabilities; retain physical transport policy. |
| `src/machines/connection.ts` | Project `embeddedContext`, `image`, and `audio` with strict boolean checks during initialize. |
| `src/extension.ts` | Supply capabilities to preparation and advertise image input on the technical bridge; add binary API access only if required by the pinned proposal. |
| `src/machines/turn.ts` | Only if needed: synchronous complete-payload size check before history/RPC. Do not change state topology or invocation ownership. |
| `package.json`, `types/vscode.proposed.chatReferenceBinaryData.d.ts` | Enable native image attachments and vendor the exact pinned proposal. |
| `scripts/check.cjs`, `test/extension.test.js`, `test/fixtures/agent.cjs` | Manifest assertions, native doubles, exact ACP payloads, and capability scenarios. |
| `test/connection.test.js`, `test/session-machines.test.js` | Extend existing capability, preparation/submission, interruption, and ownership regressions. |
| `README.md`, `docs/development.md`, `AGENTS.md` | Explain supported transport, limits, model limitations, and preserved ownership. |

## Contract references

- Read `docs/development.md`, sections "Effect runtime and machine ownership" and "Transport and limits", and `docs/plans/effect-migration.md` before orchestration edits.
- [VS Code 1.140.0 binary reference proposal](https://github.com/microsoft/vscode/blob/1.140.0/src/vscode-dts/vscode.proposed.chatReferenceBinaryData.d.ts).
- [VS Code 1.140.0 native reference conversion](https://github.com/microsoft/vscode/blob/1.140.0/src/vs/workbench/api/common/extHostTypeConverters.ts), namespace `ChatPromptReference`.
- [VS Code 1.140.0 attachment capability schema](https://github.com/microsoft/vscode/blob/1.140.0/src/vs/workbench/contrib/chat/browser/chatSessions/chatSessions.contribution.ts).
- [OpenCode 2.0.21 ACP content conversion](https://github.com/anomalyco/opencode/blob/v2.0.21/packages/cli/src/acp/content.ts) and [capability advertisement](https://github.com/anomalyco/opencode/blob/v2.0.21/packages/cli/src/acp/service.ts). Recheck the actual OpenCode version before native testing; keep SDK payloads compatible with installed 1.7.0 types/schemas.

## Task 1: Reproduce native image rejection

- [ ] Verify `ChatReferenceBinaryData`, image attachment enablement, pasted-text conversion, and native binary-file routing against the public editor version under test. Record exact reference shapes without logging attachment contents, prompts, secrets, or arbitrary provider errors.
- [ ] Add a double matching VS Code's `ChatReferenceBinaryData(mimeType, data)` constructor and `data(): Thenable<Uint8Array>`. Model optional `reference`, `isPasted`, and `isURL` properties without changing the public constructor.
- [ ] Add a regression through the shared native request handler with a binary image value, not a URI or a fabricated object. Exercise saved participant/content and first untitled Send.
- [ ] Assert an exact ACP image block; retain the original rejection as RED evidence before implementation. Example expected block:

```js
{ type: "image", mimeType: "image/png", data: Buffer.from(imageBytes).toString("base64") }
```

- [ ] Build before running focused tests:

```sh
npm run build
node --test --test-name-pattern='image attachment' test/extension.test.js
```

## Task 2: Native binary classification and image forwarding

- [ ] Vendor the pinned proposal and enable `chatReferenceBinaryData` in `enabledApiProposals`. Add `supportsImageAttachments: true`; keep other non-file attachment capabilities disabled.
- [ ] Change only bridge metadata to `imageInput: true`; its generation handler must still reject direct use. Add the native binary class to `EditorApi` only if the pinned public proposal requires runtime access.
- [ ] Extend `AcpClient.capabilities` with `image?: boolean` and `audio?: boolean`. Project approvals in ConnectionMachine from nested prompt capabilities using strict equality, matching embeddedContext. Inspect the raw-validation boundary so SDK optional normalization cannot turn malformed capabilities into approval. Absent/null/malformed values never approve support.
- [ ] Extend the canonical reference classifier with distinct text-file, binary-data, and command-metadata cases. For binary data, use a narrow structural guard matching the pinned native wrapper: nonempty reference ID, valid `mimeType`, callable `data`, and a validated optional source Uri. Do not recognize arbitrary objects or command URIs as binary data. Reject invalid MIME/source shapes before IO; validate the returned bytes after reading. Keep command ownership/freshness validation independent.
- [ ] Pass the consumed capability projection to `prepareFileContextEffect`; update the exported Promise facade and its direct tests consistently. Keep native callers Effect-based.
- [ ] Read pasted/attached binary values through `data()` inside `Effect.tryPromise`. Do not download a reference URL or reread a local path instead of these bytes. Require a `Uint8Array` result and preserve its exact byteOffset/byteLength.
- [ ] For `image/*`, require negotiated image support and emit base64 `image` blocks. Preserve a validated optional source URI as metadata only; URI-less clipboard images work.
- [ ] For `audio/*`, require negotiated audio support and emit base64 `audio` blocks. Reject audio without that capability even if embeddedContext is true; never disguise audio as a generic blob. The block shape is `{ type: "audio", mimeType, data: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64") }`.
- [ ] Reject read failures, invalid byte results, and unsupported capabilities before history/RPC with fixed attachment-specific errors that expose no payload or arbitrary provider error text.

## Task 3: Arbitrary binary files without regressing text

- [ ] For loaded text documents, retain current text and exact validated ranges. Do not replace dirty editor content with disk bytes.
- [ ] For unopened whole-file URI references, use `workspace.fs.stat` and bounded reads in Effects. Reuse `workspace.openTextDocument` where needed to preserve editor decoding. Read binary bytes through `workspace.fs.readFile` only for an identified binary file, not as fallback for permissions/read failures. Preserve existing scheme/ID checks; do not scan unrelated documents or fetch arbitrary URLs.
- [ ] Treat a file as text only when decoding is valid and it is not identified as binary. Invalid UTF-8 must not become replacement-character text. Known binary formats must not be misclassified merely because they have no NUL bytes.
- [ ] Identify common image/PDF MIME from signatures and/or filename metadata; use `application/octet-stream` for unknown binary types. MIME recognition is not a file-extension admission whitelist.
- [ ] Emit other native binary values and non-image binary files as embedded blob resources, requiring embeddedContext. Supply a stable resource URI; for URI-less binary values use a generated non-fetchable attachment URI, never payload bytes or untrusted raw reference IDs.
- [ ] Never fall back from an invalid/unreadable Location to the entire file. Preserve explicit errors for inaccessible files and invalid ranges.
- [ ] Keep the existing 32-reference and 1 MiB aggregate text limits. Add a 4 MiB raw-byte per-binary-attachment limit and an 8 MiB aggregate raw binary budget, checked before base64 conversion and after each read. Validate stat sizes before opening unopened files; a larger stat size alone must not prevent a valid Location from sending only its bounded selection. Document that stat/read is not an atomic filesystem snapshot.
- [ ] Check complete serialized prompt parameters against a 16 MiB outgoing budget before appending history and creating the SDK request. Account for base64, JSON escaping, text, URI/MIME metadata, and session ID. The existing 16 MiB incoming limit is a separate transport rule.
- [ ] Keep preparation within TurnMachine's existing Files stage. Preserve final reference/history/command and generation checks with no asynchronous gap before history/RPC.
- [ ] Add reproduction coverage for the screenshot's pasted-text attachment alongside a Location. If the pinned native contract delivers a recognized paste/snapshot string, forward its exact contents with bounded text semantics; reject command/customization strings and unknown reference IDs. Never reread disk instead of an editor-provided text snapshot.

## Task 4: Behavioral coverage and documentation

- [ ] Assert exact bytes/MIME for pasted and file-backed images, audio with `audio: true`, non-image native binary values, PDF, archive, and unknown-extension binary files. Verify that native binary data does not cause filesystem/HTTP reads. Validate image/audio/blob payloads against SDK 1.7.0 schema using the existing schema-test helpers.
- [ ] Cover mixed text/image/blob/slash inputs and the next ordinary Send. Preserve stale/foreign/external prompt rejection before any data/file IO.
- [ ] Cover absent/false/null/malformed image/audio/embeddedContext capabilities, invalid MIME/data/URI, rejected `data()`, unreadable files, unsupported schemes, count/text/binary/serialized-payload limits, and failure without history/RPC. Exercise exact binary boundaries (4 MiB per input and 8 MiB combined), one byte over each, and Uint8Array subviews with nonzero byteOffset.
- [ ] Exercise Stop and Effect interruption during binary reading; release delayed reads afterward and assert no late prompt/history. Cover command revocation and shared-connection failure during preparation.
- [ ] Preserve dirty text, exact ranges, lazy draft activation, setter/load survival, permission cancellation, and prohibited edit/Retry regressions. Binary contents do not enter workspaceState.
- [ ] Update docs and manifest checks to distinguish accepted attachment formats from backend/model interpretation. Record new limits and native verification gaps; retain historical evidence.

## Final task: Verification and review

- [ ] Run the complete suite and checks after implementation:

```sh
npm test
npm run check
npm run visualize:build
git diff --check
```

- [ ] Require exit 0, no failed/cancelled tests, strict type/manifest success, and three Ready machines without diagnostics in `.effect-machine/site/machines.json`. Visualization does not replace runtime evidence.
- [ ] Run independent Standards, Spec, Security, and Test reviews once on the complete diff; fix blocking findings and repeat affected verification. Review against this plan and the explicit user requirement, not the old text-only limitation.
- [ ] Obtain authorization for native verification. Build and fully restart the development host with the new proposal enabled; do not use extensionTestsPath or bypass Workspace Trust.
- [ ] Verify an image with distinctive visual content reaches a vision-capable model without tool/disk fallback. Repeat for a clipboard image, mixed text/image Send, next Send, and Stop. Test another binary format supported by the chosen backend/model separately.
- [ ] Repeat the screenshot's pasted YAML plus selection scenario, then test dirty text, exact selections, native binary-file attachment, and slash metadata mixed with attachments. Verify streaming, tools, Allow/Reject/Escape, Model/Agent/Reasoning, and continuation after Reload without enabling edit/Retry. Test audio acceptance only with a capable agent; otherwise confirm the explicit pre-prompt rejection.
- [ ] Report actual native observations and residual format/model limitations. Do not claim arbitrary binary interpretation, complete release approval, or automatic commit authorization.
