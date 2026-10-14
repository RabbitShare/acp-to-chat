import { Machine } from "@typeonce/effect-machine";
import { Context, Deferred, Effect, Exit, Fiber, Schema, Scope } from "effect";
import type { AvailableCommand, SessionUpdate } from "@agentclientprotocol/sdk";
import type { AcpClient } from "../acp";
import type { SessionRecord } from "../sessions";
import { isObject, isTextContent, readConfigOptions, readOptionalString, type SelectConfigOption } from "../protocol";

export class SessionOperation {
  readonly done = Deferred.makeUnsafe<void, Error>();
  readonly promise = Effect.runPromise(Deferred.await(this.done));
  result: Exit.Exit<void, Error> = Exit.void;
  cleanup: () => void = () => {};
  constructor(readonly selection?: { configId: string; value: string; revision: number }) {
    // The facade can be observed by a waiting turn after admission, not necessarily
    // in the same stack. Keep the completion handle without an unhandled rejection.
    void this.promise.catch(() => {});
  }
  finish() {
    this.cleanup();
    Deferred.doneUnsafe(this.done, this.result);
  }
}

const operation = Schema.instanceOf(SessionOperation);
const completion = Schema.NullOr(operation);
export const SessionState = Machine.state({
  type: "parallel",
  states: {
    Load: { fields: {}, states: {
      Idle: { fields: { completed: completion } },
      Loading: { fields: { operation } },
      Failed: { fields: { operation } },
    } },
    Config: { fields: {}, states: { Idle: { fields: { completed: completion } }, Setting: { fields: { operation } }, Uncertain: { fields: { completed: operation } } } },
  },
});
export const SessionEvents = Machine.events({ Load: { operation }, Set: { operation } });
const SessionInternalEvents = Machine.internalEvents({ Loaded: {} });
export class SessionServices extends Context.Service<SessionServices, {
  readonly load: (operation: SessionOperation) => Effect.Effect<SessionOperation, Error>;
  readonly set: (operation: SessionOperation) => Effect.Effect<SessionOperation, Error>;
}>()("opencode/machines/SessionServices") {}

// Load and setter are separate regions: a setter can join session-owned load,
// while Stop only leaves the waiting TurnMachine, never either region here.
export const SessionMachine = Machine.make({
  id: "SessionMachine", root: SessionState, events: SessionEvents, internalEvents: SessionInternalEvents,
  effects: {
    load: Effect.fnUntraced(function* (op: SessionOperation) { return yield* (yield* SessionServices).load(op); }),
    set: Effect.fnUntraced(function* (op: SessionOperation) { return yield* (yield* SessionServices).set(op); }),
  },
}).handle({
  initial: { Load: {}, Config: {} },
  states: {
    Load: {
      initial: { target: "Load.Idle", data: { completed: null } },
      states: {
        Idle: {
          entry: ({ state }, enqueue) => {
            if (state.completed && Exit.isSuccess(state.completed.result)) enqueue.raise(SessionInternalEvents.Loaded());
            state.completed?.finish();
            return undefined;
          },
          on: { Load: { target: "Load.Loading", data: ({ event }) => ({ operation: event.operation }) } },
        },
        Loading: { invoke: { src: "load", input: ({ state }) => state.operation,
          onDone: { target: "Load.Idle", data: ({ output }) => ({ completed: output }) },
          onFailure: { target: "Load.Failed", data: ({ state }) => ({ operation: state.operation }) } } },
        Failed: {
          entry: ({ state }) => { state.operation.finish(); return undefined; },
          on: { Load: { target: "Load.Loading", data: ({ event }) => ({ operation: event.operation }) } },
        },
      },
    },
    Config: {
      initial: { target: "Config.Idle", data: { completed: null } },
      states: {
        Idle: {
          entry: ({ state }) => { state.completed?.finish(); return undefined; },
          on: { Set: { target: "Config.Setting", data: ({ event }) => ({ operation: event.operation }) } },
        },
        Setting: { invoke: { src: "set", input: ({ state }) => state.operation,
          onDone: { target: "Config.Idle", data: ({ output }) => ({ completed: output }) },
          onFailure: { target: "Config.Uncertain", data: ({ state }) => ({ completed: state.operation }) } } },
        Uncertain: {
          entry: ({ state }) => { state.completed.finish(); return undefined; },
          on: { Set: { target: "Config.Setting", data: ({ event }) => ({ operation: event.operation }) },
            Loaded: { target: "Config.Idle", data: { completed: null } } },
        },
      },
    },
  },
});

export const startSessionMachine = () => Machine.start(SessionMachine);

export interface SessionHost {
  connectEffect(): Effect.Effect<AcpClient, Error>;
  isCurrent(connection: AcpClient): boolean;
  isDisposed(): boolean;
  config(record: SessionRecord): void;
  commands(record: SessionRecord): void;
}

/** Compatible record is the synchronous authoritative projection, not a subscriber. */
export class SessionOwner {
  private loading?: SessionOperation;
  private setting?: SessionOperation;
  private readonly ref = Deferred.makeUnsafe<Effect.Success<ReturnType<typeof this.start>>, Error>();
  private started = false;

  constructor(readonly record: SessionRecord, private readonly host: SessionHost, private readonly scope: Scope.Scope) {}

  private start() {
    return startSessionMachine().pipe(Effect.provideService(SessionServices, SessionServices.of({
      load: (op) => this.capture(op, this.performLoad()),
      set: (op) => this.capture(op, this.performSet(op)),
    })));
  }

  private dispatch(event: ReturnType<typeof SessionEvents.Load> | ReturnType<typeof SessionEvents.Set>, op: SessionOperation) {
    if (!this.started) {
      this.started = true;
      Effect.runFork(this.start().pipe(Scope.provide(this.scope), Effect.forkIn(this.scope), Effect.flatMap(Fiber.join),
        Effect.tap((ref) => Deferred.succeed(this.ref, ref)),
        Effect.catch((error) => Deferred.fail(this.ref, new Error(String(error))))));
    }
    Effect.runFork(Deferred.await(this.ref).pipe(Effect.flatMap((ref) => ref.send(event)), Effect.forkIn(this.scope), Effect.flatMap(Fiber.join), Effect.catch((error) => Effect.sync(() => {
      op.result = Exit.fail(error instanceof Error ? error : new Error(String(error)));
      op.finish();
    }))));
  }

  loadEffect(): Effect.Effect<void, Error> {
    return Effect.suspend(() => {
      if (this.host.isDisposed()) return Effect.fail(new Error("[Sessions.load] Sessions disposed"));
      if (this.loading) return Deferred.await(this.loading.done);
      const connection = this.record.connection;
      if (connection && this.host.isCurrent(connection) && this.record.configValid) return Effect.void;
      const op = new SessionOperation();
      op.cleanup = () => {
        if (this.loading === op) { this.loading = undefined; this.record.loading = undefined; }
      };
      this.loading = op;
      this.record.loading = op.promise;
      this.dispatch(SessionEvents.Load({ operation: op }), op);
      return Deferred.await(op.done);
    });
  }

  set(configId: string, value: string, revision: number): Promise<void> {
    const op = new SessionOperation({ configId, value, revision });
    op.cleanup = () => {
      if (this.setting === op) {
        this.setting = undefined;
        this.record.configPending = undefined;
        this.host.config(this.record);
      }
    };
    this.setting = op;
    this.record.configPending = op.promise;
    this.host.config(this.record);
    this.dispatch(SessionEvents.Set({ operation: op }), op);
    return op.promise;
  }

  pendingConfigEffect(): Effect.Effect<void, Error> | undefined {
    return this.setting ? Deferred.await(this.setting.done) : undefined;
  }

  close(error: Error) {
    if (this.loading) {
      const op = this.loading;
      this.loading = undefined;
      this.record.loading = undefined;
      Deferred.doneUnsafe(op.done, Effect.fail(error));
    }
    if (this.setting) {
      const op = this.setting;
      this.setting = undefined;
      this.record.configPending = undefined;
      this.host.config(this.record);
      Deferred.doneUnsafe(op.done, Effect.fail(error));
    }
  }

  private capture(op: SessionOperation, work: Effect.Effect<void, Error>): Effect.Effect<SessionOperation, Error> {
    return work.pipe(
      Effect.tap(() => Effect.sync(() => { op.result = Exit.void; })),
      Effect.map(() => op),
      Effect.tapError((error) => Effect.sync(() => { op.result = Exit.fail(error); })),
    );
  }

  private performLoad(): Effect.Effect<void, Error> {
    const self = this;
    return Effect.gen(function* () {
      const connection = yield* self.host.connectEffect();
      if (!connection.capabilities.loadSession) return yield* Effect.fail(new Error(`[Sessions.load] Agent cannot load saved sessionId=${self.record.id}`));
      if (self.record.configValid) self.invalidateConfig();
      self.confirmCommands([]);
      self.record.history = [];
      const result = yield* connection.requestEffect("session/load", { sessionId: self.record.id, cwd: self.record.cwd, mcpServers: [] });
      if (!self.host.isCurrent(connection)) return yield* Effect.fail(connection.failure ?? new Error("[Sessions.load] Stale connection"));
      const configOptions = isObject(result) ? readConfigOptions(result.configOptions, true) : undefined;
      if (!configOptions) return yield* Effect.fail(new Error(`[Sessions.load] Invalid configOptions sessionId=${self.record.id}`));
      self.record.connection = connection;
      self.confirmConfig(configOptions);
    }).pipe(Effect.tapError(() => Effect.sync(() => self.confirmCommands([]))));
  }

  private performSet(op: SessionOperation): Effect.Effect<void, Error> {
    const self = this;
    return Effect.gen(function* () {
      yield* self.loadEffect();
      const selection = op.selection!;
      if (self.record.configRevision !== selection.revision) return yield* Effect.fail(new Error(`[Sessions.setConfigOption] Stale configuration sessionId=${self.record.id}`));
      const option = self.record.configOptions.find((item) => item.id === selection.configId);
      const available = option?.options.some((item) => "group" in item
        ? item.options.some((choice) => choice.value === selection.value) : item.value === selection.value);
      if (!available) return yield* Effect.fail(new Error(`[Sessions.setConfigOption] Unavailable selection configId=${selection.configId} sessionId=${self.record.id}`));
      const connection = self.record.connection;
      if (!connection) return yield* Effect.fail(new Error(`[Sessions.setConfigOption] Missing connection sessionId=${self.record.id}`));
      yield* Effect.gen(function* () {
        const result = yield* connection.requestEffect("session/set_config_option", { sessionId: self.record.id, configId: selection.configId, value: selection.value });
        if (!self.host.isCurrent(connection)) return yield* Effect.fail(connection.failure ?? new Error("[Sessions.setConfigOption] Stale connection"));
        const configOptions = isObject(result) ? readConfigOptions(result.configOptions) : undefined;
        if (!configOptions) return yield* Effect.fail(new Error(`[Sessions.setConfigOption] Invalid configOptions sessionId=${self.record.id}`));
        self.confirmConfig(configOptions);
      }).pipe(Effect.tapError(() => Effect.sync(() => {
        // Backend can mutate before RPC failure. Only fresh load confirms state.
        if (self.record.connection === connection) self.invalidateConfig();
      })));
    });
  }

  confirmConfig(options: SelectConfigOption[]) {
    this.record.configOptions = options;
    this.record.configRevision++;
    this.record.configValid = true;
    this.host.config(this.record);
  }

  invalidateConfig() {
    this.record.configOptions = [];
    this.record.configRevision++;
    this.record.configValid = false;
    this.host.config(this.record);
  }

  confirmCommands(commands: AvailableCommand[]) {
    this.record.availableCommands = commands;
    this.host.commands(this.record);
  }

  appendUser(text: string, nativeText: string) {
    this.record.history.push({ role: "user", text, ...(text === nativeText ? {} : { nativeText }) });
    if (this.record.label === "New OpenCode session") this.record.label = nativeText.slice(0, 80);
  }

  updateHistory(update: SessionUpdate) {
    const messageId = readOptionalString(update, "messageId");
    if (update.sessionUpdate === "user_message_chunk" && isTextContent(update.content)) {
      const last = this.record.history.at(-1);
      if (last?.role === "user" && last.messageId === messageId) last.text += update.content.text;
      else this.record.history.push({ role: "user", text: update.content.text, messageId });
    } else if (["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update"].includes(update.sessionUpdate)) {
      let last = this.record.history.at(-1);
      if (last?.role !== "assistant" || (messageId && last.messageId && messageId !== last.messageId)) {
        last = { role: "assistant", updates: [], messageId };
        this.record.history.push(last);
      }
      last.updates.push(update);
    }
  }
}
