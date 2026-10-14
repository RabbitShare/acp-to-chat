import { isAbsolute } from "node:path";
import { Deferred, Effect, Exit, Fiber, Scope, Semaphore } from "effect";
import { Sessions, type SavedSession, type SessionRecord, type SessionStatus } from "./sessions";
import type * as VSCode from "vscode";
import type { RequestPermissionRequest, SessionUpdate, ToolCallUpdate } from "@agentclientprotocol/sdk";
import { errorMessage, isObject, isTextContent } from "./protocol";
import { registerSessionOptions } from "./session-options";
import { registerSessionCommands } from "./session-commands";
import { expandCommandTemplateEffect } from "./command-templates";
import { prepareFileContextEffect } from "./session-files";
export { expandCommandTemplate, expandCommandTemplateEffect } from "./command-templates";
export { prepareFileContext, prepareFileContextEffect } from "./session-files";

export type EditorApi = Pick<typeof VSCode,
  "MarkdownString" | "ChatResponseMarkdownPart" | "ChatResponseThinkingProgressPart" |
  "ChatToolInvocationPart" | "ChatRequestTurn2" | "ChatResponseTurn2" | "ChatSessionStatus" | "Uri" | "CancellationTokenSource" |
  "EventEmitter" | "FileSystemError" | "FileType" | "ChatSessionCustomizationType" | "Location" | "Range"> & {
  window: Pick<typeof VSCode.window, "createQuickPick" | "showWorkspaceFolderPick" | "showErrorMessage" | "createOutputChannel">;
  workspace: Pick<typeof VSCode.workspace, "isTrusted" | "workspaceFolders" | "getConfiguration" | "registerFileSystemProvider" | "textDocuments" | "fs" | "openTextDocument">;
  chat: Pick<typeof VSCode.chat, "createChatParticipant" | "createChatSessionItemController" | "registerChatSessionContentProvider" | "registerChatSessionCustomizationProvider">;
  lm: Pick<typeof VSCode.lm, "registerLanguageModelChatProvider" | "selectChatModels">;
  commands: Pick<typeof VSCode.commands, "registerCommand" | "executeCommand">;
};

export interface AdapterContext {
  subscriptions: { dispose(): unknown }[];
  workspaceState: Pick<VSCode.Memento, "get" | "update">;
}

type ToolState = ToolCallUpdate;
type RenderedPart = VSCode.ChatResponseMarkdownPart | VSCode.ChatResponseThinkingProgressPart | VSCode.ChatToolInvocationPart;
type NativeSession = Omit<VSCode.ChatSession, "requestHandler"> & { requestHandler: VSCode.ChatRequestHandler };
export type NativeRunner = <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;

const SESSION_TYPE = "opencode";
const PARTICIPANT = SESSION_TYPE;

function promptText(request: { prompt: string; command?: string }): string {
  // Native slash commands are separate from prompt, including in request history.
  return request.command ? `/${request.command}${request.prompt ? ` ${request.prompt}` : ""}` : request.prompt;
}

function markdown(vscode: Pick<EditorApi, "MarkdownString">, text: string) {
  const value = new vscode.MarkdownString(text);
  value.isTrusted = false;
  value.supportHtml = false;
  return value;
}

function display(value: unknown): string {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "";
}

export function renderUpdate(vscode: Pick<EditorApi, "MarkdownString" | "ChatResponseMarkdownPart" | "ChatResponseThinkingProgressPart" | "ChatToolInvocationPart">, update: SessionUpdate, tools: Map<string, ToolState>): RenderedPart | undefined {
  if (update.sessionUpdate === "agent_message_chunk" && isTextContent(update.content)) {
    return new vscode.ChatResponseMarkdownPart(markdown(vscode, update.content.text));
  }

  if (update.sessionUpdate === "agent_thought_chunk" && isTextContent(update.content)) {
    return new vscode.ChatResponseThinkingProgressPart(update.content.text);
  }

  if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
    const previous = tools.get(update.toolCallId);
    const tool: ToolState = {
      toolCallId: update.toolCallId,
      name: update.name ?? previous?.name, kind: update.kind ?? previous?.kind,
      title: update.title ?? previous?.title, status: update.status ?? previous?.status,
      rawInput: update.rawInput ?? previous?.rawInput, rawOutput: update.rawOutput ?? previous?.rawOutput,
      content: update.content ?? previous?.content,
    };
    tools.set(update.toolCallId, tool);
    const part = new vscode.ChatToolInvocationPart(tool.name ?? tool.kind ?? "OpenCode tool", tool.toolCallId);
    part.invocationMessage = tool.title ?? tool.toolCallId;
    part.pastTenseMessage = tool.title ?? tool.toolCallId;
    part.isComplete = ["completed", "failed"].includes(tool.status ?? "");
    part.isError = tool.status === "failed";
    part.isConfirmed = ["in_progress", "completed", "failed"].includes(tool.status ?? "");
    part.enablePartialUpdate = Boolean(previous);
    part.toolSpecificData = { input: display(tool.rawInput), output: display(tool.rawOutput ?? tool.content) };
    return part;
  }
}

export const choosePermissionEffect = Effect.fnUntraced(function* (vscode: { window: Pick<EditorApi["window"], "createQuickPick"> }, params: RequestPermissionRequest, signal: AbortSignal) {
  if (signal.aborted) return undefined;
  const answer = yield* Deferred.make<string | undefined>();
  const picker = yield* Effect.acquireRelease(
    Effect.sync(() => vscode.window.createQuickPick<VSCode.QuickPickItem & { optionId: string }>()),
    (picker) => Effect.sync(() => picker.dispose()));
  const input = display(params.toolCall.rawInput);
  picker.title = `OpenCode: ${params.toolCall.title ?? params.toolCall.toolCallId}`;
  picker.placeholder = `session=${params.sessionId} tool=${params.toolCall.toolCallId}`;
  picker.items = params.options.map((option) => ({
    label: option.name,
    description: option.kind,
    detail: input,
    optionId: option.optionId,
  }));
  const finish = (optionId: string | undefined) => Deferred.doneUnsafe(answer, Effect.succeed(signal.aborted ? undefined : optionId));
  const cancel = () => finish(undefined);
  yield* Effect.acquireRelease(Effect.sync(() => picker.onDidAccept(() => finish(picker.selectedItems[0]?.optionId))),
    (subscription) => Effect.sync(() => subscription.dispose()));
  yield* Effect.acquireRelease(Effect.sync(() => picker.onDidHide(cancel)),
    (subscription) => Effect.sync(() => subscription.dispose()));
  yield* Effect.acquireRelease(Effect.sync(() => signal.addEventListener("abort", cancel, { once: true })),
    () => Effect.sync(() => signal.removeEventListener("abort", cancel)));
  if (signal.aborted) return undefined;
  picker.show();
  // Never preselect an approval. Enter without an explicit selection cancels.
  picker.activeItems = [];
  const optionId = yield* Deferred.await(answer);
  return signal.aborted ? undefined : optionId;
}, Effect.scoped, Effect.catchDefect((error) => Effect.fail(error)));

export function choosePermission(vscode: { window: Pick<EditorApi["window"], "createQuickPick"> }, params: RequestPermissionRequest, signal: AbortSignal): Promise<string | undefined> {
  return Effect.runPromise(choosePermissionEffect(vscode, params, signal));
}

export function register(vscode: EditorApi, context: AdapterContext, backend: Sessions) {
  if (!vscode.workspace.isTrusted) throw new Error("[register] OpenCode requires a trusted workspace");
  const folders = (vscode.workspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === "file");
  if (!folders.length) throw new Error("[register] Open a local workspace folder before using OpenCode");

  if (typeof vscode.chat?.createChatSessionItemController !== "function" || typeof vscode.chat?.registerChatSessionContentProvider !== "function") {
    throw new Error("[register] chatSessionsProvider unavailable; launch VS Code with --enable-proposed-api=RabbitShare.opencode-native-chat");
  }
  if (typeof vscode.lm?.registerLanguageModelChatProvider !== "function") {
    throw new Error("[register] LanguageModelChat provider API unavailable; use VS Code 1.140.0 or a compatible Insiders");
  }
  if (typeof vscode.chat.registerChatSessionCustomizationProvider !== "function") {
    throw new Error("[register] chatSessionCustomizationProvider unavailable; use VS Code 1.140.0 or a compatible Insiders with proposed API enabled");
  }

  // Synchronous scope ownership avoids lazy runtime initialization changing admission order.
  const application = Scope.makeUnsafe();
  let disposed = false;
  const run: NativeRunner = (effect) => disposed
    ? Promise.reject(new Error("[OpenCode] Native adapter disposed"))
    : Effect.runPromise(effect.pipe(Effect.forkIn(application, { startImmediately: true }), Effect.flatMap(Fiber.join)));
  context.subscriptions.push({ dispose() {
    if (disposed) return;
    disposed = true;
    Effect.runFork(Scope.close(application, Exit.void));
  } });

  // Like the 1.140.0 Copilot CLI provider, this metadata satisfies native request conversion.
  // Generation stays in the session participant; zero limits/counts mean unknown, not an ACP limit.
  context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider(SESSION_TYPE, {
    provideLanguageModelChatInformation: () => run(Effect.sync(() => [{
      id: "configured", name: "OpenCode (configured)", family: "opencode", version: "",
      tooltip: "Uses the model configured in OpenCode. Token limits and counting are unavailable in this bridge.",
      maxInputTokens: 0, maxOutputTokens: 0,
      isDefault: true, isUserSelectable: true, targetChatSessionType: SESSION_TYPE,
      capabilities: { toolCalling: true, imageInput: false },
    }])),
    provideLanguageModelChatResponse: () => run(Effect.fail(new Error("[OpenCode model bridge] Use an OpenCode native chat session; direct language model requests are not supported"))),
    provideTokenCount: () => run(Effect.succeed(0)),
  }));

  const stored = context.workspaceState.get<unknown>("sessions", []);
  const saved = new Map<string, SavedSession>((Array.isArray(stored) ? stored : [])
    .filter((record: unknown): record is SavedSession => isObject(record) && typeof record.id === "string" && typeof record.cwd === "string" && isAbsolute(record.cwd) && folders.some((folder) => folder.uri.fsPath === record.cwd) &&
      (record.label === undefined || typeof record.label === "string") && (record.created === undefined || typeof record.created === "number"))
    .map((record) => [record.id, record]));
  const aliases = new Map<string, Deferred.Deferred<SessionRecord, unknown>>();
  const writer = Semaphore.makeUnsafe(1);
  const persist = () => {
    const snapshot = [...saved.values()];
    return Effect.uninterruptible(Effect.tryPromise({ try: async () => context.workspaceState.update("sessions", snapshot), catch: (error) => error }))
      .pipe(Semaphore.withPermit(writer));
  };
  const resourceFor = (id: string) => vscode.Uri.from({ scheme: SESSION_TYPE, path: `/${id}` });
  // Temporary boundary tracing: never include prompts, references, responses or errors.
  let requestTrace = 0;
  const diagnostic = (stage: string, state: string) => {
    try { backend.options.onLog(`[DEBUG-native-send] stage=${stage} ${state}\n`); }
    catch { /* Diagnostics must not change Send behavior. */ }
  };
  const participant = vscode.chat.createChatParticipant(PARTICIPANT, (request, chatContext, stream, token) => run(Effect.gen(function* () {
    const resource = chatContext.chatSessionContext?.chatSessionItem.resource;
    diagnostic("participant.enter", `ownResource=${resource?.scheme === SESSION_TYPE} cancelled=${token.isCancellationRequested}`);
    if (resource?.scheme !== SESSION_TYPE) {
      diagnostic("participant.foreign", "ownResource=false");
      return { errorDetails: { message: "[OpenCode] Use OpenCode: New Native Chat Session, not @opencode in a different session." } };
    }
    if (token.isCancellationRequested) {
      diagnostic("participant.cancelled", "cancelled=true");
      return {};
    }

    // VS Code 1.140.0 routes native sends through the participant whose ID matches the session type.
    diagnostic("participant.content.wait", `cancelled=${token.isCancellationRequested}`);
    yield* contentEffect(resource, token);
    diagnostic("participant.content.ready", `cancelled=${token.isCancellationRequested}`);
    return yield* requestEffect(resource, request, chatContext, stream, token);
  }).pipe(Effect.catchDefect((error) => Effect.fail(error)))));
  context.subscriptions.push(participant, backend);

  let controller: VSCode.ChatSessionItemController;
  try {
    controller = vscode.chat.createChatSessionItemController(SESSION_TYPE, () => run(Effect.sync(() => {
      controller.items.replace([...saved.values()].map(itemFor));
    })));
  } catch (error) {
    throw new Error(`[register] Cannot enable chatSessionsProvider. Launch with --enable-proposed-api=RabbitShare.opencode-native-chat: ${errorMessage(error)}`);
  }
  context.subscriptions.push(controller);

  function itemFor(record: SavedSession, status: SessionStatus | number = "completed") {
    const item = controller.createChatSessionItem(resourceFor(record.id), record.label ?? "OpenCode session");
    const statuses = { inProgress: vscode.ChatSessionStatus.InProgress, completed: vscode.ChatSessionStatus.Completed, needsInput: vscode.ChatSessionStatus.NeedsInput, failed: vscode.ChatSessionStatus.Failed };
    // Array.map also passes its numeric index here; preserve the existing refresh behavior.
    item.status = typeof status === "string" ? statuses[status] : undefined;
    item.description = record.cwd;
    item.timing = { created: record.created ?? Date.now() };
    return item;
  }

  const remember = Effect.fnUntraced(function* (record: SavedSession) {
    saved.set(record.id, { id: record.id, cwd: record.cwd, label: record.label, created: record.created });
    yield* persist();
  });

  const create = Effect.fnUntraced(function* (prompt: string, token: VSCode.CancellationToken) {
    if (token.isCancellationRequested) throw new Error("[create] Session creation cancelled");
    const folder = folders.length === 1 ? folders[0] : yield* Effect.tryPromise({
      try: async () => vscode.window.showWorkspaceFolderPick({ placeHolder: "Choose the OpenCode working directory" }), catch: (error) => error });
    if (!folder || token.isCancellationRequested) throw new Error("[create] Working directory selection cancelled");
    const record = yield* backend.createEffect(folder.uri.fsPath);
    if (prompt) record.label = prompt.slice(0, 80);
    yield* remember(record);
    const item = itemFor(record);
    controller.items.add(item);
    return item;
  }, Effect.catchDefect((error) => Effect.fail(error)));

  controller.newChatSessionItemHandler = (request, token) => run(create(promptText(request.request), token));

  const recordFor = Effect.fnUntraced(function* (resource: VSCode.Uri, prompt: string, token: VSCode.CancellationToken) {
    if (resource.scheme !== SESSION_TYPE) throw new Error(`[recordFor] Invalid scheme=${resource.scheme}`);
    const id = resource.path.slice(1);

    if (id.startsWith("untitled-")) {
      const key = resource.toString();
      const existing = aliases.get(key);
      if (existing) return yield* Deferred.await(existing);
      const pending = Deferred.makeUnsafe<SessionRecord, unknown>();
      aliases.set(key, pending);
      yield* create(prompt, token).pipe(Effect.map((item) => {
        const record = backend.records.get(item.resource.path.slice(1));
        if (!record) throw new Error(`[recordFor] Created session not found resource=${item.resource.toString()}`);
        return record;
      }), Effect.catchDefect((error) => Effect.fail(error)), Effect.exit, Effect.flatMap((result) => {
        if (Exit.isFailure(result) && aliases.get(key) === pending) aliases.delete(key);
        return Deferred.done(pending, result);
      }), Effect.forkIn(application, { startImmediately: true }));
      return yield* Deferred.await(pending);
    }

    const record = saved.get(id);
    if (!record) throw new Error(`[recordFor] Saved session not found sessionId=${id}`);
    return yield* backend.loadEffect(record);
  }, Effect.catchDefect((error) => Effect.fail(error)));

  function historyFor(record: SessionRecord) {
    return record.history.map((turn) => {
      if (turn.role === "user") return new vscode.ChatRequestTurn2(turn.nativeText ?? turn.text, undefined, [], PARTICIPANT, [], undefined, undefined, undefined, undefined);
      const tools = new Map<string, ToolState>();
      const parts = turn.updates.map((update) => renderUpdate(vscode, update, tools)).filter((part): part is RenderedPart => part !== undefined);
      return new vscode.ChatResponseTurn2(parts, {}, PARTICIPANT);
    });
  }

  const sessionOptions = registerSessionOptions(controller, backend, (resource, token) => recordFor(resource, "", token),
    (message) => vscode.window.showErrorMessage(message), run);
  context.subscriptions.push(sessionOptions);
  const sessionCommands = registerSessionCommands(vscode, backend, Effect.fnUntraced(function* (resource) {
    const alias = aliases.get(resource.toString());
    if (alias) return yield* backend.loadEffect(yield* Deferred.await(alias));
    const record = saved.get(resource.path.slice(1));
    return record && resource.toString() === resourceFor(record.id).toString() ? yield* backend.loadEffect(record) : undefined;
  }), run);
  context.subscriptions.push(sessionCommands);

  const statusListener = (record: SessionRecord, status: SessionStatus) => {
    sessionOptions.refresh();
    controller.items.add(itemFor(record, status));
    void run(remember(record).pipe(Effect.catch((error) => Effect.sync(() => {
      vscode.window.showErrorMessage(`[remember] sessionId=${record.id}: ${errorMessage(error)}`);
    })))).catch(() => { /* Application-scope interruption is normal during disposal. */ });
  };
  backend.on("status", statusListener);
  context.subscriptions.push({ dispose: () => backend.off("status", statusListener) });
  const failureListener = (error: Error) => vscode.window.showErrorMessage(`[OpenCode connection] ${error.message}`);
  backend.on("failure", failureListener);
  context.subscriptions.push({ dispose: () => backend.off("failure", failureListener) });

  const contentEffect = Effect.fnUntraced(function* (resource: VSCode.Uri, token: VSCode.CancellationToken, contentContext?: { inputState?: VSCode.ChatSessionInputState }): Effect.fn.Return<NativeSession, unknown> {
    diagnostic("content.enter", `draft=${resource.path.startsWith("/untitled-")} cancelled=${token.isCancellationRequested}`);
    const record = resource.path.startsWith("/untitled-") ? undefined : yield* recordFor(resource, "", token);
    diagnostic("content.ready", `materialized=${!!record} cancelled=${token.isCancellationRequested}`);

    return {
      title: record?.label ?? "OpenCode",
      history: record ? historyFor(record) : [],
      options: sessionOptions.provide(resource, record, contentContext?.inputState),
      requestHandler: (request, chatContext, stream, requestToken) => run(requestEffect(resource, request, chatContext, stream, requestToken)),
    };
  }, Effect.catchDefect((error) => Effect.fail(error)));

  const requestEffect = Effect.fnUntraced(function* (resource: VSCode.Uri, request: VSCode.ChatRequest,
    chatContext: VSCode.ChatContext, stream: VSCode.ChatResponseStream, requestToken: VSCode.CancellationToken) {
    const abort = new AbortController();
    yield* Effect.acquireRelease(Effect.sync(() => requestToken.onCancellationRequested(() => abort.abort())),
      (cancellation) => Effect.sync(() => { cancellation.dispose(); abort.abort(); }));
    if (requestToken.isCancellationRequested) abort.abort();
    const trace = ++requestTrace;
    let updates = 0;
    const log = (stage: string) => diagnostic(stage, `handler=${trace} cancelled=${abort.signal.aborted} updates=${updates}`);
    log("handler.enter");
    diagnostic("handler.input", `handler=${trace} references=${request.references?.length ?? 0} command=${typeof request.command === "string"} retry=${request.attempt > 0}`);

    return yield* Effect.gen(function* () {
      if (abort.signal.aborted) {
        log("handler.cancelled");
        return {};
      }
      if (request.attempt > 0) {
        throw new Error("Retry is disabled: ACP does not replace completed messages. Open the saved session; if history has not been restored, run Developer: Reload Window and open it again. Send a new message.");
      }
      const currentResource = chatContext.chatSessionContext?.chatSessionItem.resource ?? resource;
      const text = promptText(request);
      log("record.wait");
      const current = yield* recordFor(currentResource, text, requestToken);
      log("record.ready");
      log("references.check");
      sessionCommands.validateReferences(request.references ?? [], current);
      log("references.accepted");
      // Native edit/Retry can shorten history before invoking us. Never append
      // that replacement to the unchanged ACP conversation, even via a command.
      const nativeRequests = (chatContext.history ?? []).filter((turn) => turn instanceof vscode.ChatRequestTurn2);
      const validateHistory = () => {
        const previousRequests = current.history.filter((turn) => turn.role === "user");
        if (previousRequests.some((turn, index) => !nativeRequests[index] || promptText(nativeRequests[index]) !== (turn.nativeText ?? turn.text))) {
          throw new Error("Editing sent messages is disabled: ACP does not support history rollback. Open the saved session; if history has not been restored, run Developer: Reload Window and open it again. Send a new message.");
        }
      };
      validateHistory();
      const commandName = /^\/([^\s]+)/.exec(text.trimStart())?.[1];
      const validateCommand = () => {
        if (commandName && !current.availableCommands.some((command) => command.name === commandName)) {
          throw new Error("[OpenCode commands] Command is not advertised by the current session; select an available command");
        }
      };
      const tools = new Map<string, ToolState>();
      log("prompt.wait");
      const pending = backend.promptEffect(current, text, abort.signal, (update) => {
        if (++updates === 1) log("handler.update.first");
        const part = renderUpdate(vscode, update, tools);
        if (part instanceof vscode.ChatResponseMarkdownPart) stream.markdown(part.value);
        else if (part) stream.push(part);
      }, () => {
        log("references.recheck");
        sessionCommands.validateReferences(request.references ?? [], current);
        validateHistory();
        validateCommand();
        log("references.recheck.accepted");
      }, commandName ? () => Effect.suspend(() => {
        sessionCommands.validateReferences(request.references ?? [], current);
        validateCommand();
        const directories = vscode.workspace.getConfiguration("opencodeNativeChat", vscode.Uri.from({ scheme: "file", path: current.cwd })).get<string[]>("commandTemplateDirectories", []);
        return expandCommandTemplateEffect(current.cwd, text, { directories, processCwd: backend.options.cwd, environment: current.connection?.environment });
      }) : undefined, () => Effect.suspend(() => {
        sessionCommands.validateReferences(request.references ?? [], current);
        return prepareFileContextEffect(vscode, request.references ?? [], current.connection?.capabilities.embeddedContext, abort.signal);
      }));
      sessionOptions.refresh();
      yield* pending;
      log("handler.complete");
      return {};
    }).pipe(Effect.catchDefect((error) => Effect.fail(error)), Effect.catch((error) => {
      log("handler.failed");
      if (abort.signal.aborted) return Effect.succeed({});
      // VS Code 1.140.0 ignores a session handler's returned ChatResult, but renders thrown errors.
      return Effect.fail(new Error(`[requestHandler] resource=${resource.toString()}: ${errorMessage(error)}`, { cause: error }));
    }), Effect.ensuring(Effect.sync(() => {
      log("handler.cleanup");
      sessionOptions.refresh();
    })));
  }, Effect.scoped, Effect.catchDefect((error) => Effect.fail(error)));

  const provider = {
    provideChatSessionContent: (resource: VSCode.Uri, token: VSCode.CancellationToken, contentContext?: { inputState?: VSCode.ChatSessionInputState }) => run(contentEffect(resource, token, contentContext)),
  };
  context.subscriptions.push(vscode.chat.registerChatSessionContentProvider(SESSION_TYPE, provider, participant));

  context.subscriptions.push(vscode.commands.registerCommand("opencode.newSession", () => run(Effect.scoped(Effect.gen(function* () {
      const cancellation = yield* Effect.acquireRelease(Effect.sync(() => new vscode.CancellationTokenSource()),
        (cancellation) => Effect.sync(() => cancellation.dispose()));
      const item = yield* create("", cancellation.token);
      yield* Effect.tryPromise({ try: async () => vscode.commands.executeCommand("vscode.open", item.resource, { preview: false }), catch: (error) => error });
      // 1.140.0 opens REAL URIs in an editor; the native move closes that tab and preserves the session.
      yield* Effect.tryPromise({ try: async () => vscode.commands.executeCommand("workbench.action.chat.openInSidebar"), catch: (error) => error });
  }).pipe(Effect.catchDefect((error) => Effect.fail(error)))))));
  return controller;
}

const activateEffect = Effect.fnUntraced(function* (vscode: EditorApi, context: AdapterContext) {
  const output = vscode.window.createOutputChannel("OpenCode Native Chat");
  context.subscriptions.push(output);
  const configuration = vscode.workspace.getConfiguration("opencodeNativeChat");
  const backend = new Sessions({
    command: configuration.get("command", "opencode"),
    env: configuration.get<Record<string, string>>("env", {}),
    cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    permission: (params, signal) => choosePermissionEffect(vscode, params, signal),
    onLog: (text) => output.append(text),
  });

  return yield* Effect.gen(function* () {
    const controller = register(vscode, context, backend);
    // Registration alone does not populate the VS Code 1.140.0 model cache.
    // Discover only our metadata bridge; this never requests model generation.
    yield* Effect.tryPromise({ try: async () => vscode.lm.selectChatModels({ vendor: SESSION_TYPE }), catch: (error) => error });
    return controller;
  }).pipe(Effect.catchDefect((error) => Effect.fail(error)), Effect.catch((error) => {
    backend.dispose();
    vscode.window.showErrorMessage(`[activate] ${errorMessage(error)}`);
    return Effect.fail(error);
  }));
}, Effect.catchDefect((error) => Effect.fail(error)));

export function activateWithApi(vscode: EditorApi, context: AdapterContext) {
  return Effect.runPromise(activateEffect(vscode, context));
}
