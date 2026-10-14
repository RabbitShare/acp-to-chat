# Effect migration implementation contract

## Goal and approved constraints

Rewrite asynchronous orchestration using Effect and executable schema-first Effect Machine statecharts. Preserve the native VS Code 1.140.0 Chat/ACP architecture and all existing behavior and fail-closed protections. Provide the official graphical visualizer and topology-only simulation, not live runtime inspection.

- Pin TypeScript 7.0.2, Effect 4.0.2, Effect Machine 0.40.0 and matching devtools 0.40.0.
- Keep ACP SDK 1.7.0 and its zod peer. NDJSON, JSON-RPC IDs and correlation stay SDK-owned.
- Bundle runtime ESM dependencies into CJS; devtools remain development-only. Node development floor is 22.19.
- Keep participant/session/scheme `opencode`, bridge metadata, lazy generic drafts and eager Product New.
- Keep Workspace Trust, literal executable/environment, explicit permissions, no edit/Retry/checkpoints.
- Keep catalog atomic raw guards, revision-scoped selection membership, stale reference/history guards and all existing bounds.
- Keep one shared process, one synchronous reserved setter/turn per session, 30-second ordinary RPC deadline, no prompt deadline, five-second hung cancel escalation.
- Storage remains metadata only. Machine snapshots are not persisted or resumed for ACP recovery.
- No commits, pushes, editor launches or real model prompts are authorized by this implementation task.

## Ownership and operation protocol

ConnectionMachine owns logical connection startup, initialization, ready, failure and shutdown. Transport owns an idempotent fatal latch and physical SDK/process closure. SessionMachine owns load/configuration lifecycle, confirmed snapshots/revisions and history. TurnMachine owns preparation, submission, active prompt, permission observation and cancellation. Machines are executable owners, not diagrams layered over unchanged Promise orchestration.

The synchronous boundary reserves only operation tokens and exposes immediate lock projections before dispatch. Each accepted operation has a correlated completion registered before dispatch; mailbox delivery or `send` followed by `waitFor` is not an acknowledgement. Outcomes and cleanup check connection generation and operation identity. Confirmed data and revision commit atomically before events and completion. Consumers see current snapshots, never a lagging subscription used for security decisions.

Load is a session-owned single-flight operation. All joined callers receive its result, including failure. An accepted setter survives Stop of a waiting turn. Setter RPC failure/malformed response invalidates configuration; the waiting Send adds no turn and sends no prompt. A later operation recovers through a fresh load, without replaying the old setter.

Turn preparation orders accepted-config wait, load, template, referenced current file context, and final synchronous checks. Final guards, history append and SDK request creation have no asynchronous boundary between them. Invalid references perform no template/file IO. Preparation failure performs no history append or prompt RPC.

Active owns the prompt invocation while Running/Cancelling are children. Stop before submission sends no cancel. Stop after submission sends one handled asynchronous cancel and waits for prompt response or shared close. It does not directly interrupt the SDK-awaiting fiber. Permission requests are independently correlated and all pending pickers close on cancellation/failure; no late or empty choice approves anything.

Application lifetime owns machines and the session registry; connection generations own transport resources; turns own preparation/permission resources. UI binding disposal does not stop backend sessions. Terminal extension disposal forbids reconnect and preserves bounded child-process termination.

## File responsibilities

- `src/machines/connection.ts`, `session.ts`, `turn.ts`: exported state/event descriptors and concrete implemented `.handle` objects, lazy service-backed effects; no runtime vscode import, ACP launch or IO on import.
- `src/acp.ts`: SDK adapter, raw byte/envelope guards, scoped resources, physical process/failure policy and Effect RPC boundary.
- `src/sessions.ts`: synchronous admission and compatible native facade, authoritative machine-backed operations/projections and session registry.
- `src/extension.ts`, `session-options.ts`, `session-commands.ts`: native callbacks/projections, Promise only at VS Code boundaries.
- `src/command-templates.ts`, `session-files.ts`: Effect IO/preparation preserving exact parsers, current text, source precedence and bounds.
- `scripts/build.mjs`, `package.json`, lockfile: compiler/runtime/tooling and exported test entrypoints.
- Existing tests plus focused machine/runtime regression tests: preserve behavioral assertions; no source-text substitute for runtime checks.

## Execution ledger

- [x] Task 1: Upgrade compiler/dependencies; verify current strict types/CJS; add official devtools scripts and exclusions. TypeScript 7.0.2 strict check and CJS build pass; installed peers resolve without conflicts.
- [x] Task 2: Implement ConnectionMachine and Effect transport lifecycle; retain real child-fixture transport tests and add terminal disposal/single-flight checks. Focused transport/connection 42/42; full suite 309/309 and check pass. Integration into Sessions follows in Task 3.
- [x] Task 3: Implement SessionMachine and TurnMachine orchestration with synchronous admission, correlated completion, generation guards and current projections. Preserve full session/adapter regressions; add joined-load failure and same-turn concurrent permission coverage. Follow-up covers late permission isolation and explicit session failure outcomes.
- [x] Task 4: Convert remaining template/file/native asynchronous workflows to Effect at existing boundaries; preserve all raw guards, IO ordering and native contracts. Full suite 331/331 and check pass; scoped picker, template handles, Effect-native preparation and ordered metadata writer covered.
- [x] Task 5: Verify official discovery/static site and import safety; document commands, architecture, version floors and simulation limits; update stale development guidance. Root opened static and official source-watching devtools in Chrome: all three Ready, success/error/uncertain/Stop simulation and timeline branch replacement work. Docs preserve historical evidence and distinguish custom Scope runner from ManagedRuntime.
- [x] Task 6: Run full tests, strict checks, static visualizer build and diff check. Resolve aggregated session topology, late-permission, and config snapshot findings. Final root verification: 335/335 tests, strict check, three Ready machines, dependency pins, and clean diff check. Native release evidence remains separate and unclaimed.

## Verification and evidence

Focused tests require `npm run build` before `node --test`; flags precede filenames. New behavioral changes use observed RED before implementation and GREEN afterwards. Existing suite remains the regression baseline, not rewritten into topology assertions.

Final automated commands: `npm test`, `npm run check`, `npm run visualize:build`, `git diff --check`. Check dependency peers and devtools exclusion from runtime bundles. Read generated machine index to confirm all three expected machines without diagnostics. Open static visualizer and exercise simulation/timeline independently from runtime tests where browser tooling is available.

Critical cases: same-stack competing setter/Send; waiting Send setter failure/Stop; joined load success/failure; update/set response ordering; stale generation RPC/notification/permission/finalizer; retained prompt invoke during cancel; multiple permissions; shared timeout/cancel-write failure; revocation during preparation; bounded process cleanup; activation/draft without ACP; ordinary saved and first untitled Send; prohibited Retry/edit; dirty/ranged included files.

Fixture/API-double GREEN is not native release evidence. Native VS Code 1.140.0 Send/streaming/tools/permission/Stop/restart and selector/primary action isolation remain separately observed checks. Do not claim them verified by automated tests or topology simulation.
