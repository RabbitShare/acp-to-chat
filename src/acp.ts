import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import {
  client, ndJsonStream, RequestError,
  type AgentRequestMethod, type AgentRequestParamsByMethod, type AgentRequestResponsesByMethod,
  type AgentNotificationMethod, type AgentNotificationParamsByMethod, type ClientConnection,
  type RequestPermissionResponse, type AnyMessage,
} from "@agentclientprotocol/sdk";
import { errorMessage, isObject } from "./protocol";

interface ClientOptions {
  cwd?: string;
  onRequest?: (method: string, params: unknown) => RequestPermissionResponse | Promise<RequestPermissionResponse>;
  onLog?: (text: string) => void;
}

// Custom RPC is fixture-only; it cannot widen the standard method-map facade.
type FixtureMethod = "echo" | "fail" | "exit" | "invalid" | "invalid-request-id" |
  "client-callback" | "hang" | "invalid-envelope" | "oversized" | "stdout-eof";

export class AcpClient extends EventEmitter<{ notification: [method: string, params: unknown]; failure: [error: Error] }> {
  child: ChildProcessWithoutNullStreams;
  private connection: ClientConnection;
  failure?: Error;
  disposing = false;
  capabilities: { loadSession?: boolean } = {};

  constructor(command: string, args: string[], { cwd, onRequest, onLog = () => {} }: ClientOptions) {
    super();
    this.child = spawn(command, args, { cwd, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr.on("data", (chunk: Buffer) => onLog(chunk.toString()));
    this.child.stdin.on("error", (error) => this.fail(new Error(`[AcpClient.write] ${error.message}`)));
    this.child.stdout.on("error", (error) => this.fail(new Error(`[AcpClient.receive] ${error.message}`)));
    this.child.on("error", (error) => this.fail(new Error(`[AcpClient.spawn] command=${command} cwd=${cwd}: ${error.message}`)));
    this.child.on("close", (code, signal) => this.fail(new Error(`[AcpClient.exit] code=${code} signal=${signal}`)));

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
        const writer = output.getWriter();
        try {
          await writer.write(bytes);
        } finally {
          writer.releaseLock();
        }
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
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            this.child.off("close", done);
            resolve();
          };
          const timer = setTimeout(done, 100);
          this.child.once("close", done);
        });
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
    return this.withDeadline(method, timeout, () => this.connection.agent.request(method, params));
  }

  requestExtension(method: FixtureMethod, params: unknown, timeout = 30000): Promise<unknown> {
    return this.withDeadline(method, timeout, () => this.connection.agent.request(method, params));
  }

  private async withDeadline<Response>(method: string, timeout: number, send: () => Promise<Response>): Promise<Response> {
    if (this.failure) throw this.failure;
    const timer = timeout > 0 ? setTimeout(() => {
      // SDK cancellationSignal is cooperative, not force-settling. Closing the
      // shared connection settles all SDK pending requests and all its sessions.
      this.fail(new Error(`[AcpClient.request] method=${method} timed out after ${timeout}ms`));
    }, timeout) : undefined;
    try {
      return await send();
    } catch (error) {
      const code = error instanceof RequestError ? ` code=${error.code}` : "";
      throw new Error(`[AcpClient.request] method=${method}${code}: ${errorMessage(this.failure ?? error)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async notify<Method extends AgentNotificationMethod>(method: Method, params: AgentNotificationParamsByMethod[Method]): Promise<void> {
    if (this.failure) throw this.failure;
    try {
      await this.connection.agent.notify(method, params);
    } catch (error) {
      const failure = new Error(`[AcpClient.write] method=${method}: ${errorMessage(error)}`);
      this.fail(failure);
      throw this.failure ?? failure;
    }
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
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const terminate = setTimeout(() => this.child.kill("SIGTERM"), 2000);
    const force = setTimeout(() => this.child.kill("SIGKILL"), 3000);
    terminate.unref();
    force.unref();
    this.child.once("close", () => {
      clearTimeout(terminate);
      clearTimeout(force);
    });
  }
}
