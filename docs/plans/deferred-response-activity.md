# Deferred response activity implementation plan

> **For agentic workers:** Use the approved contract below and execute the checkbox tasks in order. Use `executing-plans` for a checkpointed implementation. Recording this plan does not authorize implementation, commits, pushes, editor launches, or real model prompts.

**Goal:** Preserve incremental native Markdown streaming while displaying reasoning and tool activity only after the entire ACP prompt finishes successfully.

**Architecture:** Add a small turn-local presentation buffer at the native adapter boundary. Text goes directly to the native stream; reasoning and final tool projections wait until prompt completion. Reuse the same presentation ordering when projecting history; do not change backend orchestration or raw history.

**Tech stack:** Node >=22.19, TypeScript 7.0.2, Effect 4.0.2, Effect Machine 0.40.0, ACP SDK 1.7.0, esbuild, VS Code native Chat proposed APIs with the 1.140.0 compatibility baseline.

**Spec:** The approved contract is recorded in this document. The user rejected Markdown-boundary scanning and full-response text buffering, selected deferring reasoning/tools until the whole response ends, and explicitly retained incremental text streaming.

## Approved contract

- `agent_message_chunk`: emit immediately through `stream.markdown`; preserve exact text, including whitespace and Markdown delimiters.
- `agent_thought_chunk`: accumulate for presentation; do not call `stream.push` during the active prompt.
- `tool_call` / `tool_call_update`: accumulate final state by literal `toolCallId`; do not call `stream.push` during the active prompt.
- Successful completion of the entire `session/prompt`: emit accumulated activity after all streamed text. This is a prompt boundary, not a Markdown, message-ID, reasoning, or model-step boundary.
- Stop, cancelled prompt result, preparation failure, transport/RPC failure, or adapter interruption: discard pending live activity. Already streamed text remains visible. Cleanup must not flush activity.
- Permission Quick Picks and ACP permission responses stay immediate and independent of the presentation buffer. Tool execution itself is not delayed.
- History projection puts all response Markdown before reasoning/tools. Backend history remains authoritative and unmodified; no new persisted UI state is introduced.

## Global constraints

- Work only in this repository. Preserve native `chatSessionsProvider` / ACP; no webview, separate chat, editor patches, or built-in Agent Host.
- No new dependencies, Markdown parser, timers, debounce, text-buffer limits, or asynchronous presentation queue.
- Preserve custom application Scope/NativeRunner, synchronous reservations, correlated Deferred completion, connection-generation checks, and TurnMachine Active ownership.
- Preserve Workspace Trust, raw unknown guards, permission cancellation, literal IDs, metadata-only workspaceState, and edit/Retry prohibition.
- Do not derive presentation boundaries by splitting `messageId` or recognizing OpenCode-specific suffixes.
- Native grouping titles such as `Finished with 1 step` are editor-owned. Do not promise their exact count or wording without native evidence.
- Activity is intentionally not visible while a prompt is running. Text may be empty while tools run; do not insert progress parts into the Markdown stream as a workaround.

## Evidence and limitations

The Effect migration is commit `a5432a8`. The rechecked native path still immediately converts updates in `src/extension.ts` and sends Markdown/thinking/tool parts in arrival order. `Sessions.update` forwards accepted updates synchronously; TurnOwner stores the callback without transforming presentation order.

VS Code 1.140.0 merges only adjacent compatible Markdown parts. An intervening thinking/tool part can split a version, inline code, link, list, or fenced code block. A synthetic interleaved sequence reproduced the adapter's emitted part order. This demonstrates the mechanism, not a captured ACP trace or native reproduction of the user's exact session.

The user confirmed that the defect appears during streaming without subagents. Child-session metadata handling is a separate finding and is outside this plan.

Recheck baseline: `npm test` passed 335/335; `npm run check` passed. The API double currently assigns the same constructor to Markdown and thinking parts, so its `instanceof` routing does not reflect the native API.

Contract sources, checked against the editor version under test before implementation:

- [Markdown adjacency in the 1.140.0 response model](https://github.com/microsoft/vscode/blob/1.140.0/src/vs/workbench/contrib/chat/common/model/chatModel.ts).
- [Thinking/tool proposed types](https://github.com/microsoft/vscode/blob/1.140.0/src/vscode-dts/vscode.proposed.chatParticipantAdditions.d.ts).
- [Tool update conversion](https://github.com/microsoft/vscode/blob/1.140.0/src/vs/workbench/api/common/extHostTypeConverters.ts).

## File responsibilities

- `src/extension.ts`: a small exported turn renderer beside `renderUpdate`; live callback, successful completion flush, cleanup, and history projection.
- `test/extension.test.js`: distinct native-part doubles and presentation/adapter regressions.
- `test/fixtures/agent.cjs`: deterministic interleaved events and a held prompt-completion scenario over the existing real child fixture.
- `docs/development.md`: document activity-after-text behavior and separate automated evidence from native verification.
- `docs/plans/README.md`: index and implementation status of this plan.

Keep the renderer in `src/extension.ts` initially: this avoids a new bundle entry point and lets existing tests import it from `dist/extension.js`. Do not change `src/acp.ts`, `src/protocol.ts`, `src/sessions.ts`, machine ownership, dependencies, or build configuration for this presentation-only change.

## Task 1: Correct the test boundary and establish RED

- [ ] Separate the native-part doubles. Neither constructor may inherit from the other:

```js
class MarkdownPart { constructor(value) { this.value = value; } }
class ThinkingPart {
  constructor(value, id, metadata) { Object.assign(this, { value, id, metadata }); }
}
// In api().vscode:
// ChatResponseMarkdownPart: MarkdownPart,
// ChatResponseThinkingProgressPart: ThinkingPart,
```

- [ ] Extend `test/fixtures/agent.cjs` with a deterministic prompt scenario that emits the following events in order and holds the prompt response until an explicit test-controlled release. Add a named control message for release; do not use timing sleeps:

```text
agent_message_chunk: "Requirement: Node `22."
agent_thought_chunk: "Checking "
tool_call: toolCallId="check", name="bash", title="Run check", status="in_progress"
agent_message_chunk: "23`, `24`."
tool_call_update: toolCallId="check", status="completed", rawOutput="done"
agent_thought_chunk: "versions"
session/prompt response: { stopReason: "end_turn" }
```

- [ ] Assert text is visible before releasing the response and no thinking/tool part has been pushed. After release, assert every Markdown emission precedes every activity emission:

```js
assert.deepEqual(events.map(event => event.kind), ["markdown", "markdown"]);
assert.equal(events.map(event => event.text).join(""), "Requirement: Node `22.23`, `24`.");
// Release the held fixture response and await the request handler.
const firstActivity = events.findIndex(event => event.kind === "activity");
assert.ok(firstActivity >= 2);
assert.ok(events.slice(firstActivity).every(event => event.kind === "activity"));
```

- [ ] Observe the new ordering regression fail against the current implementation. Build before focused tests; record actual RED evidence, not just an expected failure.

```bash
npm run build
node --test --test-name-pattern='deferred activity' test/extension.test.js
```

## Task 2: Add the minimal presentation buffer

**Interface:** Export `createTurnRenderer` from `src/extension.ts`. It consumes validated `SessionUpdate` values and sends the existing `RenderedPart` union synchronously through an injected emitter. Its intended public shape is:

```ts
type TurnPartEmitter = (part: RenderedPart) => void;

interface TurnRenderer {
  accept(update: SessionUpdate): void;
  finish(): void;
  discard(): void;
}

function createTurnRenderer(emit: TurnPartEmitter): TurnRenderer;
```

- [ ] Implement the renderer using `renderUpdate` and a turn-local tool map. `accept` emits text immediately and retains only activity needed for the final presentation; it must not retain another full copy of the streamed text or raw turn history.
- [ ] Keep first-appearance activity order. For each `toolCallId`, replace the buffered tool slot with the latest merged part rather than appending every partial update. Preserve name/title/input/output/content and failed/incomplete status through existing merge rules.
- [ ] Emit each buffered tool as a standalone final projection with `enablePartialUpdate = false`. Its initial invocation was never sent, so a partial-update-only part would have nothing to update. Apply the same rule in replay.
- [ ] Aggregate adjacent buffered thinking chunks with exact string concatenation. Use literal optional IDs to avoid combining distinct known reasoning IDs; do not parse IDs. Preserve separation when a tool intervenes. Omit empty thinking parts instead of manufacturing empty activity groups.
- [ ] Make `finish` and `discard` idempotent. Clear maps/arrays on either terminal operation. No events are accepted or emitted after termination; `discard` emits nothing.
- [ ] Add focused renderer checks for exact text, interleaving, multiple tools, update-without-initial-call, failed/incomplete tools, null fallback fields, thinking aggregation, empty thought chunks, and repeated terminal calls. Preserve Markdown `isTrusted = false` and `supportHtml = false`.

## Task 3: Integrate live streaming and history

- [ ] Create one renderer per `requestEffect` invocation. Its emitter retains the existing routing: Markdown uses `stream.markdown(part.value)`; activity uses `stream.push(part)`.
- [ ] Replace the immediate render callback with `renderer.accept(update)`. Keep synchronous backend prompt admission and reference/history/config preparation ordering unchanged.
- [ ] Await the complete prompt result. Flush only if the abort signal is not aborted, the request token is not cancelled, and the returned `stopReason` is not `cancelled`. A resolved cancelled response is not successful activity completion.
- [ ] Check cancellation before each queued emission so synchronous cancellation triggered by a stream callback cannot leak the rest of the buffer.
- [ ] Call `renderer.discard()` from the existing Effect cleanup path. Do not place a flush in `Effect.ensuring`; failure/interruption must discard activity. Preserve thrown native errors and reservation cleanup if a stream callback throws.
- [ ] Project each existing assistant history turn through the same renderer: collect emitted text parts, call `finish`, then construct `ChatResponseTurn2`. Do not regroup backend turns, rewrite stored updates, or change message-ID/history admission guards.
- [ ] Verify recovery expectations explicitly: Stop/error suppression applies to the live stream. A later ACP load can replay activity saved by OpenCode; it must appear after text, without pretending failed/incomplete tools succeeded. Do not delete backend history to hide it.
- [ ] Add adapter regressions for saved and first untitled Send, successful text-only/activity-only responses, cancelled result without an aborted token, Stop/error after text, disposal/interruption, next Send after Stop, permission Allow/Reject/Escape while tool UI is deferred, replay ordering, and two-session buffer isolation.

## Task 4: Final verification and documentation

- [ ] Run focused RED/GREEN checks and the complete automated suite after implementation:

```bash
npm run build
node --test --test-name-pattern='deferred activity' test/extension.test.js
npm test
npm run check
git diff --check
```

Expect no test failures/cancellations/skips, strict type and manifest checks passing, and no whitespace errors. The 335/335 baseline is historical; report the actual new test count.

- [ ] Review the diff against this contract: no early activity push, no text buffering/parser, no delayed permissions, no flush on Stop/error, no lost tool fields, and no new persistence or orchestration owner. Machine visualization is not required unless machine files are changed; such changes require a separate scope decision.
- [ ] Update `docs/development.md` and this plan's status with real automated evidence. Keep historical native observations and label new native checks pending until separately observed.
- [ ] With separate editor/model authorization, build and reload the tested editor; observe incremental text containing split version tokens, inline code, links, lists and fenced code, while reasoning/tools appear only after completion. Separately observe permission UI before completion, Stop, subsequent Send, activity-only responses, and replay after Reload.

No native success claim follows from fixture tests, a source/model probe, or the API smoke test. Do not promise a single `Finished with ...` heading; verify only the selected ordering and uninterrupted Markdown behavior.

## Status

- [x] Approved behavior recorded; Effect code rechecked.
- [ ] Implementation and focused RED/GREEN evidence.
- [ ] Final automated verification and documentation.
- [ ] Separate native UI verification.
