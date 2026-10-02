"use strict";

const { EventEmitter } = require("node:events");
const { AcpClient } = require("./acp");

class Sessions extends EventEmitter {
  constructor({ command, args = ["acp"], cwd, permission, onLog = () => {} }) {
    super();
    this.options = { command, args, cwd, permission, onLog };
    this.records = new Map();
  }

  async connect() {
    if (!this.ready) {
      const connection = new AcpClient(this.options.command, this.options.args, {
        cwd: this.options.cwd,
        onLog: this.options.onLog,
        onRequest: (method, params) => this.requestPermission(method, params),
      });
      this.client = connection;
      connection.on("notification", (method, params) => {
        if (method === "session/update") this.update(params);
      });
      connection.on("failure", (error) => {
        for (const record of this.records.values()) record.turn?.controller.abort();
        if (this.client === connection) {
          this.client = undefined;
          this.ready = undefined;
        }
        if (!connection.disposing) {
          this.options.onLog(`${error.message}\n`);
          this.emit("failure", error);
          connection.dispose();
        }
      });

      this.ready = connection.request("initialize", {
        protocolVersion: 1,
        clientInfo: { name: "opencode-native-chat", version: "0.0.1" },
        clientCapabilities: {},
      }).then((result) => {
        if (result.protocolVersion !== 1) {
          throw new Error(`[Sessions.connect] Unsupported ACP protocolVersion=${result.protocolVersion}`);
        }
        connection.capabilities = result.agentCapabilities ?? {};
        return connection;
      }).catch((error) => {
        connection.dispose();
        throw error;
      });
    }

    return this.ready;
  }

  async create(cwd) {
    const connection = await this.connect();
    const result = await connection.request("session/new", { cwd, mcpServers: [] });

    if (typeof result.sessionId !== "string" || !result.sessionId) {
      throw new Error(`[Sessions.create] Missing sessionId cwd=${cwd}`);
    }

    const record = { id: result.sessionId, cwd, label: "New OpenCode session", created: Date.now(), history: [], connection };
    this.records.set(record.id, record);
    return record;
  }

  async load(saved) {
    const record = this.records.get(saved.id) ?? { ...saved, history: [] };
    this.records.set(record.id, record);
    const connection = await this.connect();

    if (record.connection === connection) return record;
    if (!connection.capabilities.loadSession) {
      throw new Error(`[Sessions.load] Agent cannot load saved sessionId=${record.id}`);
    }

    if (!record.loading) {
      record.history = [];
      record.loading = connection.request("session/load", { sessionId: record.id, cwd: record.cwd, mcpServers: [] })
        .then(() => { record.connection = connection; })
        .finally(() => { record.loading = undefined; });
    }

    await record.loading;
    return record;
  }

  update({ sessionId, update }) {
    const record = this.records.get(sessionId);
    if (!record || !update || typeof update.sessionUpdate !== "string") return;

    if (update.sessionUpdate === "user_message_chunk" && update.content?.type === "text") {
      const last = record.history.at(-1);
      if (last?.role === "user" && last.messageId === update.messageId) {
        last.text += update.content.text;
      } else {
        record.history.push({ role: "user", text: update.content.text, messageId: update.messageId });
      }
    } else if (["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update"].includes(update.sessionUpdate)) {
      let last = record.history.at(-1);
      if (last?.role !== "assistant" || (update.messageId && last.messageId && update.messageId !== last.messageId)) {
        last = { role: "assistant", updates: [], messageId: update.messageId };
        record.history.push(last);
      }
      last.updates.push(update);
    }

    if (record.turn && !record.turn.controller.signal.aborted) record.turn.onUpdate(update);
  }

  async requestPermission(method, params) {
    if (method !== "session/request_permission") {
      throw new Error(`[Sessions.requestPermission] Unsupported method=${method}`);
    }

    const record = this.records.get(params.sessionId);
    const turn = record?.turn;
    const cancelled = { outcome: { outcome: "cancelled" } };
    if (!turn || turn.controller.signal.aborted || !Array.isArray(params.options)) return cancelled;

    this.emit("status", record, "needsInput");

    try {
      const optionId = await this.options.permission(params, turn.controller.signal);
      if (turn.controller.signal.aborted || record.turn !== turn || !params.options.some((option) => option.optionId === optionId)) {
        return cancelled;
      }
      return { outcome: { outcome: "selected", optionId } };
    } catch (error) {
      this.options.onLog(`[Sessions.requestPermission] sessionId=${record.id}: ${error.message}\n`);
      return cancelled;
    } finally {
      if (record.turn === turn) this.emit("status", record, "inProgress");
    }
  }

  async prompt(record, text, signal, onUpdate) {
    if (record.turn) throw new Error(`[Sessions.prompt] Prompt already active sessionId=${record.id}`);
    if (signal.aborted) return { stopReason: "cancelled" };

    const controller = new AbortController();
    const turn = { controller, onUpdate };
    record.turn = turn;
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    let cancelTimer;
    let connection;
    let started = false;
    const cancel = () => {
      if (!started || connection.failure) return;
      connection.notify("session/cancel", { sessionId: record.id });
      // A hung agent cannot keep a cancelled request (and its permission UI) alive forever.
      cancelTimer = setTimeout(() => connection.dispose(), 5000);
    };
    controller.signal.addEventListener("abort", cancel, { once: true });

    try {
      await this.load(record);
      connection = record.connection;
      if (controller.signal.aborted) return { stopReason: "cancelled" };

      record.history.push({ role: "user", text });
      if (record.label === "New OpenCode session") record.label = text.slice(0, 80);
      this.emit("status", record, "inProgress");
      started = true;
      const result = await connection.request("session/prompt", { sessionId: record.id, prompt: [{ type: "text", text }] }, 0);
      this.emit("status", record, "completed");
      return result;
    } catch (error) {
      this.emit("status", record, signal.aborted ? "completed" : "failed");
      if (signal.aborted) return { stopReason: "cancelled" };
      throw error;
    } finally {
      clearTimeout(cancelTimer);
      signal.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", cancel);
      controller.abort();
      record.turn = undefined;
    }
  }

  dispose() {
    this.client?.dispose();
  }
}

module.exports = { Sessions };
