import { isAbsolute } from "node:path";
import { Sessions, type SavedSession, type SessionRecord, type SessionStatus } from "./sessions";
import type * as VSCode from "vscode";
import type { RequestPermissionRequest, SessionUpdate, ToolCallUpdate } from "@agentclientprotocol/sdk";
import { errorMessage, isObject, isTextContent } from "./protocol";

export type EditorApi = Pick<typeof VSCode,
  "MarkdownString" | "ChatResponseMarkdownPart" | "ChatResponseThinkingProgressPart" |
  "ChatToolInvocationPart" | "ChatRequestTurn2" | "ChatResponseTurn2" | "ChatSessionStatus" | "Uri"> & {
  window: Pick<typeof VSCode.window, "createQuickPick" | "showWorkspaceFolderPick" | "showErrorMessage" | "createOutputChannel">;
  workspace: Pick<typeof VSCode.workspace, "isTrusted" | "workspaceFolders" | "getConfiguration">;
  chat: Pick<typeof VSCode.chat, "createChatParticipant" | "createChatSessionItemController" | "registerChatSessionContentProvider">;
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
  const participant = vscode.chat.createChatParticipant(PARTICIPANT, async (request, chatContext, stream, token) => {
    const resource = chatContext.chatSessionContext?.chatSessionItem.resource;
    if (resource?.scheme !== SESSION_TYPE) {
      return { errorDetails: { message: "[OpenCode] Use OpenCode: New Native Chat Session, not @opencode in a different session." } };
    }
    if (token.isCancellationRequested) return {};

    // VS Code 1.140.0 routes native sends through the participant whose ID matches the session type.
    const session = await provider.provideChatSessionContent(resource, token);
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

  controller.newChatSessionItemHandler = (request, token) => create(request.request.prompt, token);

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
      if (turn.role === "user") return new vscode.ChatRequestTurn2(turn.text, undefined, [], PARTICIPANT, [], undefined, undefined, undefined, undefined);
      const tools = new Map<string, ToolState>();
      const parts = turn.updates.map((update) => renderUpdate(vscode, update, tools)).filter((part): part is RenderedPart => part !== undefined);
      return new vscode.ChatResponseTurn2(parts, {}, PARTICIPANT);
    });
  }

  const statusListener = (record: SessionRecord, status: SessionStatus) => {
    controller.items.add(itemFor(record, status));
    remember(record).catch((error: unknown) => vscode.window.showErrorMessage(`[remember] sessionId=${record.id}: ${errorMessage(error)}`));
  };
  backend.on("status", statusListener);
  context.subscriptions.push({ dispose: () => backend.off("status", statusListener) });
  const failureListener = (error: Error) => vscode.window.showErrorMessage(`[OpenCode connection] ${error.message}`);
  backend.on("failure", failureListener);
  context.subscriptions.push({ dispose: () => backend.off("failure", failureListener) });

  const provider: { provideChatSessionContent(resource: VSCode.Uri, token: VSCode.CancellationToken): Promise<NativeSession> } = {
    async provideChatSessionContent(resource, token) {
      const record = resource.path.startsWith("/untitled-") ? undefined : await recordFor(resource, "", token);

      return {
        title: record?.label ?? "OpenCode",
        history: record ? historyFor(record) : [],
        async requestHandler(request, chatContext, stream, requestToken) {
          const abort = new AbortController();
          const cancellation = requestToken.onCancellationRequested(() => abort.abort());
          if (requestToken.isCancellationRequested) abort.abort();

          try {
            if (abort.signal.aborted) return {};
            if (request.attempt > 0) {
              throw new Error("Retry is disabled: ACP does not replace completed messages. Open the saved session; if history has not been restored, run Developer: Reload Window and open it again. Send a new message.");
            }
            const currentResource = chatContext.chatSessionContext?.chatSessionItem.resource ?? resource;
            const current = await recordFor(currentResource, request.prompt, requestToken);
            // Native edit/Retry can shorten history before invoking us. Never append
            // that replacement to the unchanged ACP conversation, even via a command.
            const nativeRequests = (chatContext.history ?? []).filter((turn) => turn instanceof vscode.ChatRequestTurn2);
            const previousRequests = current.history.filter((turn) => turn.role === "user");
            if (previousRequests.some((turn, index) => nativeRequests[index]?.prompt !== turn.text)) {
              throw new Error("Editing sent messages is disabled: ACP does not support history rollback. Open the saved session; if history has not been restored, run Developer: Reload Window and open it again. Send a new message.");
            }
            const tools = new Map<string, ToolState>();
            await backend.prompt(current, request.prompt, abort.signal, (update) => {
              const part = renderUpdate(vscode, update, tools);
              if (part instanceof vscode.ChatResponseMarkdownPart) stream.markdown(part.value);
              else if (part) stream.push(part);
            });
            return {};
          } catch (error) {
            if (abort.signal.aborted) return {};
            // VS Code 1.140.0 ignores a session handler's returned ChatResult, but renders thrown errors.
            throw new Error(`[requestHandler] resource=${resource.toString()}: ${errorMessage(error)}`, { cause: error });
          } finally {
            cancellation.dispose();
            abort.abort();
          }
        },
      };
    },
  };
  context.subscriptions.push(vscode.chat.registerChatSessionContentProvider(SESSION_TYPE, provider, participant));

  context.subscriptions.push(vscode.commands.registerCommand("opencode.newSession", () =>
    vscode.commands.executeCommand("workbench.action.chat.openNewChatSessionInPlace.opencode", "sidebar")));
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
