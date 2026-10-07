import { EventEmitter } from "node:events";
import type { AvailableCommand, RequestPermissionRequest, RequestPermissionResponse, SessionUpdate } from "@agentclientprotocol/sdk";
import { AcpClient } from "./acp";
import { errorMessage, isObject, readPermissionParams, readSessionNotification, readOptionalString, isTextContent, readConfigOptions, readAvailableCommands, type SelectConfigOption } from "./protocol";

export interface SavedSession {
  id: string;
  cwd: string;
  label?: string;
  created?: number;
}

type HistoryTurn =
  | { role: "user"; text: string; nativeText?: string; messageId?: string | null }
  | { role: "assistant"; updates: SessionUpdate[]; messageId?: string | null };

export interface SessionRecord extends SavedSession {
  history: HistoryTurn[];
  availableCommands: AvailableCommand[];
  configOptions: SelectConfigOption[];
  configRevision: number;
  configValid: boolean;
  configPending?: Promise<void>;
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

export class Sessions extends EventEmitter<{ status: [record: SessionRecord, status: SessionStatus]; config: [record: SessionRecord]; commands: [record: SessionRecord]; failure: [error: Error] }> {
  options: SessionOptions & { args: string[]; onLog: (text: string) => void };
  records: Map<string, SessionRecord>;
  ready?: Promise<AcpClient>;
  client?: AcpClient;
  private creating = 0;
  private promptTrace = 0;
  private pendingCommands = new Map<string, AvailableCommand[]>();

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
        if (this.client === connection && method === "session/update") this.update(params);
      });
      connection.on("failure", (error: Error) => {
        if (this.client !== connection) return;
        this.pendingCommands.clear();
        for (const record of this.records.values()) {
          record.turn?.controller.abort();
          this.confirmCommands(record, []);
          if (record.connection === connection) this.invalidateConfig(record);
        }
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
    this.creating++;
    try {
      const result = await connection.request("session/new", { cwd, mcpServers: [] });

      if (!isObject(result) || typeof result.sessionId !== "string" || !result.sessionId) {
        throw new Error(`[Sessions.create] Missing sessionId cwd=${cwd}`);
      }

      const configOptions = readConfigOptions(result.configOptions, true);
      if (!configOptions) throw new Error(`[Sessions.create] Invalid configOptions cwd=${cwd}`);
      const record: SessionRecord = { id: result.sessionId, cwd, label: "New OpenCode session", created: Date.now(), history: [], connection,
        availableCommands: this.pendingCommands.get(result.sessionId) ?? [], configOptions, configRevision: 1, configValid: true };
      this.records.set(record.id, record);
      this.pendingCommands.delete(record.id);
      this.confirmCommands(record, record.availableCommands);
      return record;
    } finally {
      if (--this.creating === 0) this.pendingCommands.clear();
    }
  }

  async load(saved: SavedSession) {
    const record: SessionRecord = this.records.get(saved.id) ?? { ...saved, history: [], availableCommands: [], configOptions: [], configRevision: 0, configValid: false };
    this.records.set(record.id, record);
    const connection = await this.connect();

    if (record.connection === connection && record.configValid && !record.loading) return record;
    if (!connection.capabilities.loadSession) {
      throw new Error(`[Sessions.load] Agent cannot load saved sessionId=${record.id}`);
    }

    if (!record.loading) {
      if (record.configValid) this.invalidateConfig(record);
      this.confirmCommands(record, []);
      record.history = [];
      record.loading = connection.request("session/load", { sessionId: record.id, cwd: record.cwd, mcpServers: [] })
        .then((result) => {
          const configOptions = isObject(result) ? readConfigOptions(result.configOptions, true) : undefined;
          if (!configOptions) throw new Error(`[Sessions.load] Invalid configOptions sessionId=${record.id}`);
          record.connection = connection;
          this.confirmConfig(record, configOptions);
        })
        .catch((error: unknown) => { this.confirmCommands(record, []); throw error; })
        .finally(() => { record.loading = undefined; });
    }

    await record.loading;
    return record;
  }

  update(params: unknown) {
    if (isObject(params) && typeof params.sessionId === "string" && isObject(params.update) && params.update.sessionUpdate === "available_commands_update") {
      const commands = readAvailableCommands(params.update.availableCommands);
      if (!commands) return;
      const record = this.records.get(params.sessionId);
      if (record) this.confirmCommands(record, commands);
      // ACP can send commands before new resolves with the ID. Bound temporary
      // buffering to in-flight creations; never materialize unknown sessions.
      else if (this.creating && (this.pendingCommands.has(params.sessionId) || this.pendingCommands.size < 128)) {
        const bytes = [...this.pendingCommands.entries()].reduce((total, [id, catalog]) =>
          total + (id === params.sessionId ? 0 : Buffer.byteLength(JSON.stringify(catalog))), Buffer.byteLength(JSON.stringify(commands)));
        if (bytes <= 1024 * 1024) this.pendingCommands.set(params.sessionId, commands);
      }
      return;
    }
    if (isObject(params) && typeof params.sessionId === "string" && isObject(params.update) && params.update.sessionUpdate === "config_option_update") {
      const record = this.records.get(params.sessionId);
      const configOptions = readConfigOptions(params.update.configOptions);
      if (record?.configValid && configOptions) this.confirmConfig(record, configOptions);
      return;
    }
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

    if (record.turn && !record.loading && !record.turn.controller.signal.aborted) record.turn.onUpdate(update);
  }

  private confirmConfig(record: SessionRecord, configOptions: SelectConfigOption[]) {
    record.configOptions = configOptions;
    record.configRevision++;
    record.configValid = true;
    this.emit("config", record);
  }

  private confirmCommands(record: SessionRecord, commands: AvailableCommand[]) {
    record.availableCommands = commands;
    this.emit("commands", record);
  }

  private invalidateConfig(record: SessionRecord) {
    record.configOptions = [];
    record.configRevision++;
    record.configValid = false;
    this.emit("config", record);
  }

  async setConfigOption(record: SessionRecord, configId: string, value: string, expectedRevision: number): Promise<void> {
    if (record.turn) throw new Error(`[Sessions.setConfigOption] Prompt already active sessionId=${record.id}`);
    if (record.configPending) throw new Error(`[Sessions.setConfigOption] Configuration busy sessionId=${record.id}`);
    const operation = (async () => {
      await this.load(record);
      if (record.configRevision !== expectedRevision) throw new Error(`[Sessions.setConfigOption] Stale configuration sessionId=${record.id}`);
      const option = record.configOptions.find((item) => item.id === configId);
      const available = option?.options.some((item) => "group" in item
        ? item.options.some((choice) => choice.value === value) : item.value === value);
      if (!available) throw new Error(`[Sessions.setConfigOption] Unavailable selection configId=${configId} sessionId=${record.id}`);
      const connection = record.connection;
      if (!connection) throw new Error(`[Sessions.setConfigOption] Missing connection sessionId=${record.id}`);
      try {
        const result = await connection.request("session/set_config_option", { sessionId: record.id, configId, value });
        const configOptions = isObject(result) ? readConfigOptions(result.configOptions) : undefined;
        if (!configOptions) throw new Error(`[Sessions.setConfigOption] Invalid configOptions sessionId=${record.id}`);
        this.confirmConfig(record, configOptions);
      } catch (error) {
        // OpenCode can mutate configuration before failing an awaited switch.
        // Only a fresh load can confirm state; never claim optimistic rollback.
        this.invalidateConfig(record);
        throw error;
      }
    })();
    const pending = operation.finally(() => {
      if (record.configPending === pending) {
        record.configPending = undefined;
        this.emit("config", record);
      }
    });
    record.configPending = pending;
    this.emit("config", record);
    await pending;
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
    if (!record || !turn || record.loading || turn.controller.signal.aborted) return cancelled;

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

  async prompt(record: SessionRecord, text: string, signal: AbortSignal, onUpdate: (update: SessionUpdate) => void,
    beforeSend: () => void = () => {}, prepareText?: () => Promise<string>) {
    // Temporary boundary tracing; no payloads or arbitrary error/stop-reason strings.
    const trace = ++this.promptTrace;
    const diagnostic = (stage: string, state = "") => {
      try { this.options.onLog(`[DEBUG-native-send] stage=${stage} acp=${trace} cancelled=${signal.aborted}${state ? ` ${state}` : ""}\n`); }
      catch { /* Diagnostics must not change prompt behavior. */ }
    };
    diagnostic("acp.enter");
    if (record.turn) throw new Error(`[Sessions.prompt] Prompt already active sessionId=${record.id}`);
    if (signal.aborted) {
      diagnostic("acp.cancelled");
      return { stopReason: "cancelled" };
    }

    const controller = new AbortController();
    const turn = { controller, onUpdate };
    record.turn = turn;
    const pendingConfig = record.configPending;
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
      if (pendingConfig) {
        diagnostic("acp.config.wait");
        let resume: (() => void) | undefined;
        const cancelled = new Promise<void>((resolve) => {
          resume = () => resolve();
          signal.addEventListener("abort", resume, { once: true });
        });
        try { await Promise.race([pendingConfig, cancelled]); }
        finally { if (resume) signal.removeEventListener("abort", resume); }
        diagnostic("acp.config.ready");
      }
      if (controller.signal.aborted) return { stopReason: "cancelled" };
      diagnostic("acp.load.wait");
      await this.load(record);
      diagnostic("acp.load.ready");
      connection = record.connection;
      if (controller.signal.aborted) return { stopReason: "cancelled" };
      if (!connection) throw new Error(`[Sessions.prompt] Missing connection sessionId=${record.id}`);

      const wireText = prepareText ? await prepareText() : text;
      if (controller.signal.aborted) return { stopReason: "cancelled" };

      // The adapter's live references can be revoked during config/load waits.
      // Recheck synchronously while the prompt slot is still reserved.
      beforeSend();
      record.history.push({ role: "user", text: wireText, ...(wireText === text ? {} : { nativeText: text }) });
      if (record.label === "New OpenCode session") record.label = text.slice(0, 80);
      this.emit("status", record, "inProgress");
      started = true;
      diagnostic("acp.rpc.start");
      const result = await connection.request("session/prompt", { sessionId: record.id, prompt: [{ type: "text", text: wireText }] }, 0);
      const stopReason = ["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"].includes(result.stopReason) ? result.stopReason : "other";
      diagnostic("acp.rpc.complete", `stopReason=${stopReason}`);
      this.emit("status", record, "completed");
      return result;
    } catch (error) {
      diagnostic("acp.failed");
      this.emit("status", record, signal.aborted ? "completed" : "failed");
      if (signal.aborted) return { stopReason: "cancelled" };
      throw error;
    } finally {
      diagnostic("acp.cleanup");
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
