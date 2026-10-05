import { EventEmitter } from "node:events";
import type { RequestPermissionRequest, RequestPermissionResponse, SessionUpdate } from "@agentclientprotocol/sdk";
import { AcpClient } from "./acp";
import { errorMessage, isObject, readPermissionParams, readSessionNotification, readOptionalString, isTextContent } from "./protocol";

export interface SavedSession {
  id: string;
  cwd: string;
  label?: string;
  created?: number;
}

type HistoryTurn =
  | { role: "user"; text: string; messageId?: string | null }
  | { role: "assistant"; updates: SessionUpdate[]; messageId?: string | null };

export interface SessionRecord extends SavedSession {
  history: HistoryTurn[];
  connection?: AcpClient;
  loading?: Promise<void>;
  turn?: { controller: AbortController; onUpdate: (update: SessionUpdate) => void };
}

export type SessionStatus = "inProgress" | "completed" | "needsInput" | "failed";

interface SessionOptions {
  command: string;
  args?: string[];
  cwd?: string;
  permission: (params: RequestPermissionRequest, signal: AbortSignal) => string | undefined | Promise<string | undefined>;
  onLog?: (text: string) => void;
}

export class Sessions extends EventEmitter<{ status: [record: SessionRecord, status: SessionStatus]; failure: [error: Error] }> {
  options: SessionOptions & { args: string[]; onLog: (text: string) => void };
  records: Map<string, SessionRecord>;
  ready?: Promise<AcpClient>;
  client?: AcpClient;

  constructor({ command, args = ["acp"], cwd, permission, onLog = () => {} }: SessionOptions) {
    super();
    this.options = { command, args, cwd, permission, onLog };
    this.records = new Map<string, SessionRecord>();
  }

  async connect() {
    if (!this.ready) {
      const connection = new AcpClient(this.options.command, this.options.args, {
        cwd: this.options.cwd,
        onLog: this.options.onLog,
        onRequest: (method, params) => this.requestPermission(method, params),
      });
      this.client = connection;
      connection.on("notification", (method: string, params: unknown) => {
        if (method === "session/update") this.update(params);
      });
      connection.on("failure", (error: Error) => {
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
        if (!isObject(result) || result.protocolVersion !== 1) {
          throw new Error(`[Sessions.connect] Unsupported ACP protocolVersion=${isObject(result) ? result.protocolVersion : undefined}`);
        }
        const capabilities = result.agentCapabilities;
        if (isObject(capabilities) && (capabilities.loadSession === undefined || typeof capabilities.loadSession === "boolean")) {
          connection.capabilities = capabilities;
        }
        return connection;
      }).catch((error: unknown) => {
        connection.dispose();
        throw error;
      });
    }

    return this.ready;
  }

  async create(cwd: string) {
    const connection = await this.connect();
    const result = await connection.request("session/new", { cwd, mcpServers: [] });

    if (!isObject(result) || typeof result.sessionId !== "string" || !result.sessionId) {
      throw new Error(`[Sessions.create] Missing sessionId cwd=${cwd}`);
    }

    const record: SessionRecord = { id: result.sessionId, cwd, label: "New OpenCode session", created: Date.now(), history: [], connection };
    this.records.set(record.id, record);
    return record;
  }

  async load(saved: SavedSession) {
    const record: SessionRecord = this.records.get(saved.id) ?? { ...saved, history: [] };
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

  update(params: unknown) {
    const notification = readSessionNotification(params);
    if (!notification) return;
    const { sessionId, update } = notification;
    const record = this.records.get(sessionId);
    if (!record) return;

    const messageId = readOptionalString(update, "messageId");
    if (update.sessionUpdate === "user_message_chunk" && isTextContent(update.content)) {
      const last = record.history.at(-1);
      if (last?.role === "user" && last.messageId === messageId) {
        last.text += update.content.text;
      } else {
        record.history.push({ role: "user", text: update.content.text, messageId });
      }
    } else if (["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update"].includes(update.sessionUpdate)) {
      let last = record.history.at(-1);
      if (last?.role !== "assistant" || (messageId && last.messageId && messageId !== last.messageId)) {
        last = { role: "assistant", updates: [], messageId };
        record.history.push(last);
      }
      last.updates.push(update);
    }

    if (record.turn && !record.turn.controller.signal.aborted) record.turn.onUpdate(update);
  }

  async requestPermission(method: string, rawParams: unknown): Promise<RequestPermissionResponse> {
    if (method !== "session/request_permission") {
      throw new Error(`[Sessions.requestPermission] Unsupported method=${method}`);
    }

    const cancelled: RequestPermissionResponse = { outcome: { outcome: "cancelled" } };
    const params = readPermissionParams(rawParams);
    if (!params) return cancelled;
    const record = this.records.get(params.sessionId);
    const turn = record?.turn;
    if (!record || !turn || turn.controller.signal.aborted) return cancelled;

    this.emit("status", record, "needsInput");

    try {
      const optionId = await this.options.permission(params, turn.controller.signal);
      if (typeof optionId !== "string" || turn.controller.signal.aborted || record.turn !== turn || !params.options.some((option) => option.optionId === optionId)) {
        return cancelled;
      }
      return { outcome: { outcome: "selected", optionId } };
    } catch (error) {
      this.options.onLog(`[Sessions.requestPermission] sessionId=${record.id}: ${errorMessage(error)}\n`);
      return cancelled;
    } finally {
      if (record.turn === turn) this.emit("status", record, "inProgress");
    }
  }

  async prompt(record: SessionRecord, text: string, signal: AbortSignal, onUpdate: (update: SessionUpdate) => void) {
    if (record.turn) throw new Error(`[Sessions.prompt] Prompt already active sessionId=${record.id}`);
    if (signal.aborted) return { stopReason: "cancelled" };

    const controller = new AbortController();
    const turn = { controller, onUpdate };
    record.turn = turn;
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    let cancelTimer: ReturnType<typeof setTimeout> | undefined;
    let connection: AcpClient | undefined;
    let started = false;
    const cancel = () => {
      if (!started || !connection || connection.failure) return;
      const active = connection;
      void active.notify("session/cancel", { sessionId: record.id }).catch((error: unknown) => {
        active.fail(new Error(`[Sessions.prompt] session/cancel sessionId=${record.id}: ${errorMessage(error)}`));
      });
      // A hung agent cannot keep a cancelled request (and its permission UI) alive forever.
      cancelTimer = setTimeout(() => active.dispose(), 5000);
    };
    controller.signal.addEventListener("abort", cancel, { once: true });

    try {
      await this.load(record);
      connection = record.connection;
      if (controller.signal.aborted) return { stopReason: "cancelled" };
      if (!connection) throw new Error(`[Sessions.prompt] Missing connection sessionId=${record.id}`);

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
