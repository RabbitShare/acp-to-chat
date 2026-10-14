import { EventEmitter } from "node:events";
import { Deferred, Effect, Exit, Fiber, Scope } from "effect";
import type { AvailableCommand, ContentBlock, RequestPermissionRequest, RequestPermissionResponse, SessionUpdate } from "@agentclientprotocol/sdk";
import type { AcpClient } from "./acp";
import { errorMessage, isObject, readPermissionParams, readSessionNotification, readConfigOptions, readAvailableCommands, type SelectConfigOption } from "./protocol";
import { makeConnection, type ConnectionOwner } from "./machines/connection";
import { SessionOwner } from "./machines/session";
import { TurnOwner } from "./machines/turn";

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
  env?: Record<string, string>;
  permission: (params: RequestPermissionRequest, signal: AbortSignal) => string | undefined | Promise<string | undefined> | Effect.Effect<string | undefined, unknown>;
  onLog?: (text: string) => void;
}

/** Synchronous admission and native projections. Machines own accepted work. */
export class Sessions extends EventEmitter<{ status: [record: SessionRecord, status: SessionStatus]; config: [record: SessionRecord]; commands: [record: SessionRecord]; failure: [error: Error] }> {
  options: SessionOptions & { args: string[]; onLog: (text: string) => void };
  records: Map<string, SessionRecord>;
  ready?: Promise<AcpClient>;
  client?: AcpClient;
  private creating = 0;
  private promptTrace = 0;
  private pendingCommands = new Map<string, AvailableCommand[]>();
  private readonly scope = Scope.makeUnsafe();
  private readonly generations = new Set<Scope.Closeable>();
  private readonly sessionOwners = new WeakMap<SessionRecord, SessionOwner>();
  private readonly turnOwners = new WeakMap<NonNullable<SessionRecord["turn"]>, TurnOwner>();
  private generation = 0;
  private connectionOwner?: ConnectionOwner;
  private connectionReady?: Deferred.Deferred<AcpClient, Error>;
  private disposed = false;
  private disposal?: Fiber.Fiber<void>;

  constructor({ command, args = ["acp"], cwd, env, permission, onLog = () => {} }: SessionOptions) {
    super();
    this.options = { command, args, cwd, env, permission, onLog };
    this.records = new Map<string, SessionRecord>();
  }

  private isCurrent(connection: AcpClient) { return !this.disposed && this.client === connection && !connection.failure; }

  private session(record: SessionRecord) {
    let owner = this.sessionOwners.get(record);
    if (!owner) {
      owner = new SessionOwner(record, {
        connectEffect: () => this.connectEffect(), isCurrent: (connection) => this.isCurrent(connection), isDisposed: () => this.disposed,
        config: (changed) => this.emit("config", changed), commands: (changed) => this.emit("commands", changed),
      }, this.scope);
      this.sessionOwners.set(record, owner);
    }
    return owner;
  }

  connect(): Promise<AcpClient> {
    if (this.disposed) return Promise.reject(new Error("[Sessions.connect] Sessions disposed"));
    if (this.ready) return this.ready;
    const generation = ++this.generation;
    const scope = Scope.makeUnsafe();
    this.generations.add(scope);
    const completion = Deferred.makeUnsafe<AcpClient, Error>();
    this.connectionReady = completion;
    this.ready = Effect.runPromise(Deferred.await(completion));
    void this.ready.catch(() => {});
    const self = this;
    const startup = Effect.gen(function* () {
      const owner = yield* makeConnection({ ...self.options,
        onRequest: (method, params) => generation === self.generation && !self.disposed
          ? self.requestPermission(method, params) : Promise.resolve({ outcome: { outcome: "cancelled" } } as RequestPermissionResponse),
        onClient: (connection) => {
          if (self.disposed || self.generation !== generation) { connection.dispose(); return; }
          self.client = connection;
          connection.on("notification", (method, params) => {
            if (self.isCurrent(connection) && method === "session/update") self.update(params);
          });
          connection.on("failure", (error) => {
            if (self.client !== connection || self.generation !== generation) return;
            self.pendingCommands.clear();
            for (const record of self.records.values()) {
              if (record.turn) {
                const turn = self.turnOwners.get(record.turn);
                if (turn) turn.fail(error); else record.turn.controller.abort();
              }
              const session = self.session(record);
              session.confirmCommands([]);
              if (record.connection === connection) session.invalidateConfig();
            }
            self.client = undefined;
            self.ready = undefined;
            self.connectionReady = undefined;
            self.connectionOwner = undefined;
            if (!connection.disposing) {
              self.options.onLog(`${error.message}\n`);
              self.emit("failure", error);
            }
            Effect.runFork(Scope.close(scope, Exit.void).pipe(Effect.ensuring(Effect.sync(() => self.generations.delete(scope)))));
          });
        },
      }, generation);
      if (self.disposed || self.generation !== generation) {
        yield* owner.disposeEffect();
        return yield* Effect.fail(new Error("[Sessions.connect] Sessions disposed or stale generation"));
      }
      self.connectionOwner = owner;
      const connection = yield* owner.connectEffect();
      if (!self.isCurrent(connection)) return yield* Effect.fail(connection.failure ?? new Error("[Sessions.connect] Stale generation"));
      yield* Deferred.succeed(completion, connection);
    }).pipe(Scope.provide(scope), Effect.catch((error) => Effect.gen(function* () {
      yield* Deferred.fail(completion, error);
      if (self.connectionReady === completion) {
        self.ready = undefined;
        self.connectionReady = undefined;
        self.connectionOwner = undefined;
        self.client = undefined;
      }
      yield* Scope.close(scope, Exit.void);
      self.generations.delete(scope);
    })));
    Effect.runFork(startup.pipe(Effect.forkIn(scope), Effect.flatMap(Fiber.join), Effect.ignore));
    return this.ready!;
  }

  connectEffect(): Effect.Effect<AcpClient, Error> {
    return Effect.suspend(() => {
      if (this.disposed) return Effect.fail(new Error("[Sessions.connect] Sessions disposed"));
      this.connect();
      return this.connectionReady ? Deferred.await(this.connectionReady) : Effect.fail(new Error("[Sessions.connect] Connection closed"));
    });
  }

  create(cwd: string): Promise<SessionRecord> {
    return Effect.runPromise(this.createEffect(cwd));
  }

  createEffect(cwd: string): Effect.Effect<SessionRecord, Error> {
    const self = this;
    return Effect.gen(function* () {
      const connection = yield* self.connectEffect();
      self.creating++;
      return yield* Effect.gen(function* () {
        const result = yield* connection.requestEffect("session/new", { cwd, mcpServers: [] });
        if (!self.isCurrent(connection)) return yield* Effect.fail(connection.failure ?? new Error("[Sessions.create] Stale connection"));
        if (!isObject(result) || typeof result.sessionId !== "string" || !result.sessionId) return yield* Effect.fail(new Error(`[Sessions.create] Missing sessionId cwd=${cwd}`));
        const configOptions = readConfigOptions(result.configOptions, true);
        if (!configOptions) return yield* Effect.fail(new Error(`[Sessions.create] Invalid configOptions cwd=${cwd}`));
        const record: SessionRecord = { id: result.sessionId, cwd, label: "New OpenCode session", created: Date.now(), history: [], connection,
          availableCommands: self.pendingCommands.get(result.sessionId) ?? [], configOptions, configRevision: 1, configValid: true };
        self.records.set(record.id, record);
        self.pendingCommands.delete(record.id);
        self.session(record).confirmCommands(record.availableCommands);
        return record;
      }).pipe(Effect.ensuring(Effect.sync(() => { if (--self.creating === 0) self.pendingCommands.clear(); })));
    });
  }

  load(saved: SavedSession): Promise<SessionRecord> {
    return Effect.runPromise(this.loadEffect(saved));
  }

  loadEffect(saved: SavedSession): Effect.Effect<SessionRecord, Error> {
    return Effect.suspend(() => {
      if (this.disposed) return Effect.fail(new Error("[Sessions.load] Sessions disposed"));
      const record: SessionRecord = this.records.get(saved.id) ?? { ...saved, history: [], availableCommands: [], configOptions: [], configRevision: 0, configValid: false };
      this.records.set(record.id, record);
      return this.session(record).loadEffect().pipe(Effect.as(record));
    });
  }

  update(params: unknown) {
    if (this.disposed) return;
    if (isObject(params) && typeof params.sessionId === "string" && isObject(params.update) && params.update.sessionUpdate === "available_commands_update") {
      const commands = readAvailableCommands(params.update.availableCommands);
      if (!commands) return;
      const record = this.records.get(params.sessionId);
      if (record) this.session(record).confirmCommands(commands);
      // ACP can advertise before new resolves. Never materialize unknown IDs.
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
      if (record?.configValid && configOptions) this.session(record).confirmConfig(configOptions);
      return;
    }
    const notification = readSessionNotification(params);
    if (!notification) return;
    const record = this.records.get(notification.sessionId);
    if (!record) return;
    this.session(record).updateHistory(notification.update);
    if (record.turn && !record.loading && !record.turn.controller.signal.aborted) record.turn.onUpdate(notification.update);
  }

  setConfigOption(record: SessionRecord, configId: string, value: string, expectedRevision: number): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("[Sessions.setConfigOption] Sessions disposed"));
    if (record.turn) return Promise.reject(new Error(`[Sessions.setConfigOption] Prompt already active sessionId=${record.id}`));
    if (record.configPending) return Promise.reject(new Error(`[Sessions.setConfigOption] Configuration busy sessionId=${record.id}`));
    return this.session(record).set(configId, value, expectedRevision);
  }

  requestPermission(method: string, rawParams: unknown): Promise<RequestPermissionResponse> {
    if (method !== "session/request_permission") return Promise.reject(new Error(`[Sessions.requestPermission] Unsupported method=${method}`));
    const params = readPermissionParams(rawParams);
    const record = params ? this.records.get(params.sessionId) : undefined;
    const turn = record?.turn ? this.turnOwners.get(record.turn) : undefined;
    if (!params || !turn || this.disposed) return Promise.resolve({ outcome: { outcome: "cancelled" } });
    return Effect.runPromise(turn.permissionEffect(params));
  }

  prompt(record: SessionRecord, text: string, signal: AbortSignal, onUpdate: (update: SessionUpdate) => void,
    beforeSend: () => void = () => {}, prepareText?: () => Promise<string>, prepareContext?: () => Promise<ContentBlock[]>) {
    return Effect.runPromise(this.promptEffect(record, text, signal, onUpdate, beforeSend,
      prepareText && (() => Effect.tryPromise({ try: prepareText, catch: toError })),
      prepareContext && (() => Effect.tryPromise({ try: prepareContext, catch: toError }))));
  }

  // Admission stays synchronous, even when the returned effect is run later.
  promptEffect(record: SessionRecord, text: string, signal: AbortSignal, onUpdate: (update: SessionUpdate) => void,
    beforeSend: () => void = () => {}, prepareText?: () => Effect.Effect<string, Error>, prepareContext?: () => Effect.Effect<ContentBlock[], Error>) {
    const trace = ++this.promptTrace;
    const diagnostic = (stage: string, state = "") => {
      try { this.options.onLog(`[DEBUG-native-send] stage=${stage} acp=${trace} cancelled=${signal.aborted}${state ? ` ${state}` : ""}\n`); }
      catch { /* Diagnostics must not change prompt behavior. */ }
    };
    diagnostic("acp.enter");
    if (this.disposed) return Effect.fail(new Error("[Sessions.prompt] Sessions disposed"));
    if (record.turn) return Effect.fail(new Error(`[Sessions.prompt] Prompt already active sessionId=${record.id}`));
    if (signal.aborted) { diagnostic("acp.cancelled"); return Effect.succeed({ stopReason: "cancelled" as const }); }
    const session = this.session(record);
    const turn = new TurnOwner(record, session, {
      isCurrent: (connection) => this.isCurrent(connection), status: (changed, status) => this.emit("status", changed, status),
      permission: (params, cancellation) => this.options.permission(params, cancellation), log: (message) => this.options.onLog(message),
    }, text, signal, onUpdate, beforeSend, session.pendingConfigEffect(), prepareText, prepareContext, diagnostic);
    record.turn = turn.projection;
    this.turnOwners.set(turn.projection, turn);
    // Dispatch accepted work now, as the Promise facade does. A native projection
    // exception before awaiting completion must not leave an unstarted reservation.
    const running = Effect.runFork(turn.runEffect().pipe(Effect.forkIn(this.scope), Effect.flatMap(Fiber.join)));
    return Fiber.join(running);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const error = new Error("[Sessions.dispose] Sessions disposed");
    if (this.connectionReady) Deferred.doneUnsafe(this.connectionReady, Effect.fail(error));
    this.client?.dispose();
    this.connectionOwner?.dispose();
    this.client = undefined;
    this.ready = undefined;
    this.connectionReady = undefined;
    for (const record of this.records.values()) {
      if (record.turn) this.turnOwners.get(record.turn)?.fail(error);
      this.sessionOwners.get(record)?.close(error);
    }
    const self = this;
    this.disposal = Effect.runFork(Effect.gen(function* () {
      yield* Effect.all([...self.generations].map((scope) => Scope.close(scope, Exit.void)), { concurrency: "unbounded" });
      yield* Scope.close(self.scope, Exit.void);
      self.generations.clear();
    }));
  }

  disposeEffect(): Effect.Effect<void> {
    return Effect.suspend(() => { this.dispose(); return this.disposal ? Fiber.join(this.disposal) : Effect.void; });
  }
}

const toError = (error: unknown): Error => error instanceof Error ? error : new Error(errorMessage(error));
