"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { Sessions } = require("../dist/sessions");
const extension = require("../dist/extension");
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
  const context = { subscriptions: [], workspaceState: { get: (key, fallback) => data.has(key) ? data.get(key) : fallback, update: async (key, value) => data.set(key, value) } };
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

test("activation discovers the OpenCode model bridge in a fresh editor catalogue without starting ACP", async (t) => {
  const { vscode, context, modelProviders } = api();
  t.after(() => context.subscriptions.forEach((subscription) => subscription.dispose()));
  vscode.workspace.getConfiguration = () => ({ get: (_key, fallback) => fallback });
  let discovered = [];
  let releaseDiscovery;
  const discovery = new Promise((resolve) => { releaseDiscovery = resolve; });
  vscode.lm.selectChatModels = async (selector) => {
    assert.deepEqual(selector, { vendor: "opencode" }, "Discovery must not query other providers");
    const entry = modelProviders.get("opencode");
    assert.ok(entry, "Register the provider before requesting discovery");
    discovered = await entry.provider.provideLanguageModelChatInformation({ silent: true }, token);
    await discovery;
    return discovered;
  };
  let activated = false;
  const activation = extension.activateWithApi(vscode, context).then((controller) => {
    activated = true;
    return controller;
  });
  // Flush microtasks, but hold the actual host discovery response unresolved.
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(activated, false, "Activation must not finish while discovery is pending");
  releaseDiscovery();
  const controller = await activation;
  assert.ok(controller);
  assert.deepEqual(discovered.map((model) => model.name), ["OpenCode (configured)"]);
  // extension.js bundles its own Sessions constructor; inspect its public state.
  const backend = context.subscriptions.find((subscription) => subscription.records instanceof Map);
  assert.ok(backend);
  assert.equal(backend.client, undefined);
  assert.equal(backend.records.size, 0);
});

test("activation reports model discovery rejection and disposes the backend without starting ACP", async (t) => {
  const { vscode, context } = api();
  t.after(() => context.subscriptions.forEach((subscription) => subscription.dispose()));
  vscode.workspace.getConfiguration = () => ({ get: (_key, fallback) => fallback });
  const error = new Error("OpenCode catalogue discovery failed");
  let backend;
  let disposed = false;
  vscode.lm.selectChatModels = async () => {
    backend = context.subscriptions.find((subscription) => subscription.records instanceof Map);
    const dispose = backend.dispose.bind(backend);
    t.mock.method(backend, "dispose", () => { disposed = true; return dispose(); });
    throw error;
  };
  const messages = [];
  vscode.window.showErrorMessage = (message) => { messages.push(message); };
  await assert.rejects(extension.activateWithApi(vscode, context), (actual) => actual === error);
  assert.deepEqual(messages, ["[activate] OpenCode catalogue discovery failed"]);
  assert.equal(disposed, true);
  assert.equal(backend.client, undefined);
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

test("boundary excludes malformed seeded metadata without starting ACP", async (t) => {
  const { vscode, context, controller, data } = api();
  const backend = new Sessions({ command: process.execPath, args: [path.join(__dirname, "fixtures/agent.cjs")], cwd: __dirname, permission: async () => "no" });
  t.after(() => backend.dispose());
  const valid = [{ id: "saved-full", cwd: __dirname, label: "Saved", created: 1 }, { id: "saved-optional-absent", cwd: __dirname }];
  const invalid = [
    null, [], "not a record",
    { id: "bad-label", cwd: __dirname, label: 1 },
    { id: "bad-created", cwd: __dirname, created: "1" },
    { id: "null-label", cwd: __dirname, label: null },
    { id: "null-created", cwd: __dirname, created: null },
  ];
  data.set("sessions", [...valid, ...invalid]);
  extension.register(vscode, context, backend);
  await controller.refreshHandler();
  assert.deepEqual([...controller.items.keys()], valid.map((record) => `opencode:/${record.id}`));
  assert.equal(controller.items.get("opencode:/saved-full").label, "Saved");
  assert.equal(controller.items.get("opencode:/saved-full").timing.created, 1);
  assert.equal(controller.items.get("opencode:/saved-optional-absent").label, "OpenCode session");
  for (const record of invalid.filter((value) => value && typeof value.id === "string")) {
    await assert.rejects(vscode.provider.provideChatSessionContent(vscode.Uri.from({ scheme: "opencode", path: `/${record.id}` }), token), /Saved session not found/);
    assert.equal(backend.records.has(record.id), false);
  }
  assert.equal(backend.client, undefined, "Rejected metadata must not start ACP");
});

test("boundary restores valid seeded metadata and loads replayed history", async (t) => {
  const { vscode, context, controller, data } = api();
  const backend = new Sessions({ command: process.execPath, args: [path.join(__dirname, "fixtures/agent.cjs")], cwd: __dirname, permission: async () => "no" });
  t.after(() => backend.dispose());
  const valid = [{ id: "saved-full", cwd: __dirname, label: "Saved", created: 1 }, { id: "saved-optional-absent", cwd: __dirname }];
  data.set("sessions", valid);
  extension.register(vscode, context, backend);
  await controller.refreshHandler();
  assert.deepEqual([...controller.items.keys()], valid.map((record) => `opencode:/${record.id}`));
  assert.equal(controller.items.get("opencode:/saved-full").label, "Saved");
  assert.equal(controller.items.get("opencode:/saved-full").timing.created, 1);
  assert.equal(controller.items.get("opencode:/saved-optional-absent").label, "OpenCode session");
  for (const record of valid) {
    const session = await vscode.provider.provideChatSessionContent(vscode.Uri.from({ scheme: "opencode", path: `/${record.id}` }), token);
    assert.equal(session.history[0].prompt, "previous question");
    assert.equal(session.history[1].response[0].value.value, "previous answer");
    assert.equal(backend.records.get(record.id).cwd, __dirname);
  }
});

for (const stored of [null, { id: "not-an-array", cwd: __dirname }, "not an array"]) {
  test(`boundary ignores non-array persisted metadata: ${JSON.stringify(stored)}`, async (t) => {
    const { vscode, context, controller, data } = api();
    const backend = new Sessions({ command: process.execPath, args: [path.join(__dirname, "fixtures/agent.cjs")], cwd: __dirname, permission: async () => "no" });
    t.after(() => backend.dispose());
    data.set("sessions", stored);
    extension.register(vscode, context, backend);
    await controller.refreshHandler();
    assert.equal(controller.items.size, 0);
    await assert.rejects(vscode.provider.provideChatSessionContent(vscode.Uri.from({ scheme: "opencode", path: "/not-an-array" }), token), /Saved session not found/);
    assert.equal(backend.records.size, 0);
    assert.equal(backend.client, undefined);
  });
}

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

for (const untitled of [false, true]) test(`native editing is rejected without appending an ACP turn (${untitled ? "untitled" : "saved"})`, async (t) => {
  const { vscode, context, controller, participants } = api();
  const backend = new Sessions({ command: process.execPath, args: [path.join(__dirname, "fixtures/agent.cjs")], cwd: __dirname, permission: async () => "no" });
  t.after(() => backend.dispose());
  extension.register(vscode, context, backend);
  const item = untitled ? { resource: vscode.Uri.from({ scheme: "opencode", path: "/untitled-edit" }) }
    : await controller.newChatSessionItemHandler({ request: { prompt: "original" } }, token);
  const handler = participants.get("opencode");
  const chatContext = { history: [], chatSessionContext: { chatSessionItem: item } };
  const text = [];
  const stream = { markdown: (value) => text.push(value.value), push() {} };
  await handler({ id: "original", prompt: "original", attempt: 0 }, chatContext, stream, token);
  assert.deepEqual(text, ["answer:original"]);
  // Editing drops the old turn from native context; ACP cannot replace it.
  await assert.rejects(handler({ id: "edited", prompt: "replacement", attempt: 0 }, chatContext, stream, token), /editing/i);
  assert.deepEqual(text, ["answer:original"], "Rejected edit must not stream a second model answer");
  const record = [...backend.records.values()][0];
  const restored = await vscode.provider.provideChatSessionContent(vscode.Uri.from({ scheme: "opencode", path: `/${record.id}` }), token);
  assert.deepEqual(restored.history.filter((turn) => turn instanceof vscode.ChatRequestTurn2).map((turn) => turn.prompt), ["original"]);
});

for (const untitled of [false, true]) test(`native new Send accepts identical prompt text (${untitled ? "untitled" : "saved"})`, async (t) => {
  const { vscode, context, controller, participants } = api();
  const backend = new Sessions({ command: process.execPath, args: [path.join(__dirname, "fixtures/agent.cjs")], cwd: __dirname, permission: async () => "no" });
  t.after(() => backend.dispose());
  extension.register(vscode, context, backend);
  const item = untitled ? { resource: vscode.Uri.from({ scheme: "opencode", path: "/untitled-identical" }) }
    : await controller.newChatSessionItemHandler({ request: { prompt: "original" } }, token);
  const handler = participants.get("opencode");
  const chatContext = { history: [], chatSessionContext: { chatSessionItem: item } };
  const text = [];
  const stream = { markdown: (value) => text.push(value.value), push() {} };
  await handler({ id: "first", prompt: "original", attempt: 0 }, chatContext, stream, token);
  const record = [...backend.records.values()][0];
  const session = await vscode.provider.provideChatSessionContent(vscode.Uri.from({ scheme: "opencode", path: `/${record.id}` }), token);
  await handler({ id: "next", prompt: "original", attempt: 0 }, { ...chatContext, history: session.history }, stream, token);
  assert.deepEqual(text, ["answer:original", "answer:original"]);
  assert.deepEqual(record.history.filter((turn) => turn.role === "user").map((turn) => turn.text), ["original", "original"]);
});

for (const changedSecond of [false, true]) test(`native edit rejects ${changedSecond ? "changed second turn" : "nonempty shortened history"} after two completed turns`, async (t) => {
  const { vscode, context, controller, participants } = api();
  const backend = new Sessions({ command: process.execPath, args: [path.join(__dirname, "fixtures/agent.cjs")], cwd: __dirname, permission: async () => "no" });
  t.after(() => backend.dispose());
  extension.register(vscode, context, backend);
  const item = await controller.newChatSessionItemHandler({ request: { prompt: "first" } }, token);
  const handler = participants.get("opencode");
  const chatContext = { chatSessionContext: { chatSessionItem: item } };
  const text = [];
  const stream = { markdown: (value) => text.push(value.value), push() {} };
  await handler({ prompt: "first", attempt: 0 }, { ...chatContext, history: [] }, stream, token);
  const first = await vscode.provider.provideChatSessionContent(item.resource, token);
  await handler({ prompt: "second", attempt: 0 }, { ...chatContext, history: first.history }, stream, token);
  const complete = await vscode.provider.provideChatSessionContent(item.resource, token);
  const history = changedSecond ? complete.history.map((turn) => turn instanceof vscode.ChatRequestTurn2 && turn.prompt === "second"
    ? new vscode.ChatRequestTurn2("changed second") : turn) : complete.history.slice(0, 2);
  const record = backend.records.get(item.resource.path.slice(1));
  const before = structuredClone(record.history);
  await assert.rejects(handler({ prompt: "replacement", attempt: 0 }, { ...chatContext, history }, stream, token), /Editing.*disabled/);
  assert.deepEqual(text, ["answer:first", "answer:second"]);
  assert.deepEqual(record.history, before, "Rejected edit must leave every ACP turn unchanged");
});

test("native Retry is rejected before starting ACP or creating an untitled session", async (t) => {
  const { vscode, context, participants } = api();
  const backend = new Sessions({ command: process.execPath, args: [path.join(__dirname, "fixtures/agent.cjs")], cwd: __dirname, permission: async () => "no" });
  t.after(() => backend.dispose());
  extension.register(vscode, context, backend);
  await assert.rejects(participants.get("opencode")({ prompt: "repeat", attempt: 1 }, {
    history: [], chatSessionContext: { chatSessionItem: { resource: vscode.Uri.from({ scheme: "opencode", path: "/untitled-retry" }) } },
  }, { markdown() {}, push() {} }, token), /Retry is disabled/i);
  assert.equal(backend.client, undefined);
  assert.equal(backend.records.size, 0);
});

for (const scenario of ["empty", "changed", "missing"]) test(`content handler rejects ${scenario} replayed request history`, async (t) => {
  const { vscode, context, data } = api();
  data.set("sessions", [{ id: "saved-edit", cwd: __dirname }]);
  const backend = new Sessions({ command: process.execPath, args: [path.join(__dirname, "fixtures/agent.cjs")], cwd: __dirname, permission: async () => "no" });
  t.after(() => backend.dispose());
  extension.register(vscode, context, backend);
  const resource = vscode.Uri.from({ scheme: "opencode", path: "/saved-edit" });
  const session = await vscode.provider.provideChatSessionContent(resource, token);
  const text = [];
  const stream = { markdown: (value) => text.push(value.value), push() {} };
  const history = scenario === "empty" ? [] : scenario === "changed" ? [new vscode.ChatRequestTurn2("changed earlier question")] : undefined;
  await assert.rejects(session.requestHandler({ prompt: "replacement", attempt: 0 }, { history }, stream, token), /Editing.*disabled/);
  assert.deepEqual(text, []);
  assert.deepEqual(backend.records.get("saved-edit").history.filter((turn) => turn.role === "user").map((turn) => turn.text), ["previous question"]);
});

test("content handler accepts an ordinary next Send after ACP history replay", async (t) => {
  const { vscode, context, data } = api();
  data.set("sessions", [{ id: "saved-next", cwd: __dirname }]);
  const backend = new Sessions({ command: process.execPath, args: [path.join(__dirname, "fixtures/agent.cjs")], cwd: __dirname, permission: async () => "no" });
  t.after(() => backend.dispose());
  extension.register(vscode, context, backend);
  const session = await vscode.provider.provideChatSessionContent(vscode.Uri.from({ scheme: "opencode", path: "/saved-next" }), token);
  const text = [];
  const stream = { markdown: (value) => text.push(value.value), push() {} };
  await session.requestHandler({ prompt: "next", attempt: 0 }, { history: session.history }, stream, token);
  assert.deepEqual(text, ["answer:next"]);
  assert.deepEqual(backend.records.get("saved-next").history.filter((turn) => turn.role === "user").map((turn) => turn.text), ["previous question", "next"]);
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

test("SDK update projection preserves tool content rendering and null partial fallbacks", (t) => {
  const { vscode } = api();
  const backend = new Sessions({ command: process.execPath, permission: async () => "no" });
  t.after(() => backend.dispose());
  const tools = new Map();
  const parts = [];
  const record = { id: "tool-content", cwd: __dirname, history: [], turn: { controller: new AbortController(), onUpdate: (update) => parts.push(extension.renderUpdate(vscode, update, tools)) } };
  backend.records.set(record.id, record);
  const content = [
    { type: "content", _meta: { wrapper: [1, null, { detail: "text" }] }, content: { type: "text", text: "tool text", annotations: { audience: ["user", "assistant"], lastModified: "2026-10-03T00:00:00Z", priority: 0.5, _meta: { note: "visible" } }, _meta: { text: true } } },
    { type: "content", content: { type: "image", data: "image-data", mimeType: "image/png", uri: "file:///image", annotations: { audience: null, lastModified: null, priority: null, _meta: null }, _meta: null } },
    { type: "content", content: { type: "image", data: "image-data", mimeType: "image/png", uri: null } },
    { type: "content", content: { type: "audio", data: "audio-data", mimeType: "audio/wav", annotations: null, _meta: { audio: "details" } } },
    { type: "content", content: { type: "resource_link", uri: "file:///tool", name: "tool", title: "Tool report", description: "Result details", mimeType: "text/plain", size: 10, annotations: { priority: 0 }, _meta: { link: "details" } } },
    { type: "content", _meta: null, content: { type: "resource_link", uri: "file:///null", name: "null", title: null, description: null, mimeType: null, size: null } },
    { type: "content", content: { type: "resource", resource: { uri: "file:///text", text: "embedded text", mimeType: "text/plain", _meta: { embedded: [false, 2] } }, annotations: { audience: [] }, _meta: { resource: "text" } } },
    { type: "content", content: { type: "resource", resource: { uri: "file:///blob", blob: "blob-data", mimeType: null, _meta: null }, annotations: null, _meta: null } },
    { type: "diff", path: "/tool", oldText: null, newText: "diff text", _meta: { diff: "details" } },
    { type: "terminal", terminalId: "terminal", _meta: { terminal: "details" } },
    { type: "diff", path: "/new", newText: "new file", _meta: null },
    { type: "terminal", terminalId: "null-terminal", _meta: null },
  ];
  backend.update({ sessionId: record.id, update: { sessionUpdate: "tool_call", toolCallId: "tool", name: "bash", title: "Run command", status: "in_progress", rawInput: "input", content } });
  backend.update({ sessionId: record.id, update: { sessionUpdate: "tool_call_update", toolCallId: "tool", name: null, title: null, status: "completed", rawInput: null, content: null } });
  assert.equal(parts.length, 2);
  for (const part of parts) {
    assert.equal(part.toolName, "bash");
    assert.equal(part.invocationMessage, "Run command");
    assert.equal(part.toolSpecificData.input, "input");
    assert.deepEqual(JSON.parse(part.toolSpecificData.output), content);
  }
  assert.equal(parts[1].enablePartialUpdate, true);
  assert.equal(parts[1].isComplete, true);
  assert.deepEqual(record.history[0].updates[0].content, content);
  assert.equal("rawOutput" in record.history[0].updates[0], false);
  const historyTools = new Map();
  for (const update of record.history[0].updates) {
    assert.deepEqual(JSON.parse(extension.renderUpdate(vscode, update, historyTools).toolSpecificData.output), content);
  }
});

test("SDK tool content projection omits malformed optional fields without accepting malformed required fields", (t) => {
  const { vscode } = api();
  const backend = new Sessions({ command: process.execPath, permission: async () => "no" });
  t.after(() => backend.dispose());
  const record = { id: "invalid-content", cwd: __dirname, history: [] };
  backend.records.set(record.id, record);
  backend.update({ sessionId: record.id, update: { sessionUpdate: "tool_call", toolCallId: "tool", title: "Tool", content: [
    { type: "content", _meta: [], content: { type: "image", data: "data", mimeType: "image/png", uri: 42, annotations: { audience: ["system"], lastModified: "2026-10-03T00:00:00Z", priority: "high", _meta: [] }, _meta: "bad" } },
    { type: "content", content: { type: "resource_link", uri: "file:///tool", name: "tool", title: [], description: 42, mimeType: false, size: 1.5, annotations: [], _meta: false } },
    { type: "content", content: { type: "text", text: 42, _meta: { valid: true } } },
    { type: "content", content: { type: "image", data: 42, mimeType: "image/png", uri: "file:///image" } },
    { type: "content", content: { type: "resource_link", uri: "file:///tool", name: 42, title: "Valid title" } },
    { type: "content", content: { type: "resource", resource: { uri: 42, text: "text", _meta: {} } } },
    { type: "diff", path: "/file", newText: 42, _meta: {} },
    { type: "terminal", terminalId: 42, _meta: {} },
  ] } });
  const part = extension.renderUpdate(vscode, record.history[0].updates[0], new Map());
  assert.deepEqual(JSON.parse(part.toolSpecificData.output), [
    { type: "content", content: { type: "image", data: "data", mimeType: "image/png", annotations: { lastModified: "2026-10-03T00:00:00Z" } } },
    { type: "content", content: { type: "resource_link", uri: "file:///tool", name: "tool" } },
  ]);
});

test("SDK tool content rendering retains optional fields from independent session/load replay", async (t) => {
  const { vscode, context, data } = api();
  const backend = new Sessions({ command: process.execPath, args: [path.join(__dirname, "fixtures/agent.cjs"), "tool-content-replay"], cwd: __dirname, permission: async () => "no" });
  t.after(() => backend.dispose());
  data.set("sessions", [{ id: "saved-tool-content", cwd: __dirname }]);
  extension.register(vscode, context, backend);
  assert.equal(backend.records.size, 0, "Replay must come from session/load, not seeded application history");
  const session = await vscode.provider.provideChatSessionContent(vscode.Uri.from({ scheme: "opencode", path: "/saved-tool-content" }), token);
  const expected = [
    { type: "content", _meta: { wrapper: "replayed" }, content: { type: "image", data: "replayed-image", mimeType: "image/png", uri: "file:///replayed-image", annotations: { audience: ["user"], priority: 0.75 }, _meta: { source: "history" } } },
    { type: "content", content: { type: "resource_link", uri: "file:///report", name: "report", title: "Validation result", description: "2 tests failed", mimeType: "text/plain", size: 10, annotations: null, _meta: null } },
  ];
  const tool = session.history[1].response.find((part) => part instanceof vscode.ChatToolInvocationPart);
  assert.ok(tool);
  assert.deepEqual(JSON.parse(tool.toolSpecificData.output), expected);
  const update = backend.records.get("saved-tool-content").history[1].updates.at(-1);
  assert.equal("rawOutput" in update, false);
  assert.deepEqual(update.content, expected);
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

test("boundary does not render non-string text but renders a valid positive control", () => {
  const { vscode } = api();
  for (const sessionUpdate of ["agent_message_chunk", "agent_thought_chunk"]) {
    assert.equal(extension.renderUpdate(vscode, { sessionUpdate, content: { type: "text", text: 1 } }, new Map()), undefined);
    const part = extension.renderUpdate(vscode, { sessionUpdate, content: { type: "text", text: "valid control" } }, new Map());
    assert.equal(sessionUpdate === "agent_message_chunk" ? part.value.value : part.value, "valid control");
  }
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

test("smoke entry point uses VS Code API when editor supplies test path and callback", async (t) => {
  const Module = require("node:module");
  const load = Module._load;
  const invoked = [];
  // Only VS Code's host-provided module is unavailable in the Node runner.
  const vscode = {
    workspace: { isTrusted: true },
    extensions: { getExtension: () => ({ activate: async () => ({ id: "opencode" }) }) },
    commands: {
      getCommands: async () => ["workbench.action.chat.openNewChatSessionInPlace.opencode"],
      executeCommand: async (command) => { invoked.push(command); },
    },
  };
  t.mock.method(Module, "_load", function (id, ...args) {
    return id === "vscode" ? vscode : Reflect.apply(load, this, [id, ...args]);
  });
  await runEditorSmoke(path.join(__dirname, "editor-smoke.cjs"), () => {});
  assert.deepEqual(invoked, ["opencode.newSession"]);
});
