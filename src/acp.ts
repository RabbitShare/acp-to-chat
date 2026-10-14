import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import { Deferred, Effect, Fiber } from "effect";
import {
  client, ndJsonStream, RequestError,
  type AgentRequestMethod, type AgentRequestParamsByMethod, type AgentRequestResponsesByMethod,
  type AgentNotificationMethod, type AgentNotificationParamsByMethod, type ClientConnection,
  type RequestPermissionResponse, type AnyMessage,
} from "@agentclientprotocol/sdk";
import { errorMessage, isObject } from "./protocol";

export interface ClientOptions {
  cwd?: string;
  env?: Record<string, string>;
  onRequest?: (method: string, params: unknown) => RequestPermissionResponse | Promise<RequestPermissionResponse>;
  onLog?: (text: string) => void;
}

// Custom RPC is fixture-only; it cannot widen the standard method-map facade.
type FixtureMethod = "echo" | "fail" | "exit" | "invalid" | "invalid-request-id" |
  "client-callback" | "hang" | "invalid-envelope" | "oversized" | "stdout-eof";

export class AcpClient extends EventEmitter<{ notification: [method: string, params: unknown]; failure: [error: Error] }> {
  child: ChildProcessWithoutNullStreams;
  readonly environment: NodeJS.ProcessEnv;
  private connection: ClientConnection;
  private childClosed = false;
  private disposal?: Fiber.Fiber<void>;
  failure?: Error;
  disposing = false;
  capabilities: { loadSession?: boolean; embeddedContext?: boolean } = {};

  constructor(command: string, args: string[], { cwd, env, onRequest, onLog = () => {} }: ClientOptions) {
    super();
    if (env !== undefined && (!isObject(env) || Object.entries(env).some(([key, value]) =>
      !key || /[=\0]/.test(key) || typeof value !== "string" || value.includes("\0")))) {
      throw new Error("[AcpClient.spawn] Invalid launch environment: expected variable names and string values without NUL");
    }
    this.environment = { ...process.env, ...env };
    this.child = spawn(command, args, { cwd, env: this.environment, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr.on("data", (chunk: Buffer) => onLog(chunk.toString()));
    this.child.stdin.on("error", (error) => this.fail(new Error(`[AcpClient.write] ${error.message}`)));
    this.child.stdout.on("error", (error) => this.fail(new Error(`[AcpClient.receive] ${error.message}`)));
    this.child.on("error", (error) => this.fail(new Error(`[AcpClient.spawn] command=${command} cwd=${cwd}: ${error.message}`)));
    this.child.on("close", (code, signal) => {
      this.childClosed = true;
      this.fail(new Error(`[AcpClient.exit] code=${code} signal=${signal}`));
    });

    const output = Writable.toWeb(this.child.stdin);
    const guardedOutput = new WritableStream<Uint8Array>({
      write: async (bytes) => {
        if (this.failure) throw this.failure;
        // SDK 1.7.0 writes whole serialized messages here, including parse errors
        // that bypass stream.writable. Inspect only SDK output, never frame input.
        const message: unknown = JSON.parse(new TextDecoder().decode(bytes));
        if (isObject(message) && message.id === null && isObject(message.error) &&
            (message.error.code === -32700 || message.error.code === -32600)) {
          const data = message.error.data;
          const invalidId = isObject(data) && "id" in data && data.id !== null &&
            typeof data.id !== "string" && typeof data.id !== "number";
          const error = new Error(invalidId ? "[AcpClient.receive] Invalid request id" :
            `[AcpClient.receive] Invalid ACP protocol/JSON: ${message.error.message}`);
          this.fail(error);
          throw error;
        }
        await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
          const writer = yield* Effect.acquireRelease(
            Effect.sync(() => output.getWriter()),
            (writer) => Effect.sync(() => writer.releaseLock()),
          );
          yield* Effect.promise(() => writer.write(bytes));
        })));
      },
    });
    // Node's Web Streams declaration makes a done result's value optional;
    // lib.dom requires it. The native byte stream implements the same runtime API.
    const input = Readable.toWeb(this.child.stdout) as unknown as ReadableStream<Uint8Array>;
    const stream = ndJsonStream(guardedOutput, input, { maxMessageBytes: 16 * 1024 * 1024 });
    // Malformed response-shaped objects can be ignored by SDK correlation. Check
    // only the already decoded envelope; parsing, framing and IDs remain SDK-owned.
    const readable = stream.readable.pipeThrough(new TransformStream<AnyMessage, AnyMessage>({
      transform: (message, controller) => {
        if (!isObject(message) || message.jsonrpc !== "2.0") {
          throw new Error("[AcpClient.receive] Missing JSON-RPC 2.0 envelope");
        }
        controller.enqueue(message);
      },
      flush: async () => {
        if (this.child.exitCode !== null || this.child.signalCode !== null) return;
        // Stdio EOF precedes child close. Briefly wait for exit context, but an
        // agent that closes stdout while alive must still fail without a deadline.
        await Effect.runPromise(Effect.raceFirst(this.awaitChildClose(), Effect.sleep(100)));
      },
    }));
    const handleRequest = async (method: string, params: unknown) => {
      try {
        if (!onRequest) throw new Error("Unsupported client request");
        return await onRequest(method, params);
      } catch (error) {
        throw new RequestError(-32601, `[AcpClient.answer] method=${method}: ${errorMessage(error)}`);
      }
    };
    // Preserve the original unknown guards before SDK optional-field salvage.
    const rawParams = (value: unknown) => value;
    this.connection = client({ name: "opencode-native-chat" })
      .onRequest("session/request_permission", rawParams, async ({ params }): Promise<RequestPermissionResponse> =>
        handleRequest("session/request_permission", params))
      .onRequest("client/callback", rawParams, ({ params }) => handleRequest("client/callback", params))
      .onNotification("session/update", rawParams, ({ params }) => { this.emit("notification", "session/update", params); })
      .connect({ ...stream, readable });
    void this.connection.closed.then(() => {
      if (this.failure) return;
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        this.fail(new Error(`[AcpClient.exit] code=${this.child.exitCode} signal=${this.child.signalCode}`));
      } else {
        const reason = errorMessage(this.connection.signal.reason);
        this.fail(new Error(`[AcpClient.receive] ${reason === "ACP connection closed" ? "Unexpected ACP EOF" : reason}`));
      }
    });
  }

  request<Method extends AgentRequestMethod>(method: Method, params: AgentRequestParamsByMethod[Method], timeout = 30000): Promise<AgentRequestResponsesByMethod[Method]> {
    return Effect.runPromise(this.requestEffect(method, params, timeout));
  }

  requestEffect<Method extends AgentRequestMethod>(method: Method, params: AgentRequestParamsByMethod[Method], timeout = 30000): Effect.Effect<AgentRequestResponsesByMethod[Method], Error> {
    return this.withDeadline(method, timeout, () => this.connection.agent.request(method, params));
  }

  requestExtension(method: FixtureMethod, params: unknown, timeout = 30000): Promise<unknown> {
    return Effect.runPromise(this.requestExtensionEffect(method, params, timeout));
  }

  requestExtensionEffect(method: FixtureMethod, params: unknown, timeout = 30000): Effect.Effect<unknown, Error> {
    return this.withDeadline(method, timeout, () => this.connection.agent.request(method, params));
  }

  private withDeadline<Response>(method: string, timeout: number, send: () => Promise<Response>): Effect.Effect<Response, Error> {
    const self = this;
    // Interrupting an SDK-awaiting fiber is not cancellation. Only shared close
    // settles the SDK promise; retain its await until a response or that close.
    return Effect.uninterruptible(Effect.scoped(Effect.gen(function* () {
      if (self.failure) return yield* Effect.fail(self.failure);
      if (timeout > 0) {
        yield* sleep(timeout).pipe(
          Effect.andThen(Effect.sync(() => self.fail(new Error(`[AcpClient.request] method=${method} timed out after ${timeout}ms`)))),
          Effect.interruptible,
          Effect.forkScoped,
        );
      }
      return yield* Effect.tryPromise({
        try: send,
        catch: (error) => {
          const code = error instanceof RequestError ? ` code=${error.code}` : "";
          return new Error(`[AcpClient.request] method=${method}${code}: ${errorMessage(self.failure ?? error)}`);
        },
      });
    })));
  }

  notify<Method extends AgentNotificationMethod>(method: Method, params: AgentNotificationParamsByMethod[Method]): Promise<void> {
    return Effect.runPromise(this.notifyEffect(method, params));
  }

  notifyEffect<Method extends AgentNotificationMethod>(method: Method, params: AgentNotificationParamsByMethod[Method]): Effect.Effect<void, Error> {
    return Effect.uninterruptible(Effect.suspend(() => {
      if (this.failure) return Effect.fail(this.failure);
      return Effect.tryPromise({
        try: () => new Promise<void>((resolve, reject) => {
          // SDK notification awaits its write queue, not pendingResponses. A
          // blocked writer must still settle when the shared connection closes.
          const signal = this.connection.signal;
          const failed = (error: unknown) => {
            signal.removeEventListener("abort", close);
            reject(error);
          };
          const close = () => failed(signal.reason);
          signal.addEventListener("abort", close, { once: true });
          if (signal.aborted) { close(); return; }
          try { void this.connection.agent.notify(method, params).then(() => {
            signal.removeEventListener("abort", close);
            resolve();
          }, failed); }
          catch (error) { failed(error); }
        }),
        catch: (error) => {
          const failure = new Error(`[AcpClient.write] method=${method}: ${errorMessage(error)}`);
          this.fail(failure);
          return this.failure ?? failure;
        },
      });
    }));
  }

  fail(error: Error) {
    if (this.failure) return;
    this.failure = error;
    this.connection?.close(error);
    this.emit("failure", error);
    this.dispose();
  }

  dispose() {
    if (this.disposing) return;
    this.disposing = true;
    this.fail(new Error("[AcpClient.dispose] Connection closed"));
    this.connection.close(this.failure);
    this.child.stdin.end();
    const self = this;
    this.disposal = Effect.runFork(Effect.scoped(Effect.gen(function* () {
      if (self.child.exitCode === null && self.child.signalCode === null) {
        yield* sleep(2000, { unref: true }).pipe(Effect.andThen(Effect.sync(() => { self.child.kill("SIGTERM"); })), Effect.forkScoped);
        yield* sleep(3000, { unref: true }).pipe(Effect.andThen(Effect.sync(() => { self.child.kill("SIGKILL"); })), Effect.forkScoped);
      }
      yield* self.awaitChildClose();
    })));
  }

  /** Joins physical cleanup; the synchronous facade still reserves disposal immediately. */
  disposeEffect(): Effect.Effect<void> {
    return Effect.uninterruptible(Effect.suspend(() => {
      this.dispose();
      return this.disposal ? Fiber.join(this.disposal) : Effect.void;
    }));
  }

  private awaitChildClose(): Effect.Effect<void> {
    return Effect.callback((resume) => {
      if (this.childClosed) {
        resume(Effect.void);
        return;
      }
      const done = () => resume(Effect.void);
      this.child.once("close", done);
      return Effect.sync(() => this.child.off("close", done));
    });
  }
}

// Scope clears the handle on success as well as interruption (including an
// injected deadline callback). Node's unref preserves idle-extension shutdown.
const sleep = Effect.fnUntraced(function* (milliseconds: number, options: { unref?: boolean } = {}) {
  const elapsed = yield* Deferred.make<void>();
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      const timer = setTimeout(() => Deferred.doneUnsafe(elapsed, Effect.void), milliseconds);
      if (options.unref) timer.unref();
      return timer;
    }),
    (timer) => Effect.sync(() => clearTimeout(timer)),
  );
  yield* Deferred.await(elapsed);
}, Effect.scoped);
