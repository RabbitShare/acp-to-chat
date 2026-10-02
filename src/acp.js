"use strict";

const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { StringDecoder } = require("node:string_decoder");

class AcpClient extends EventEmitter {
  constructor(command, args, { cwd, onRequest, onLog = () => {} }) {
    super();
    this.pending = new Map();
    this.nextId = 0;
    this.buffer = "";
    this.decoder = new StringDecoder("utf8");
    this.onRequest = onRequest;
    this.child = spawn(command, args, { cwd, shell: false, stdio: ["pipe", "pipe", "pipe"] });

    this.child.stdout.on("data", (chunk) => {
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
        this.fail(new Error(`[AcpClient.receive] Invalid ACP protocol/JSON: ${error.message}`));
        this.child.kill();
      }
    });
    this.child.stderr.on("data", (chunk) => onLog(chunk.toString()));
    this.child.stdin.on("error", (error) => this.fail(new Error(`[AcpClient.write] ${error.message}`)));
    this.child.on("error", (error) => this.fail(new Error(`[AcpClient.spawn] command=${command} cwd=${cwd}: ${error.message}`)));
    this.child.on("close", (code, signal) => this.fail(new Error(`[AcpClient.exit] code=${code} signal=${signal}`)));
  }

  write(message) {
    if (this.failure) throw this.failure;
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  }

  request(method, params, timeout = 30000) {
    if (this.failure) return Promise.reject(this.failure);

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
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

  notify(method, params) {
    this.write({ method, params });
  }

  receive(message) {
    if (!message || message.jsonrpc !== "2.0") {
      throw new Error("[AcpClient.receive] Missing JSON-RPC 2.0 envelope");
    }

    if (typeof message.method === "string") {
      if (message.id !== undefined) {
        this.answer(message).catch((error) => this.fail(error));
      } else {
        this.emit("notification", message.method, message.params);
      }
      return;
    }

    const request = this.pending.get(message.id);
    if (!request) return;

    this.pending.delete(message.id);
    clearTimeout(request.timer);

    if (message.error) {
      request.reject(new Error(`[AcpClient.request] method=${request.method} id=${message.id} code=${message.error.code}: ${message.error.message}`));
    } else if ("result" in message) {
      request.resolve(message.result);
    } else {
      request.reject(new Error(`[AcpClient.receive] Invalid response id=${message.id} method=${request.method}`));
    }
  }

  async answer(message) {
    let response;

    try {
      if (!this.onRequest) throw new Error("Unsupported client request");
      response = { result: await this.onRequest(message.method, message.params) };
    } catch (error) {
      response = { error: { code: -32601, message: `[AcpClient.answer] method=${message.method}: ${error.message}` } };
    }

    if (!this.failure) this.write({ id: message.id, ...response });
  }

  fail(error) {
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

module.exports = { AcpClient };
