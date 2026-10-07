import { isAbsolute } from "node:path";
import { Sessions, type SavedSession, type SessionRecord, type SessionStatus } from "./sessions";
import type * as VSCode from "vscode";
import type { RequestPermissionRequest, SessionUpdate, ToolCallUpdate } from "@agentclientprotocol/sdk";
import { errorMessage, isObject, isTextContent } from "./protocol";
import { registerSessionOptions } from "./session-options";
import { registerSessionCommands } from "./session-commands";
import { expandCommandTemplate } from "./command-templates";
export { expandCommandTemplate } from "./command-templates";

export type EditorApi = Pick<typeof VSCode,
  "MarkdownString" | "ChatResponseMarkdownPart" | "ChatResponseThinkingProgressPart" |
  "ChatToolInvocationPart" | "ChatRequestTurn2" | "ChatResponseTurn2" | "ChatSessionStatus" | "Uri" | "CancellationTokenSource" |
  "EventEmitter" | "FileSystemError" | "FileType" | "ChatSessionCustomizationType"> & {
  window: Pick<typeof VSCode.window, "createQuickPick" | "showWorkspaceFolderPick" | "showErrorMessage" | "createOutputChannel">;
  workspace: Pick<typeof VSCode.workspace, "isTrusted" | "workspaceFolders" | "getConfiguration" | "registerFileSystemProvider">;
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

export function choosePermission(vscode: { window: Pick<EditorApi["window"], "createQuickPick"> }, params: RequestPermissionRequest, signal: AbortSignal): Promise<string | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);

  return new Promise<string | undefined>((resolve) => {
    const picker = vscode.window.createQuickPick<VSCode.QuickPickItem & { optionId: string }>();
    const input = display(params.toolCall.rawInput);
    picker.title = `OpenCode: ${params.toolCall.title ?? params.toolCall.toolCallId}`;
    picker.placeholder = `session=${params.sessionId} tool=${params.toolCall.toolCallId}`;
    picker.items = params.options.map((option) => ({
      label: option.name,
      description: option.kind,
      detail: input,
      optionId: option.optionId,
    }));
    let done = false;
    const finish = (optionId: string | undefined) => {
      if (done) return;
      done = true;
      signal.removeEventListener("abort", cancel);
      accept.dispose();
      hide.dispose();
      picker.dispose();
      resolve(signal.aborted ? undefined : optionId);
    };
    const cancel = () => finish(undefined);
    const accept = picker.onDidAccept(() => finish(picker.selectedItems[0]?.optionId));
    const hide = picker.onDidHide(() => finish(undefined));
    signal.addEventListener("abort", cancel, { once: true });
    picker.show();
    // Never preselect an approval. Enter without an explicit selection cancels.
    picker.activeItems = [];
  });
}

export function register(vscode: EditorApi, context: AdapterContext, backend: Sessions) {
  if (!vscode.workspace.isTrusted) throw new Error("[register] OpenCode requires a trusted workspace");
  const folders = (vscode.workspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === "file");
  if (!folders.length) throw new Error("[register] Open a local workspace folder before using OpenCode");

  if (typeof vscode.chat?.createChatSessionItemController !== "function" || typeof vscode.chat?.registerChatSessionContentProvider !== "function") {
    throw new Error("[register] chatSessionsProvider unavailable; launch VS Code with --enable-proposed-api=local.opencode-native-chat");
  }
  if (typeof vscode.lm?.registerLanguageModelChatProvider !== "function") {
    throw new Error("[register] LanguageModelChat provider API unavailable; use VS Code 1.140.0 or a compatible Insiders");
  }
  if (typeof vscode.chat.registerChatSessionCustomizationProvider !== "function") {
    throw new Error("[register] chatSessionCustomizationProvider unavailable; use VS Code 1.140.0 or a compatible Insiders with proposed API enabled");
  }

  // Like the 1.140.0 Copilot CLI provider, this metadata satisfies native request conversion.
  // Generation stays in the session participant; zero limits/counts mean unknown, not an ACP limit.
  context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider(SESSION_TYPE, {
    provideLanguageModelChatInformation: async () => [{
      id: "configured", name: "OpenCode (configured)", family: "opencode", version: "",
      tooltip: "Uses the model configured in OpenCode. Token limits and counting are unavailable in this bridge.",
      maxInputTokens: 0, maxOutputTokens: 0,
      isDefault: true, isUserSelectable: true, targetChatSessionType: SESSION_TYPE,
      capabilities: { toolCalling: true, imageInput: false },
    }],
    provideLanguageModelChatResponse: async () => {
      throw new Error("[OpenCode model bridge] Use an OpenCode native chat session; direct language model requests are not supported");
    },
    provideTokenCount: async () => 0,
  }));

  const stored = context.workspaceState.get<unknown>("sessions", []);
  const saved = new Map<string, SavedSession>((Array.isArray(stored) ? stored : [])
    .filter((record: unknown): record is SavedSession => isObject(record) && typeof record.id === "string" && typeof record.cwd === "string" && isAbsolute(record.cwd) && folders.some((folder) => folder.uri.fsPath === record.cwd) &&
      (record.label === undefined || typeof record.label === "string") && (record.created === undefined || typeof record.created === "number"))
    .map((record) => [record.id, record]));
  const aliases = new Map<string, Promise<SessionRecord>>();
  let write = Promise.resolve();
  const persist = () => {
    const snapshot = [...saved.values()];
    write = write.catch(() => {}).then(() => context.workspaceState.update("sessions", snapshot));
    return write;
  };
  const resourceFor = (id: string) => vscode.Uri.from({ scheme: SESSION_TYPE, path: `/${id}` });
  // Temporary boundary tracing: never include prompts, references, responses or errors.
  let requestTrace = 0;
  const diagnostic = (stage: string, state: string) => {
    try { backend.options.onLog(`[DEBUG-native-send] stage=${stage} ${state}\n`); }
    catch { /* Diagnostics must not change Send behavior. */ }
  };
  const participant = vscode.chat.createChatParticipant(PARTICIPANT, async (request, chatContext, stream, token) => {
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
    const session = await provider.provideChatSessionContent(resource, token);
    diagnostic("participant.content.ready", `cancelled=${token.isCancellationRequested}`);
    return session.requestHandler(request, chatContext, stream, token);
  });
  context.subscriptions.push(participant, backend);

  let controller: VSCode.ChatSessionItemController;
  try {
    controller = vscode.chat.createChatSessionItemController(SESSION_TYPE, async () => {
      controller.items.replace([...saved.values()].map(itemFor));
    });
  } catch (error) {
    throw new Error(`[register] Cannot enable chatSessionsProvider. Launch with --enable-proposed-api=local.opencode-native-chat: ${errorMessage(error)}`);
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

  async function remember(record: SavedSession) {
    saved.set(record.id, { id: record.id, cwd: record.cwd, label: record.label, created: record.created });
    await persist();
  }

  async function create(prompt: string, token: VSCode.CancellationToken) {
    if (token.isCancellationRequested) throw new Error("[create] Session creation cancelled");
    const folder = folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick({ placeHolder: "Choose the OpenCode working directory" });
    if (!folder || token.isCancellationRequested) throw new Error("[create] Working directory selection cancelled");
    const record = await backend.create(folder.uri.fsPath);
    if (prompt) record.label = prompt.slice(0, 80);
    await remember(record);
    const item = itemFor(record);
    controller.items.add(item);
    return item;
  }

  controller.newChatSessionItemHandler = (request, token) => create(promptText(request.request), token);

  async function recordFor(resource: VSCode.Uri, prompt: string, token: VSCode.CancellationToken): Promise<SessionRecord> {
    if (resource.scheme !== SESSION_TYPE) throw new Error(`[recordFor] Invalid scheme=${resource.scheme}`);
    const id = resource.path.slice(1);

    if (id.startsWith("untitled-")) {
      const key = resource.toString();
      const existing = aliases.get(key);
      if (existing) return existing;
      const pending = create(prompt, token).then((item) => {
        const record = backend.records.get(item.resource.path.slice(1));
        if (!record) throw new Error(`[recordFor] Created session not found resource=${item.resource.toString()}`);
        return record;
      });
      aliases.set(key, pending);
      pending.catch(() => aliases.delete(key));
      return pending;
    }

    const record = saved.get(id);
    if (!record) throw new Error(`[recordFor] Saved session not found sessionId=${id}`);
    return backend.load(record);
  }

  function historyFor(record: SessionRecord) {
    return record.history.map((turn) => {
      if (turn.role === "user") return new vscode.ChatRequestTurn2(turn.nativeText ?? turn.text, undefined, [], PARTICIPANT, [], undefined, undefined, undefined, undefined);
      const tools = new Map<string, ToolState>();
      const parts = turn.updates.map((update) => renderUpdate(vscode, update, tools)).filter((part): part is RenderedPart => part !== undefined);
      return new vscode.ChatResponseTurn2(parts, {}, PARTICIPANT);
    });
  }

  const sessionOptions = registerSessionOptions(controller, backend, (resource, token) => recordFor(resource, "", token),
    (message) => vscode.window.showErrorMessage(message));
  context.subscriptions.push(sessionOptions);
  const sessionCommands = registerSessionCommands(vscode, backend, async (resource) => {
    const alias = aliases.get(resource.toString());
    if (alias) return backend.load(await alias);
    const record = saved.get(resource.path.slice(1));
    return record && resource.toString() === resourceFor(record.id).toString() ? backend.load(record) : undefined;
  });
  context.subscriptions.push(sessionCommands);

  const statusListener = (record: SessionRecord, status: SessionStatus) => {
    sessionOptions.refresh();
    controller.items.add(itemFor(record, status));
    remember(record).catch((error: unknown) => vscode.window.showErrorMessage(`[remember] sessionId=${record.id}: ${errorMessage(error)}`));
  };
  backend.on("status", statusListener);
  context.subscriptions.push({ dispose: () => backend.off("status", statusListener) });
  const failureListener = (error: Error) => vscode.window.showErrorMessage(`[OpenCode connection] ${error.message}`);
  backend.on("failure", failureListener);
  context.subscriptions.push({ dispose: () => backend.off("failure", failureListener) });

  const provider: { provideChatSessionContent(resource: VSCode.Uri, token: VSCode.CancellationToken, context?: { inputState?: VSCode.ChatSessionInputState }): Promise<NativeSession> } = {
    async provideChatSessionContent(resource, token, contentContext) {
      diagnostic("content.enter", `draft=${resource.path.startsWith("/untitled-")} cancelled=${token.isCancellationRequested}`);
      const record = resource.path.startsWith("/untitled-") ? undefined : await recordFor(resource, "", token);
      diagnostic("content.ready", `materialized=${!!record} cancelled=${token.isCancellationRequested}`);

      return {
        title: record?.label ?? "OpenCode",
        history: record ? historyFor(record) : [],
        options: sessionOptions.provide(resource, record, contentContext?.inputState),
        async requestHandler(request, chatContext, stream, requestToken) {
          const abort = new AbortController();
          const cancellation = requestToken.onCancellationRequested(() => abort.abort());
          if (requestToken.isCancellationRequested) abort.abort();
          const trace = ++requestTrace;
          let updates = 0;
          const log = (stage: string) => diagnostic(stage, `handler=${trace} cancelled=${abort.signal.aborted} updates=${updates}`);
          log("handler.enter");
          diagnostic("handler.input", `handler=${trace} references=${request.references?.length ?? 0} command=${typeof request.command === "string"} retry=${request.attempt > 0}`);

          try {
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
            const current = await recordFor(currentResource, text, requestToken);
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
            const pending = backend.prompt(current, text, abort.signal, (update) => {
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
            }, commandName ? async () => {
              sessionCommands.validateReferences(request.references ?? [], current);
              validateCommand();
              const directories = vscode.workspace.getConfiguration("opencodeNativeChat", vscode.Uri.from({ scheme: "file", path: current.cwd })).get<string[]>("commandTemplateDirectories", []);
              return expandCommandTemplate(current.cwd, text, { directories, processCwd: backend.options.cwd });
            } : undefined);
            sessionOptions.refresh();
            await pending;
            log("handler.complete");
            return {};
          } catch (error) {
            log("handler.failed");
            if (abort.signal.aborted) return {};
            // VS Code 1.140.0 ignores a session handler's returned ChatResult, but renders thrown errors.
            throw new Error(`[requestHandler] resource=${resource.toString()}: ${errorMessage(error)}`, { cause: error });
          } finally {
            log("handler.cleanup");
            sessionOptions.refresh();
            cancellation.dispose();
            abort.abort();
          }
        },
      };
    },
  };
  context.subscriptions.push(vscode.chat.registerChatSessionContentProvider(SESSION_TYPE, provider, participant));

  context.subscriptions.push(vscode.commands.registerCommand("opencode.newSession", async () => {
    const cancellation = new vscode.CancellationTokenSource();
    try {
      const item = await create("", cancellation.token);
      await vscode.commands.executeCommand("vscode.open", item.resource, { preview: false });
      // 1.140.0 opens REAL URIs in an editor; the native move closes that tab and preserves the session.
      await vscode.commands.executeCommand("workbench.action.chat.openInSidebar");
    } finally {
      cancellation.dispose();
    }
  }));
  return controller;
}

export async function activateWithApi(vscode: EditorApi, context: AdapterContext) {
  const output = vscode.window.createOutputChannel("OpenCode Native Chat");
  context.subscriptions.push(output);
  const backend = new Sessions({
    command: vscode.workspace.getConfiguration("opencodeNativeChat").get("command", "opencode"),
    cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    permission: (params, signal) => choosePermission(vscode, params, signal),
    onLog: (text) => output.append(text),
  });

  try {
    const controller = register(vscode, context, backend);
    // Registration alone does not populate the VS Code 1.140.0 model cache.
    // Discover only our metadata bridge; this never requests model generation.
    await vscode.lm.selectChatModels({ vendor: SESSION_TYPE });
    return controller;
  } catch (error) {
    backend.dispose();
    vscode.window.showErrorMessage(`[activate] ${errorMessage(error)}`);
    throw error;
  }
}
