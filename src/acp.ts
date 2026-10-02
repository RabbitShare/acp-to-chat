import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";
import { errorMessage, isObject } from "./protocol";

interface ClientOptions {
  cwd?: string;
  onRequest?: (method: string, params: unknown) => unknown | Promise<unknown>;
  onLog?: (text: string) => void;
}

type RequestId = string | number | null;
type OutgoingMessage =
  | { method: string; params: unknown; id?: RequestId }
  | { id: RequestId; result: unknown }
  | { id: RequestId; error: { code: number; message: string } };

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
  method: string;
}

export class AcpClient extends EventEmitter<{ notification: [method: string, params: unknown]; failure: [error: Error] }> {
  pending: Map<RequestId, PendingRequest>;
  nextId: number;
  buffer: string;
  decoder: StringDecoder;
  onRequest: ClientOptions["onRequest"];
  child: ChildProcessWithoutNullStreams;
  failure?: Error;
  disposing = false;
  capabilities: { loadSession?: boolean } = {};

  constructor(command: string, args: string[], { cwd, onRequest, onLog = () => {} }: ClientOptions) {
    super();
    this.pending = new Map<RequestId, PendingRequest>();
    this.nextId = 0;
    this.buffer = "";
    this.decoder = new StringDecoder("utf8");
    this.onRequest = onRequest;
    this.child = spawn(command, args, { cwd, shell: false, stdio: ["pipe", "pipe", "pipe"] });

    this.child.stdout.on("data", (chunk: Buffer) => {
      try {
        this.buffer += this.decoder.write(chunk);

        if (this.buffer.length > 16 * 1024 * 1024) {
          throw new Error("[AcpClient.receive] ACP message exceeds 16 MiB");
        }

        let newline;
        while ((newline = this.buffer.indexOf("\n")) !== -1) {
          const line = this.buffer.slice(0, newline);
          this.buffer = this.buffer.slice(newline + 1);
          if (line.trim()) this.receive(JSON.parse(line));
        }
      } catch (error) {
        this.fail(new Error(`[AcpClient.receive] Invalid ACP protocol/JSON: ${errorMessage(error)}`));
        this.child.kill();
      }
    });
    this.child.stderr.on("data", (chunk: Buffer) => onLog(chunk.toString()));
    this.child.stdin.on("error", (error) => this.fail(new Error(`[AcpClient.write] ${error.message}`)));
    this.child.on("error", (error) => this.fail(new Error(`[AcpClient.spawn] command=${command} cwd=${cwd}: ${error.message}`)));
    this.child.on("close", (code, signal) => this.fail(new Error(`[AcpClient.exit] code=${code} signal=${signal}`)));
  }

  write(message: OutgoingMessage) {
    if (this.failure) throw this.failure;
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  }

  request(method: string, params: unknown, timeout = 30000): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);

    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = timeout > 0 ? setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`[AcpClient.request] method=${method} id=${id} timed out after ${timeout}ms`));
      }, timeout) : undefined;

      this.pending.set(id, { resolve, reject, timer, method });

      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method: string, params: unknown) {
    this.write({ method, params });
  }

  receive(message: unknown) {
    if (!isObject(message) || message.jsonrpc !== "2.0") {
      throw new Error("[AcpClient.receive] Missing JSON-RPC 2.0 envelope");
    }

    if (typeof message.method === "string") {
      if (message.id !== undefined) {
        if (message.id !== null && typeof message.id !== "string" && typeof message.id !== "number") {
          throw new Error("[AcpClient.receive] Invalid request id");
        }
        this.answer({ id: message.id, method: message.method, params: message.params }).catch((error: unknown) =>
          this.fail(error instanceof Error ? error : new Error(errorMessage(error))));
      } else {
        this.emit("notification", message.method, message.params);
      }
      return;
    }

    if (message.id !== null && typeof message.id !== "string" && typeof message.id !== "number") return;
    const request = this.pending.get(message.id);
    if (!request) return;

    this.pending.delete(message.id);
    clearTimeout(request.timer);

    if (message.error) {
      const error = isObject(message.error) ? message.error : {};
      request.reject(new Error(`[AcpClient.request] method=${request.method} id=${message.id} code=${error.code}: ${error.message}`));
    } else if ("result" in message) {
      request.resolve(message.result);
    } else {
      request.reject(new Error(`[AcpClient.receive] Invalid response id=${message.id} method=${request.method}`));
    }
  }

  async answer(message: { id: RequestId; method: string; params: unknown }) {
    let response: { result: unknown } | { error: { code: number; message: string } };

    try {
      if (!this.onRequest) throw new Error("Unsupported client request");
      response = { result: await this.onRequest(message.method, message.params) };
    } catch (error) {
      response = { error: { code: -32601, message: `[AcpClient.answer] method=${message.method}: ${errorMessage(error)}` } };
    }

    if (!this.failure) this.write({ id: message.id, ...response });
  }

  fail(error: Error) {
    if (this.failure) return;
    this.failure = error;

    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(`[AcpClient.request] method=${request.method}: ${error.message}`));
    }

    this.pending.clear();
    this.emit("failure", error);
  }

  dispose() {
    if (this.disposing) return;
    this.disposing = true;
    this.fail(new Error("[AcpClient.dispose] Connection closed"));
    this.child.stdin.end();
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
