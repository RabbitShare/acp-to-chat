"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { Sessions } = require("../src/sessions");
const extension = require("../src/extension");
const { run: runEditorSmoke, waitForWorkspaceTrust } = require("./editor-smoke.cjs");

function api() {
  class Uri {
    constructor(value) { Object.assign(this, value); }
    static from(value) { return new Uri(value); }
    toString() { return `${this.scheme}:${this.path}`; }
  }
  class MarkdownString { constructor(value) { this.value = value; } }
  class Part { constructor(value) { this.value = value; } }
  class Tool { constructor(toolName, toolCallId) { Object.assign(this, { toolName, toolCallId }); } }
  class Request { constructor(prompt) { this.prompt = prompt; } }
  class Response { constructor(response) { this.response = response; } }
  const dispose = () => {};
  const participants = new Map();
  const modelProviders = new Map();
  const controller = {
    items: new Map(),
    dispose,
    createChatSessionItem: (resource, label) => ({ resource, label }),
    createChatSessionInputState: (groups) => ({ groups }),
  };
  const vscode = {
    Uri, MarkdownString,
    ChatResponseMarkdownPart: Part, ChatResponseThinkingProgressPart: Part,
    ChatToolInvocationPart: Tool, ChatRequestTurn2: Request, ChatResponseTurn2: Response,
    ChatSessionStatus: { InProgress: 2, Completed: 1, NeedsInput: 3, Failed: 0 },
    workspace: { isTrusted: true, workspaceFolders: [{ uri: { scheme: "file", fsPath: __dirname } }] },
    window: { createOutputChannel: () => ({ append: () => {}, dispose }), showErrorMessage: () => {} },
    commands: { registerCommand: () => ({ dispose }), executeCommand: async () => {} },
    lm: {
      registerLanguageModelChatProvider: (vendor, provider) => {
        const registration = { dispose: () => modelProviders.delete(vendor) };
        modelProviders.set(vendor, { provider, registration });
        return registration;
      },
    },
    chat: {
      createChatParticipant: (id, handler) => { participants.set(id, handler); return { id, dispose }; },
      createChatSessionItemController: (id, refresh) => { controller.refreshHandler = refresh; return controller; },
      registerChatSessionContentProvider: (id, provider) => { vscode.provider = provider; return { dispose }; },
    },
  };
  controller.items.add = (item) => controller.items.set(item.resource.toString(), item);
  controller.items.replace = (items) => { controller.items.clear(); items.forEach(controller.items.add); };
  const data = new Map();
  const context = { subscriptions: [], workspaceState: { get: (key, fallback) => data.get(key) ?? fallback, update: async (key, value) => data.set(key, value) } };
  return { vscode, context, controller, data, participants, modelProviders };
}

const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };

test("refuses session integration in an untrusted workspace", () => {
  const { vscode, context } = api();
  vscode.workspace.isTrusted = false;
  assert.equal(typeof extension.register, "function", "Native adapter is not implemented");
  assert.throws(() => extension.register(vscode, context, {}), /trusted/i);
});

test("reports unavailable proposed API before registering a provider", () => {
  const { vscode, context } = api();
  delete vscode.chat.createChatSessionItemController;
  assert.equal(typeof extension.register, "function", "Native adapter is not implemented");
  assert.throws(() => extension.register(vscode, context, {}), /enable-proposed-api/);
});

test("native model bridge publishes session-scoped metadata without starting ACP", async (t) => {
  const { vscode, context, modelProviders } = api();
  const backend = new Sessions({ command: process.execPath, cwd: __dirname, permission: async () => "no" });
  t.after(() => backend.dispose());
  extension.register(vscode, context, backend);
  const entry = modelProviders.get("opencode");
  assert.ok(entry, "Native requests need a registered OpenCode LanguageModelChat");
  const models = await entry.provider.provideLanguageModelChatInformation({ silent: true }, token);
  assert.equal(models.length, 1);
  assert.equal(models[0].targetChatSessionType, "opencode");
  assert.equal(models[0].isDefault, true);
  assert.equal(models[0].isUserSelectable, true);
  assert.equal(models[0].capabilities.toolCalling, true);
  assert.equal(models[0].capabilities.imageInput, false);
  assert.equal(models[0].maxInputTokens, 0);
  assert.equal(models[0].maxOutputTokens, 0);
  assert.equal(backend.client, undefined);
  assert.ok(context.subscriptions.includes(entry.registration));
});

test("native model bridge reports unavailable token counting without starting ACP", async (t) => {
  const { vscode, context, modelProviders } = api();
  const backend = new Sessions({ command: process.execPath, cwd: __dirname, permission: async () => "no" });
  t.after(() => backend.dispose());
  extension.register(vscode, context, backend);
  const { provider } = modelProviders.get("opencode");
  const [model] = await provider.provideLanguageModelChatInformation({ silent: true }, token);
  assert.equal(await provider.provideTokenCount(model, "question", token), 0);
  assert.equal(backend.client, undefined);
});

test("native model bridge rejects direct generation instead of bypassing the ACP participant", async (t) => {
  const { vscode, context, modelProviders } = api();
  const backend = new Sessions({ command: process.execPath, cwd: __dirname, permission: async () => "no" });
  t.after(() => backend.dispose());
  extension.register(vscode, context, backend);
  const entry = modelProviders.get("opencode");
  assert.ok(entry, "OpenCode model bridge is missing");
  const [model] = await entry.provider.provideLanguageModelChatInformation({ silent: true }, token);
  await assert.rejects(entry.provider.provideLanguageModelChatResponse(model, [], {}, {
    report() { assert.fail("Direct model generation must not stream"); },
  }, token), /native.*session/i);
  assert.equal(backend.client, undefined);
});

test("native model bridge reports a missing LM API before participant registration", (t) => {
  const { vscode, context, participants } = api();
  const backend = new Sessions({ command: process.execPath, cwd: __dirname, permission: async () => "no" });
  t.after(() => backend.dispose());
  delete vscode.lm;
  assert.throws(() => extension.register(vscode, context, backend), /LanguageModelChat.*unavailable/);
  assert.equal(participants.size, 0);
});

test("native request handler streams a real ACP turn and persists only metadata", async (t) => {
  const { vscode, context, controller, data } = api();
  const backend = new Sessions({ command: process.execPath, args: [path.join(__dirname, "fixtures/agent.cjs")], cwd: __dirname, permission: async () => "no" });
  t.after(() => backend.dispose());
  assert.equal(typeof extension.register, "function", "Native adapter is not implemented");
  extension.register(vscode, context, backend);
  const item = await controller.newChatSessionItemHandler({ request: { prompt: "question" } }, token);
  const session = await vscode.provider.provideChatSessionContent(item.resource, token, {});
  const text = [];
  const parts = [];
  await session.requestHandler({ prompt: "question" }, {}, { markdown: (value) => text.push(value.value), push: (part) => parts.push(part) }, token);
  assert.deepEqual(text, ["answer:question"]);
  assert.equal(parts.at(-1).isComplete, true);
  assert.equal(controller.items.get(item.resource.toString()).status, 1);
  assert.equal(data.get("sessions")[0].id, "session-1");
  assert.equal("history" in data.get("sessions")[0], false);
});

test("session-type participant routes a materialized native request to ACP", async (t) => {
  const { vscode, context, controller, participants } = api();
  const backend = new Sessions({ command: process.execPath, args: [path.join(__dirname, "fixtures/agent.cjs")], cwd: __dirname, permission: async () => "no" });
  t.after(() => backend.dispose());
  extension.register(vscode, context, backend);
  const item = await controller.newChatSessionItemHandler({ request: { prompt: "native question" } }, token);
  const text = [];
  const handler = participants.get("opencode");
  assert.equal(typeof handler, "function", "Session type opencode has no activated participant");
  await handler({ prompt: "native question" }, { chatSessionContext: { chatSessionItem: item } },
    { markdown: (value) => text.push(value.value), push() {} }, token);
  assert.deepEqual(text, ["answer:native question"]);
});

test("editing a completed native request replaces its turn instead of appending another", async (t) => {
  const { vscode, context, controller, participants } = api();
  const backend = new Sessions({ command: process.execPath, args: [path.join(__dirname, "fixtures/agent.cjs")], cwd: __dirname, permission: async () => "no" });
  t.after(() => backend.dispose());
  extension.register(vscode, context, backend);
  const item = await controller.newChatSessionItemHandler({ request: { prompt: "original" } }, token);
  const handler = participants.get("opencode");
  // VS Code drops the edited request from context.history and gives its replacement a new request ID.
  for (const [index, prompt] of ["original", "replacement"].entries()) {
    const text = [];
    await handler({ id: `request-${index}`, prompt, attempt: 0 }, {
      history: [], chatSessionContext: { chatSessionItem: item },
    }, { markdown: (value) => text.push(value.value), push() {} }, token);
    assert.deepEqual(text, [`answer:${prompt}`], "Every send must stream its own answer");
  }
  const restored = await vscode.provider.provideChatSessionContent(item.resource, token);
  assert.deepEqual(restored.history.filter((turn) => turn instanceof vscode.ChatRequestTurn2).map((turn) => turn.prompt),
    ["replacement"], "The replaced request must not return when the native history is reopened");
});

test("session-type participant does not start ACP for a different chat scheme", async () => {
  const { vscode, context, participants } = api();
  const backend = new Sessions({ command: process.execPath, cwd: __dirname, permission: async () => "no" });
  extension.register(vscode, context, backend);
  const result = await participants.get("opencode")({ prompt: "question" }, {
    chatSessionContext: { chatSessionItem: { resource: vscode.Uri.from({ scheme: "vscode-chat-session", path: "/local" }) } },
  }, {}, token);
  assert.match(result.errorDetails.message, /New Native Chat Session/);
  assert.equal(backend.client, undefined);
});

test("session-type participant creates an untitled session before streaming its first answer", async (t) => {
  const { vscode, context, participants, data } = api();
  const backend = new Sessions({ command: process.execPath, args: [path.join(__dirname, "fixtures/agent.cjs")], cwd: __dirname, permission: async () => "no" });
  t.after(() => backend.dispose());
  extension.register(vscode, context, backend);
  const text = [];
  await participants.get("opencode")({ prompt: "first question" }, {
    chatSessionContext: { chatSessionItem: { resource: vscode.Uri.from({ scheme: "opencode", path: "/untitled-native" }) } },
  }, { markdown: (value) => text.push(value.value), push() {} }, token);
  assert.deepEqual(text, ["answer:first question"]);
  assert.equal(data.get("sessions").length, 1);
  assert.equal(data.get("sessions")[0].id, "session-1");
});

test("session-type participant does not load a session when the request is already cancelled", async () => {
  const { vscode, context, participants } = api();
  const backend = new Sessions({ command: process.execPath, cwd: __dirname, permission: async () => "no" });
  extension.register(vscode, context, backend);
  const result = await participants.get("opencode")({ prompt: "question" }, {
    chatSessionContext: { chatSessionItem: { resource: vscode.Uri.from({ scheme: "opencode", path: "/not-saved" }) } },
  }, { markdown() { assert.fail("Cancelled request must not stream"); } }, { ...token, isCancellationRequested: true });
  assert.deepEqual(result, {});
  assert.equal(backend.client, undefined);
});

test("merges partial tool updates without losing the tool name", () => {
  const { vscode } = api();
  const tools = new Map();
  assert.equal(typeof extension.renderUpdate, "function", "Native rendering is not implemented");
  extension.renderUpdate(vscode, { sessionUpdate: "tool_call", toolCallId: "1", name: "bash", title: "Run pwd", status: "in_progress" }, tools);
  const part = extension.renderUpdate(vscode, { sessionUpdate: "tool_call_update", toolCallId: "1", status: "failed", rawOutput: "not allowed" }, tools);
  assert.equal(part.toolName, "bash");
  assert.equal(part.isError, true);
  assert.equal(part.isComplete, true);
  assert.equal(part.toolSpecificData.output, "not allowed");
});

test("permission picker dismissal returns no approval", async () => {
  const { vscode } = api();
  let hide;
  const picker = {
    selectedItems: [], show() {}, dispose() {},
    onDidAccept: () => ({ dispose() {} }),
    onDidHide: (listener) => { hide = listener; return { dispose() {} }; },
  };
  vscode.window.createQuickPick = () => picker;
  const answer = extension.choosePermission(vscode, {
    sessionId: "1", toolCall: { toolCallId: "tool", title: "Execute", rawInput: { command: "pwd" } },
    options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
  }, new AbortController().signal);
  hide();
  assert.equal(await answer, undefined);
});

test("permission cancellation cannot return a selected approval", async () => {
  const { vscode } = api();
  const picker = {
    selectedItems: [{ optionId: "allow" }], show() {}, dispose() {},
    onDidAccept: () => ({ dispose() {} }), onDidHide: () => ({ dispose() {} }),
  };
  vscode.window.createQuickPick = () => picker;
  const controller = new AbortController();
  const answer = extension.choosePermission(vscode, {
    sessionId: "1", toolCall: { toolCallId: "tool" },
    options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
  }, controller.signal);
  controller.abort();
  assert.equal(await answer, undefined);
});

for (const selected of ["allow", "reject"]) {
  test(`permission picker returns the explicit choice: ${selected}`, async () => {
    const { vscode } = api();
    let accept;
    const picker = {
      selectedItems: [], show() {}, dispose() {},
      onDidAccept: (listener) => { accept = listener; return { dispose() {} }; },
      onDidHide: () => ({ dispose() {} }),
    };
    vscode.window.createQuickPick = () => picker;
    const answer = extension.choosePermission(vscode, {
      sessionId: "1", toolCall: { toolCallId: "tool", rawInput: { command: "pwd" } },
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "reject", name: "Reject", kind: "reject_once" }],
    }, new AbortController().signal);
    picker.selectedItems = picker.items.filter((item) => item.optionId === selected);
    accept();
    assert.equal(await answer, selected);
  });
}

test("permission picker clears default approval before an empty Enter", async () => {
  const { vscode } = api();
  let accept;
  const picker = {
    activeItems: [],
    selectedItems: [],
    show() { this.activeItems = [this.items[0]]; },
    dispose() {},
    onDidAccept: (listener) => { accept = listener; return { dispose() {} }; },
    onDidHide: () => ({ dispose() {} }),
  };
  vscode.window.createQuickPick = () => picker;
  const answer = extension.choosePermission(vscode, {
    sessionId: "1", toolCall: { toolCallId: "tool" },
    options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
  }, new AbortController().signal);
  // Single-selection Enter accepts the active item unless the adapter clears it.
  picker.selectedItems = picker.activeItems;
  accept();
  assert.equal(await answer, undefined);
});

test("agent Markdown cannot enable command links or HTML", () => {
  const { vscode } = api();
  const text = '[run](command:workbench.action.files.saveAll) <img src="x" onerror="alert(1)">';
  const part = extension.renderUpdate(vscode, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } }, new Map());
  assert.equal(part.value.value, text);
  assert.equal(part.value.isTrusted, false);
  assert.equal(part.value.supportHtml, false);
});

test("native handler rejects backend errors instead of returning an ignored result", async (t) => {
  const { vscode, context, controller } = api();
  const backend = new Sessions({ command: process.execPath, args: [path.join(__dirname, "fixtures/agent.cjs")], cwd: __dirname, permission: async () => "no" });
  t.after(() => backend.dispose());
  extension.register(vscode, context, backend);
  const item = await controller.newChatSessionItemHandler({ request: { prompt: "__fail__" } }, token);
  const session = await vscode.provider.provideChatSessionContent(item.resource, token, {});
  await assert.rejects(session.requestHandler({ prompt: "__fail__" }, {}, { markdown() {}, push() {} }, token), /requestHandler.*session-1.*prompt failed/);
});

test("smoke proceeds without requesting trust when already trusted", async () => {
  await waitForWorkspaceTrust({ workspace: { isTrusted: true } });
});

test("smoke waits for the user trust event without granting trust itself", async () => {
  let granted;
  let disposed = false;
  let message;
  const waiting = waitForWorkspaceTrust({
    workspace: {
      isTrusted: false,
      onDidGrantWorkspaceTrust: (listener) => {
        granted = listener;
        return { dispose: () => { disposed = true; } };
      },
    },
    window: { showInformationMessage: (value) => { message = value; } },
  });
  assert.equal(disposed, false);
  assert.match(message, /Manage Workspace Trust/);
  granted();
  await waiting;
  assert.equal(disposed, true);
});

test("smoke fails instead of bypassing trust when the user does not grant it", async () => {
  let disposed = false;
  await assert.rejects(waitForWorkspaceTrust({
    workspace: {
      isTrusted: false,
      onDidGrantWorkspaceTrust: () => ({ dispose: () => { disposed = true; } }),
    },
    window: { showInformationMessage() {} },
  }, 25), /waitForWorkspaceTrust.*25ms/);
  assert.equal(disposed, true);
});

test("smoke checks registration and command execution without using the Local-only session getter", async () => {
  const invoked = [];
  await runEditorSmoke({
    workspace: { isTrusted: true },
    extensions: {
      getExtension: (id) => {
        assert.equal(id, "local.opencode-native-chat");
        return { activate: async () => ({ id: "opencode" }) };
      },
    },
    commands: {
      getCommands: async () => ["workbench.action.chat.openNewChatSessionInPlace.opencode"],
      executeCommand: async (command) => { invoked.push(command); },
    },
    window: {
      get activeChatPanelSessionResource() { throw new Error("Local-only getter must not be used for external sessions"); },
    },
  });
  assert.deepEqual(invoked, ["opencode.newSession"]);
});
