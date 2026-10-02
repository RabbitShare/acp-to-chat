"use strict";

const { isAbsolute } = require("node:path");
const { Sessions } = require("./sessions");

const SESSION_TYPE = "opencode";
const PARTICIPANT = SESSION_TYPE;

function markdown(vscode, text) {
  const value = new vscode.MarkdownString(text);
  value.isTrusted = false;
  value.supportHtml = false;
  return value;
}

function display(value) {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function renderUpdate(vscode, update, tools) {
  if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
    return new vscode.ChatResponseMarkdownPart(markdown(vscode, update.content.text));
  }

  if (update.sessionUpdate === "agent_thought_chunk" && update.content?.type === "text") {
    return new vscode.ChatResponseThinkingProgressPart(update.content.text);
  }

  if (["tool_call", "tool_call_update"].includes(update.sessionUpdate)) {
    const previous = tools.get(update.toolCallId);
    const tool = { ...previous, ...Object.fromEntries(Object.entries(update).filter(([, value]) => value !== null && value !== undefined)) };
    tools.set(update.toolCallId, tool);
    const part = new vscode.ChatToolInvocationPart(tool.name ?? tool.kind ?? "OpenCode tool", tool.toolCallId);
    part.invocationMessage = tool.title ?? tool.toolCallId;
    part.pastTenseMessage = tool.title ?? tool.toolCallId;
    part.isComplete = ["completed", "failed"].includes(tool.status);
    part.isError = tool.status === "failed";
    part.isConfirmed = ["in_progress", "completed", "failed"].includes(tool.status);
    part.enablePartialUpdate = Boolean(previous);
    part.toolSpecificData = { input: display(tool.rawInput), output: display(tool.rawOutput ?? tool.content) };
    return part;
  }
}

function choosePermission(vscode, params, signal) {
  if (signal.aborted) return Promise.resolve(undefined);

  return new Promise((resolve) => {
    const picker = vscode.window.createQuickPick();
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
    const finish = (optionId) => {
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

function register(vscode, context, backend) {
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

  const saved = new Map((context.workspaceState.get("sessions", []) ?? [])
    .filter((record) => typeof record.id === "string" && typeof record.cwd === "string" && isAbsolute(record.cwd) && folders.some((folder) => folder.uri.fsPath === record.cwd))
    .map((record) => [record.id, record]));
  const aliases = new Map();
  let write = Promise.resolve();
  const persist = () => {
    const snapshot = [...saved.values()];
    write = write.catch(() => {}).then(() => context.workspaceState.update("sessions", snapshot));
    return write;
  };
  const resourceFor = (id) => vscode.Uri.from({ scheme: SESSION_TYPE, path: `/${id}` });
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

  let controller;
  try {
    controller = vscode.chat.createChatSessionItemController(SESSION_TYPE, async () => {
      controller.items.replace([...saved.values()].map(itemFor));
    });
  } catch (error) {
    throw new Error(`[register] Cannot enable chatSessionsProvider. Launch with --enable-proposed-api=local.opencode-native-chat: ${error.message}`);
  }
  context.subscriptions.push(controller);

  function itemFor(record, status = "completed") {
    const item = controller.createChatSessionItem(resourceFor(record.id), record.label ?? "OpenCode session");
    const statuses = { inProgress: vscode.ChatSessionStatus.InProgress, completed: vscode.ChatSessionStatus.Completed, needsInput: vscode.ChatSessionStatus.NeedsInput, failed: vscode.ChatSessionStatus.Failed };
    item.status = statuses[status];
    item.description = record.cwd;
    item.timing = { created: record.created ?? Date.now() };
    return item;
  }

  async function remember(record) {
    saved.set(record.id, { id: record.id, cwd: record.cwd, label: record.label, created: record.created });
    await persist();
  }

  async function create(prompt, token) {
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

  async function recordFor(resource, prompt, token) {
    if (resource.scheme !== SESSION_TYPE) throw new Error(`[recordFor] Invalid scheme=${resource.scheme}`);
    const id = resource.path.slice(1);

    if (id.startsWith("untitled-")) {
      const key = resource.toString();
      if (!aliases.has(key)) {
        const pending = create(prompt, token).then((item) => backend.records.get(item.resource.path.slice(1)));
        aliases.set(key, pending);
        pending.catch(() => aliases.delete(key));
      }
      return aliases.get(key);
    }

    const record = saved.get(id);
    if (!record) throw new Error(`[recordFor] Saved session not found sessionId=${id}`);
    return backend.load(record);
  }

  function historyFor(record) {
    return record.history.map((turn) => {
      if (turn.role === "user") return new vscode.ChatRequestTurn2(turn.text, undefined, [], PARTICIPANT, [], undefined, undefined, undefined, undefined);
      const tools = new Map();
      const parts = turn.updates.map((update) => renderUpdate(vscode, update, tools)).filter(Boolean);
      return new vscode.ChatResponseTurn2(parts, {}, PARTICIPANT);
    });
  }

  const statusListener = (record, status) => {
    controller.items.add(itemFor(record, status));
    remember(record).catch((error) => vscode.window.showErrorMessage(`[remember] sessionId=${record.id}: ${error.message}`));
  };
  backend.on("status", statusListener);
  context.subscriptions.push({ dispose: () => backend.off("status", statusListener) });
  const failureListener = (error) => vscode.window.showErrorMessage(`[OpenCode connection] ${error.message}`);
  backend.on("failure", failureListener);
  context.subscriptions.push({ dispose: () => backend.off("failure", failureListener) });

  const provider = {
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
            const currentResource = chatContext.chatSessionContext?.chatSessionItem.resource ?? resource;
            const current = await recordFor(currentResource, request.prompt, requestToken);
            const tools = new Map();
            await backend.prompt(current, request.prompt, abort.signal, (update) => {
              const part = renderUpdate(vscode, update, tools);
              if (part instanceof vscode.ChatResponseMarkdownPart) stream.markdown(part.value);
              else if (part) stream.push(part);
            });
            return {};
          } catch (error) {
            if (abort.signal.aborted) return {};
            // VS Code 1.140.0 ignores a session handler's returned ChatResult, but renders thrown errors.
            throw new Error(`[requestHandler] resource=${resource.toString()}: ${error.message}`, { cause: error });
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

function activate(context) {
  const vscode = require("vscode");
  const output = vscode.window.createOutputChannel("OpenCode Native Chat");
  context.subscriptions.push(output);
  const backend = new Sessions({
    command: vscode.workspace.getConfiguration("opencodeNativeChat").get("command", "opencode"),
    cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    permission: (params, signal) => choosePermission(vscode, params, signal),
    onLog: (text) => output.append(text),
  });

  try {
    return register(vscode, context, backend);
  } catch (error) {
    backend.dispose();
    vscode.window.showErrorMessage(`[activate] ${error.message}`);
    throw error;
  }
}

module.exports = { activate, register, renderUpdate, choosePermission };
