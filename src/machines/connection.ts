import { Machine } from "@typeonce/effect-machine";
import { Context, Deferred, Effect, Fiber, Schema, Scope } from "effect";
import { AcpClient, type ClientOptions } from "../acp";
import { isObject } from "../protocol";

export const ConnectionState = Machine.state({
  fields: { generation: Schema.Number },
  states: {
    Idle: {},
    Starting: {},
    Initializing: { fields: { client: Schema.instanceOf(AcpClient) } },
    Ready: { fields: { client: Schema.instanceOf(AcpClient) } },
    Failed: { fields: { error: Schema.instanceOf(Error) } },
    Closing: {},
    Closed: {},
  },
});

export const ConnectionEvents = Machine.events({
  Connect: {},
  Failure: { error: Schema.instanceOf(Error) },
  Close: {},
});

/** Sources are lazy. The generation scope, not the Starting invocation, owns ACP. */
export class ConnectionServices extends Context.Service<ConnectionServices, {
  readonly start: Effect.Effect<AcpClient, Error>;
  readonly initialize: (client: AcpClient) => Effect.Effect<AcpClient, Error>;
  readonly ready: (client: AcpClient) => Effect.Effect<void>;
  readonly failed: (error: Error) => Effect.Effect<void>;
  readonly close: Effect.Effect<void>;
  readonly closed: Effect.Effect<void>;
}>()("opencode/machines/ConnectionServices") {}

export const ConnectionMachine = Machine.make({
  id: "ConnectionMachine",
  root: ConnectionState,
  input: Schema.Number,
  events: ConnectionEvents,
  effects: {
    start: Effect.gen(function* () { return yield* (yield* ConnectionServices).start; }),
    initialize: Effect.fnUntraced(function* (client: AcpClient) { return yield* (yield* ConnectionServices).initialize(client); }),
    ready: Effect.fnUntraced(function* (client: AcpClient) { yield* (yield* ConnectionServices).ready(client); }),
    failed: Effect.fnUntraced(function* (error: Error) { yield* (yield* ConnectionServices).failed(error); }),
    close: Effect.gen(function* () { yield* (yield* ConnectionServices).close; }),
    closed: Effect.gen(function* () { yield* (yield* ConnectionServices).closed; }),
  },
}).handle({
  root: ({ input }) => ({ generation: input }),
  initial: { target: "Idle" },
  states: {
    Idle: { on: { Connect: { target: "Starting" }, Close: { target: "Closing" } } },
    Starting: {
      on: { Close: { target: "Closing" }, Failure: { target: "Failed", data: ({ event }) => ({ error: event.error }) } },
      invoke: {
        src: "start",
        onDone: { target: "Initializing", data: ({ output }) => ({ client: output }) },
        onFailure: { target: "Failed", data: ({ error }) => ({ error }) },
      },
    },
    Initializing: {
      on: { Close: { target: "Closing" }, Failure: { target: "Failed", data: ({ event }) => ({ error: event.error }) } },
      invoke: {
        src: "initialize", input: ({ state }) => state.client,
        onDone: { target: "Ready", data: ({ output }) => ({ client: output }) },
        onFailure: { target: "Failed", data: ({ error }) => ({ error }) },
      },
    },
    Ready: {
      on: { Close: { target: "Closing" }, Failure: { target: "Failed", data: ({ event }) => ({ error: event.error }) } },
      invoke: { src: "ready", input: ({ state }) => state.client, onDone: { none: true } },
    },
    Failed: {
      invoke: { src: "failed", input: ({ state }) => state.error, onDone: { target: "Closing" } },
    },
    Closing: { invoke: { src: "close", onDone: { target: "Closed" } } },
    Closed: { invoke: { src: "closed", onDone: { none: true } } },
  },
});

export interface ConnectionOptions extends ClientOptions {
  command: string;
  args: string[];
  /** Install generation-guarded notification/failure listeners before initialize. */
  onClient?: (client: AcpClient) => void;
}

const startMachine = (generation: number) => Machine.start(ConnectionMachine, generation);
export type ConnectionRef = Effect.Success<ReturnType<typeof startMachine>>;

export interface ConnectionOwner {
  readonly generation: number;
  readonly client: AcpClient | undefined;
  readonly ref: ConnectionRef;
  connectEffect(): Effect.Effect<AcpClient, Error>;
  connect(): Promise<AcpClient>;
  disposeEffect(): Effect.Effect<void>;
  dispose(): void;
}

/** One owner per generation. Reconnect means a new owner, never restarting Closed.
 * Completion is registered before Connect dispatch. Ready/Failed settle the same
 * Deferred for every joined caller; mailbox delivery is not operation completion.
 * The application supplies Scope. Closing it is terminal and joins child cleanup.
 */
export const makeConnection = Effect.fn("makeConnection")(function* (
  options: ConnectionOptions, generation: number,
): Effect.fn.Return<ConnectionOwner, never, Scope.Scope> {
  const scope = yield* Scope.Scope;
  const ready = yield* Deferred.make<AcpClient, Error>();
  const closed = yield* Deferred.make<void>();
  let client: AcpClient | undefined;
  let terminal = false;
  let started = false;
  let ref: ConnectionRef;
  const terminalError = new Error("[ConnectionMachine.dispose] Connection closed");

  const services = ConnectionServices.of({
    start: Effect.suspend(() => {
      if (terminal) return Effect.fail(terminalError);
      return Effect.acquireRelease(
        Effect.try({
          try: () => {
            client = new AcpClient(options.command, options.args, options);
            client.once("failure", (error) => {
              // The physical fatal latch is idempotent; the machine remains the
              // sole logical lifecycle owner. This event is not an RPC ack.
              Effect.runFork(ref.send(ConnectionEvents.Failure({ error })).pipe(Effect.forkIn(scope), Effect.flatMap(Fiber.join), Effect.ignore));
            });
            options.onClient?.(client);
            return client;
          },
          catch: (error) => error instanceof Error ? error : new Error(String(error)),
        }),
        (transport) => transport.disposeEffect(),
      ).pipe(Scope.provide(scope));
    }),
    initialize: (transport) => transport.requestEffect("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "opencode-native-chat", version: "0.0.1" },
      clientCapabilities: {},
    }).pipe(Effect.flatMap((result) => {
      if (!isObject(result) || result.protocolVersion !== 1) {
        return Effect.fail(new Error(`[Sessions.connect] Unsupported ACP protocolVersion=${isObject(result) ? result.protocolVersion : undefined}`));
      }
      const capabilities = result.agentCapabilities;
      if (isObject(capabilities) && (capabilities.loadSession === undefined || typeof capabilities.loadSession === "boolean")) {
        transport.capabilities = { ...capabilities,
          embeddedContext: isObject(capabilities.promptCapabilities) && capabilities.promptCapabilities.embeddedContext === true };
      }
      return Effect.succeed(transport);
    })),
    ready: (transport) => Deferred.succeed(ready, transport).pipe(Effect.asVoid),
    failed: (error) => Deferred.fail(ready, error).pipe(Effect.asVoid),
    close: Effect.gen(function* () {
      terminal = true;
      yield* Deferred.fail(ready, client?.failure ?? terminalError);
      if (client) yield* client.disposeEffect();
    }),
    closed: Deferred.succeed(closed, undefined).pipe(Effect.asVoid),
  });

  ref = yield* startMachine(generation).pipe(Effect.provideService(ConnectionServices, services), Effect.orDie);
  const connectEffect = () => Effect.suspend(() => {
    if (terminal || client?.failure) return Effect.fail(client?.failure ?? terminalError);
    if (started) return Deferred.await(ready);
    started = true;
    return ref.send(ConnectionEvents.Connect()).pipe(
      Effect.catch(() => Effect.fail(terminalError)),
      Effect.andThen(Deferred.await(ready)),
    );
  });
  const disposeEffect = () => Effect.uninterruptible(Effect.gen(function* () {
    terminal = true;
    // Close the SDK first. Exiting Initializing must not wait indefinitely for
    // an uninterruptible SDK await while Closing is still queued.
    client?.dispose();
    yield* ref.send(ConnectionEvents.Close()).pipe(Effect.ignore);
    yield* Deferred.await(closed);
  }));
  const owner: ConnectionOwner = {
    generation,
    get client() { return client; },
    ref,
    connectEffect,
    connect: () => Effect.runPromise(connectEffect()),
    disposeEffect,
    dispose: () => {
      terminal = true;
      client?.dispose();
      Effect.runFork(disposeEffect());
    },
  };
  yield* Effect.addFinalizer(() => owner.disposeEffect());
  return owner;
});
