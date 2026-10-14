import { Machine } from "@typeonce/effect-machine";
import { Context, Deferred, Effect, Queue, Schema } from "effect";
import type { ContentBlock, PromptResponse, RequestPermissionRequest, RequestPermissionResponse, SessionUpdate } from "@agentclientprotocol/sdk";
import type { AcpClient } from "../acp";
import type { SessionRecord, SessionStatus } from "../sessions";
import type { SessionOwner } from "./session";
import { errorMessage } from "../protocol";

export const TurnState = Machine.state({
  fields: { sessionId: Schema.String },
  states: {
    Preparing: { states: { Config: {}, Load: {}, Template: {}, Files: {} } },
    Active: { states: { Running: {}, Cancelling: {} } },
    Completed: {}, Cancelled: {}, Failed: { fields: { error: Schema.instanceOf(Error) } },
  },
});
export const TurnEvents = Machine.events({ Stop: {}, Failure: { error: Schema.instanceOf(Error) } });
export class TurnServices extends Context.Service<TurnServices, {
  readonly config: Effect.Effect<void, Error>;
  readonly load: Effect.Effect<void, Error>;
  readonly template: Effect.Effect<void, Error>;
  readonly files: Effect.Effect<void, Error>;
  readonly prompt: Effect.Effect<PromptResponse, Error>;
  readonly permissions: Effect.Effect<never>;
  readonly cancel: Effect.Effect<void>;
  readonly complete: Effect.Effect<void>;
  readonly stopped: Effect.Effect<void>;
  readonly failed: (error: Error) => Effect.Effect<void>;
}>()("opencode/machines/TurnServices") {}

export const TurnMachine = Machine.make({
  id: "TurnMachine", root: TurnState, input: Schema.String, events: TurnEvents,
  effects: {
    config: Effect.gen(function* () { yield* (yield* TurnServices).config; }),
    load: Effect.gen(function* () { yield* (yield* TurnServices).load; }),
    template: Effect.gen(function* () { yield* (yield* TurnServices).template; }),
    files: Effect.gen(function* () { yield* (yield* TurnServices).files; }),
    prompt: Effect.gen(function* () { return yield* (yield* TurnServices).prompt; }),
    permissions: Effect.gen(function* () { return yield* (yield* TurnServices).permissions; }),
    cancel: Effect.gen(function* () { yield* (yield* TurnServices).cancel; }),
    complete: Effect.gen(function* () { yield* (yield* TurnServices).complete; }),
    stopped: Effect.gen(function* () { yield* (yield* TurnServices).stopped; }),
    failed: Effect.fnUntraced(function* (error: Error) { yield* (yield* TurnServices).failed(error); }),
  },
}).handle({
  root: ({ input }) => ({ sessionId: input }),
  initial: { target: "Preparing" },
  states: {
    Preparing: {
      initial: { target: "Preparing.Config" },
      on: { Stop: { target: "Cancelled" }, Failure: { target: "Failed", data: ({ event }) => ({ error: event.error }) } },
      states: {
        Config: { invoke: { src: "config", onDone: { target: "Preparing.Load" }, onFailure: { target: "Failed", data: ({ error }) => ({ error }) } } },
        Load: { invoke: { src: "load", onDone: { target: "Preparing.Template" }, onFailure: { target: "Failed", data: ({ error }) => ({ error }) } } },
        Template: { invoke: { src: "template", onDone: { target: "Preparing.Files" }, onFailure: { target: "Failed", data: ({ error }) => ({ error }) } } },
        Files: { invoke: { src: "files", onDone: { target: "Active" }, onFailure: { target: "Failed", data: ({ error }) => ({ error }) } } },
      },
    },
    Active: {
      initial: { target: "Active.Running" },
      // Prompt invocation belongs to Active. Moving between its children retains
      // SDK await; Stop never interrupts or abandons a correlated ACP request.
      invoke: [
        { src: "prompt", onDone: { target: "Completed" }, onFailure: { target: "Failed", data: ({ error }) => ({ error }) } },
        { src: "permissions" },
      ],
      states: {
        Running: { on: { Stop: { target: "Active.Cancelling" }, Failure: { none: true } } },
        Cancelling: { on: { Stop: { none: true }, Failure: { none: true } }, invoke: { src: "cancel", onDone: { none: true } } },
      },
    },
    Completed: { invoke: { src: "complete", onDone: { none: true } } },
    Cancelled: { invoke: { src: "stopped", onDone: { none: true } } },
    Failed: { invoke: { src: "failed", input: ({ state }) => state.error, onDone: { none: true } } },
  },
});

export const startTurnMachine = (sessionId: string) => Machine.start(TurnMachine, sessionId);

export interface TurnHost {
  isCurrent(connection: AcpClient): boolean;
  status(record: SessionRecord, status: SessionStatus): void;
  permission(params: RequestPermissionRequest, signal: AbortSignal): string | undefined | Promise<string | undefined> | Effect.Effect<string | undefined, unknown>;
  log(text: string): void;
}

interface PermissionOperation {
  params: RequestPermissionRequest;
  done: Deferred.Deferred<RequestPermissionResponse>;
}

export class TurnOwner {
  readonly controller = new AbortController();
  readonly projection: NonNullable<SessionRecord["turn"]>;
  readonly done = Deferred.makeUnsafe<PromptResponse, Error>();
  private readonly stopped = Deferred.makeUnsafe<void>();
  private readonly cancelWritten = Deferred.makeUnsafe<void>();
  private readonly ref = Deferred.makeUnsafe<Effect.Success<ReturnType<typeof this.start>>, Error>();
  private readonly permissions = new Set<symbol>();
  private readonly permissionQueue = Effect.runSync(Queue.unbounded<PermissionOperation>());
  private readonly pendingPermissions = new Set<PermissionOperation>();
  private connection?: AcpClient;
  private started = false;
  private finished = false;
  private failure?: Error;
  private wireText: string;
  private context: ContentBlock[] = [];
  private result: PromptResponse = { stopReason: "cancelled" };
  private readonly abort: () => void;
  private readonly changed: () => void;

  constructor(readonly record: SessionRecord, private readonly session: SessionOwner, private readonly host: TurnHost,
    private readonly text: string, private readonly signal: AbortSignal, onUpdate: (update: SessionUpdate) => void,
    private readonly beforeSend: () => void, private readonly pendingConfig?: Effect.Effect<void, Error>,
    private readonly prepareText?: () => Effect.Effect<string, Error>, private readonly prepareContext?: () => Effect.Effect<ContentBlock[], Error>,
    private readonly diagnostic: (stage: string, state?: string) => void = () => {}) {
    this.wireText = text;
    this.projection = { controller: this.controller, onUpdate };
    this.abort = () => this.controller.abort();
    this.changed = () => {
      Deferred.doneUnsafe(this.stopped, Effect.void);
      this.dispatch(this.failure ? TurnEvents.Failure({ error: this.failure }) : TurnEvents.Stop());
    };
    signal.addEventListener("abort", this.abort, { once: true });
    this.controller.signal.addEventListener("abort", this.changed, { once: true });
    if (signal.aborted) this.controller.abort();
  }

  fail(error: Error) {
    this.failure = error;
    Deferred.doneUnsafe(this.cancelWritten, Effect.void);
    this.controller.abort();
  }

  private dispatch(event: ReturnType<typeof TurnEvents.Stop> | ReturnType<typeof TurnEvents.Failure>) {
    Effect.runFork(Deferred.await(this.ref).pipe(Effect.flatMap((ref) => ref.send(event)), Effect.ignore));
  }

  private check() {
    if (this.failure) throw this.failure;
    if (this.controller.signal.aborted) throw new Error("[Sessions.prompt] Cancelled before submission");
    if (this.record.turn !== this.projection) throw new Error("[Sessions.prompt] Stale turn");
  }

  private stage(work: Effect.Effect<void, Error>) {
    return Effect.try({ try: () => this.check(), catch: toError }).pipe(Effect.andThen(work));
  }

  private start() {
    const self = this;
    const services = TurnServices.of({
      config: this.stage(Effect.suspend(() => {
        if (!self.pendingConfig) return Effect.void;
        self.diagnostic("acp.config.wait");
        return self.pendingConfig.pipe(Effect.tap(() => Effect.sync(() => self.diagnostic("acp.config.ready"))));
      })),
      load: this.stage(Effect.gen(function* () {
        self.diagnostic("acp.load.wait");
        yield* self.session.loadEffect();
        yield* Effect.try({ try: () => self.check(), catch: toError });
        self.connection = self.record.connection;
        if (!self.connection) return yield* Effect.fail(new Error(`[Sessions.prompt] Missing connection sessionId=${self.record.id}`));
        self.diagnostic("acp.load.ready");
      })),
      template: this.stage(Effect.suspend(() => self.prepareText ? self.prepareText() : Effect.succeed(self.text)).pipe(
        Effect.catchDefect((error) => Effect.fail(toError(error))),
        Effect.tap((text) => Effect.sync(() => { self.wireText = text; })), Effect.asVoid)),
      files: this.stage(Effect.suspend(() => self.prepareContext ? self.prepareContext() : Effect.succeed([])).pipe(
        Effect.catchDefect((error) => Effect.fail(toError(error))),
        Effect.tap((context) => Effect.sync(() => { self.context = context; })), Effect.asVoid)),
      prompt: Effect.uninterruptible(Effect.tryPromise({
        try: () => {
          // No await between current checks, history commit and SDK request
          // initiation. runPromise starts the lazy transport effect synchronously.
          self.check();
          const connection = self.connection!;
          if (!self.host.isCurrent(connection)) throw connection.failure ?? new Error("[Sessions.prompt] Stale connection");
          self.beforeSend();
          self.check();
          if (!self.host.isCurrent(connection)) throw connection.failure ?? new Error("[Sessions.prompt] Stale connection");
          self.session.appendUser(self.wireText, self.text);
          self.started = true;
          const response = Effect.runPromise(connection.requestEffect("session/prompt", { sessionId: self.record.id,
            prompt: [{ type: "text", text: self.wireText }, ...self.context] }, 0));
          self.diagnostic("acp.rpc.start");
          self.host.status(self.record, "inProgress");
          return response;
        }, catch: toError,
      }).pipe(Effect.tap((result) => Effect.sync(() => {
        self.result = result;
        const stopReason = ["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"].includes(result.stopReason) ? result.stopReason : "other";
        self.diagnostic("acp.rpc.complete", `stopReason=${stopReason}`);
      })))),
      cancel: Effect.suspend(() => {
        const connection = self.connection;
        if (!self.started || !connection || connection.failure) return Deferred.succeed(self.cancelWritten, undefined).pipe(Effect.asVoid);
        return Effect.scoped(Effect.gen(function* () {
          const elapsed = yield* Deferred.make<void>();
          yield* Effect.acquireRelease(Effect.sync(() => setTimeout(() => {
            connection.dispose();
            Deferred.doneUnsafe(elapsed, Effect.void);
          }, 5000)),
            (timer) => Effect.sync(() => clearTimeout(timer)));
          yield* connection.notifyEffect("session/cancel", { sessionId: self.record.id }).pipe(Effect.catch((error) => Effect.sync(() => {
            connection.fail(new Error(`[Sessions.prompt] session/cancel sessionId=${self.record.id}: ${errorMessage(error)}`));
          })));
          // Pickers close synchronously on Stop, but their ACP responses must not
          // overtake cancel in the machine mailbox and finish the prompt first.
          yield* Deferred.succeed(self.cancelWritten, undefined);
          yield* Deferred.await(elapsed);
        }));
      }),
      permissions: this.observePermissions(),
      complete: Effect.sync(() => self.finish(self.result)),
      stopped: Effect.sync(() => { self.diagnostic("acp.cancelled"); self.finish({ stopReason: "cancelled" }); }),
      failed: (error) => Effect.sync(() => { self.diagnostic("acp.failed"); self.finish(undefined, error); }),
    });
    return startTurnMachine(this.record.id).pipe(Effect.provideService(TurnServices, services));
  }

  runEffect(): Effect.Effect<PromptResponse, Error> {
    const self = this;
    return Effect.scoped(Effect.gen(function* () {
      yield* Effect.addFinalizer(() => Effect.sync(() => {
        Deferred.doneUnsafe(self.ref, Effect.fail(self.failure ?? new Error("[Sessions.prompt] Turn closed")));
        if (!self.finished) self.finish(undefined, self.failure ?? new Error("[Sessions.prompt] Sessions disposed"));
      }));
      const ref = yield* self.start().pipe(Effect.mapError(toError));
      yield* Deferred.succeed(self.ref, ref);
      // Ref.join observes machine failure, not an operation acknowledgement.
      // A defective source/startup must not strand the correlated completion.
      return yield* Effect.raceFirst(Deferred.await(self.done), ref.join.pipe(
        Effect.mapError(toError),
        Effect.flatMap(() => Effect.fail(new Error("[Sessions.prompt] Turn ended without completion"))),
      ));
    }));
  }

  private finish(result?: PromptResponse, error?: Error) {
    if (this.finished) return;
    this.finished = true;
    this.diagnostic("acp.cleanup");
    this.signal.removeEventListener("abort", this.abort);
    this.controller.signal.removeEventListener("abort", this.changed);
    this.controller.abort();
    Deferred.doneUnsafe(this.stopped, Effect.void);
    Deferred.doneUnsafe(this.cancelWritten, Effect.void);
    for (const operation of this.pendingPermissions) Deferred.doneUnsafe(operation.done, Effect.succeed({ outcome: { outcome: "cancelled" } }));
    this.pendingPermissions.clear();
    const current = this.record.turn === this.projection;
    if (current) this.record.turn = undefined;
    if (error) {
      if (current) this.host.status(this.record, this.signal.aborted ? "completed" : "failed");
      Deferred.doneUnsafe(this.done, this.signal.aborted ? Effect.succeed({ stopReason: "cancelled" }) : Effect.fail(error));
    } else {
      if (current && (this.started || result?.stopReason !== "cancelled")) this.host.status(this.record, "completed");
      Deferred.doneUnsafe(this.done, Effect.succeed(result ?? { stopReason: "cancelled" }));
    }
  }

  permissionEffect(params: RequestPermissionRequest): Effect.Effect<RequestPermissionResponse> {
    return Effect.suspend(() => {
      if (!this.started || this.finished || this.record.loading || this.record.turn !== this.projection)
        return Effect.succeed({ outcome: { outcome: "cancelled" } });
      if (this.controller.signal.aborted)
        return Deferred.await(this.cancelWritten).pipe(Effect.as({ outcome: { outcome: "cancelled" } }));
      const operation: PermissionOperation = { params, done: Deferred.makeUnsafe<RequestPermissionResponse>() };
      this.pendingPermissions.add(operation);
      Queue.offerUnsafe(this.permissionQueue, operation);
      return Deferred.await(operation.done);
    });
  }

  private observePermissions(): Effect.Effect<never> {
    const self = this;
    return Effect.scoped(Effect.forever(Effect.gen(function* () {
      const operation = yield* Queue.take(self.permissionQueue);
      yield* self.decidePermissionEffect(operation.params).pipe(
        Effect.tap((response) => Deferred.succeed(operation.done, response)),
        Effect.ensuring(Effect.sync(() => {
          self.pendingPermissions.delete(operation);
          Deferred.doneUnsafe(operation.done, Effect.succeed({ outcome: { outcome: "cancelled" } }));
        })),
        Effect.forkScoped,
      );
    })));
  }

  private decidePermissionEffect(params: RequestPermissionRequest): Effect.Effect<RequestPermissionResponse> {
    const self = this;
    const cancelled: RequestPermissionResponse = { outcome: { outcome: "cancelled" } };
    return Effect.scoped(Effect.gen(function* () {
      if (!self.started || self.finished || self.record.loading || self.record.turn !== self.projection) return cancelled;
      if (self.controller.signal.aborted) {
        yield* Deferred.await(self.cancelWritten);
        return cancelled;
      }
      yield* Effect.acquireRelease(Effect.sync(() => {
        const token = Symbol();
        self.permissions.add(token);
        self.host.status(self.record, "needsInput");
        return token;
      }), (token) => Effect.sync(() => {
        self.permissions.delete(token);
        if (!self.finished && self.record.turn === self.projection && !self.controller.signal.aborted)
          self.host.status(self.record, self.permissions.size ? "needsInput" : "inProgress");
      }));
      const optionId = yield* Effect.raceFirst(
        Effect.suspend(() => {
          const decision = self.host.permission(params, self.controller.signal);
          return Effect.isEffect(decision) ? decision : Effect.tryPromise({ try: async () => decision, catch: toError });
        }).pipe(Effect.catchDefect((error) => Effect.fail(toError(error)))),
        Deferred.await(self.stopped).pipe(Effect.as(undefined)),
      ).pipe(Effect.catch((error) => Effect.sync(() => {
        self.host.log(`[Sessions.requestPermission] sessionId=${self.record.id}: ${errorMessage(error)}\n`);
        return undefined;
      })));
      if (self.controller.signal.aborted && self.started) yield* Deferred.await(self.cancelWritten);
      if (typeof optionId !== "string" || self.controller.signal.aborted || self.finished || self.record.turn !== self.projection ||
          !self.connection || !self.host.isCurrent(self.connection) || !params.options.some((option) => option.optionId === optionId)) return cancelled;
      return { outcome: { outcome: "selected", optionId } };
    }));
  }
}

const toError = (error: unknown): Error => error instanceof Error ? error : new Error(errorMessage(error));
