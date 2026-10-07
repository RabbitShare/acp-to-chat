"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
require("./template-files.cjs").isolateTemplateFiles();
const { Sessions } = require("../dist/sessions");
const extension = require("../dist/extension");
const { run: runEditorSmoke, waitForWorkspaceTrust } = require("./editor-smoke.cjs");

// Never inspect the developer's global configuration in fixture tests.
process.env.OPENCODE_CONFIG_DIR = path.join(__dirname, "fixtures/template-config");
delete process.env.OPENCODE_CONFIG;
delete process.env.OPENCODE_CONFIG_CONTENT;

function api() {
  class Uri {
    constructor(value) { Object.assign(this, value); }
    static from(value) { return new Uri(value); }
    toString() { return `${this.scheme}:${this.authority ? `//${this.authority}` : ""}${this.path}${this.query ? `?${this.query}` : ""}${this.fragment ? `#${this.fragment}` : ""}`; }
  }
  class MarkdownString { constructor(value) { this.value = value; } }
  class Part { constructor(value) { this.value = value; } }
  class Tool { constructor(toolName, toolCallId) { Object.assign(this, { toolName, toolCallId }); } }
  class Request { constructor(prompt, command, references = []) { Object.assign(this, { prompt, command, references }); } }
  class Response { constructor(response) { this.response = response; } }
  const dispose = () => {};
  const participants = new Map();
  const modelProviders = new Map();
  const commands = new Map();
  const fileSystems = new Map();
  const states = new Set();
  const editorOptions = new Map();
  const echoes = [];
  let catalogue = [];
  const event = () => {
    const listeners = new Set();
    return { listeners, subscribe: (listener) => { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; }, fire: () => [...listeners].forEach((listener) => listener()) };
  };
  // 1.140.0 broadcasts quiet selection changes to every managed state, with no resource payload.
  const broadcast = (updates) => {
    for (const state of states) {
      state.quiet(state.groups.map((group) => {
        const value = updates[group.id];
        const selected = value && group.items.find((item) => item.id === (typeof value === "string" ? value : value.id));
        return selected ? { ...group, selected } : group;
      }));
      state.change.fire();
    }
  };
  const controller = {
    items: new Map(),
    dispose: () => [...states].forEach((state) => state.dispose()),
    createChatSessionItem: (resource, label) => ({ resource, label }),
    createChatSessionInputState: (groups) => {
      const change = event();
      const disposal = event();
      let current = groups;
      const state = {
        change, disposal, onDidChange: change.subscribe, onDidDispose: disposal.subscribe,
        get groups() { return current; },
        set groups(value) {
          assert.ok(states.has(state), "Never mutate a disposed input state");
          current = value;
          catalogue = value;
          const resource = state.sessionResource ?? state.untitledSessionResource;
          const own = resource && editorOptions.get(resource.toString());
          // Saved initial content has no registered session cache until the provider returns.
          if (own) {
            for (const group of value) {
              if (!group.selected || own[group.id] === group.selected) continue;
              own[group.id] = group.selected;
              // _applyOptionGroups uses separate setSessionOption calls, not one atomic update.
              echoes.push({ [group.id]: group.selected });
            }
          }
        },
        quiet: (value) => { current = value; },
        dispose: () => { disposal.fire(); states.delete(state); change.listeners.clear(); disposal.listeners.clear(); },
      };
      states.add(state);
      return state;
    },
  };
  const vscode = {
    Uri, MarkdownString,
    FileType: { File: 1, Directory: 2 },
    FileSystemError: { FileNotFound: () => new Error("FileNotFound"), NoPermissions: () => new Error("NoPermissions") },
    ChatSessionCustomizationType: { Prompt: { id: "prompt" } },
    EventEmitter: class {
      constructor() { this.listeners = new Set(); this.event = (listener) => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; }; }
      fire(value) { this.listeners.forEach((listener) => listener(value)); }
      dispose() { this.listeners.clear(); }
    },
    ChatResponseMarkdownPart: Part, ChatResponseThinkingProgressPart: Part,
    ChatToolInvocationPart: Tool, ChatRequestTurn2: Request, ChatResponseTurn2: Response,
    ChatSessionStatus: { InProgress: 2, Completed: 1, NeedsInput: 3, Failed: 0 },
    workspace: { isTrusted: true, workspaceFolders: [{ uri: { scheme: "file", fsPath: __dirname } }],
      getConfiguration: () => ({ get: (_key, fallback) => fallback }),
      registerFileSystemProvider: (scheme, provider, options) => {
        fileSystems.set(scheme, { provider, options });
        return { dispose: () => fileSystems.delete(scheme) };
      } },
    window: { createOutputChannel: () => ({ append: () => {}, dispose }), showErrorMessage: () => {} },
    CancellationTokenSource: class {
      constructor() { this.token = token; }
      dispose() { this.disposed = true; }
    },
    commands: { registerCommand: (id, handler) => { commands.set(id, handler); return { dispose }; }, executeCommand: async () => {} },
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
      registerChatSessionCustomizationProvider: (id, metadata, provider) => {
        vscode.customizations = { id, metadata, provider };
        return { dispose: () => { vscode.customizations = undefined; } };
      },
    },
  };
  controller.items.add = (item) => controller.items.set(item.resource.toString(), item);
  controller.items.replace = (items) => { controller.items.clear(); items.forEach(controller.items.add); };
  const data = new Map();
  const context = { subscriptions: [], workspaceState: { get: (key, fallback) => data.has(key) ? data.get(key) : fallback, update: async (key, value) => data.set(key, value) } };
  const host = {
    states, editorOptions, broadcast,
    get catalogue() { return catalogue; },
    async input(resource) {
      assert.equal(typeof controller.getChatSessionInputState, "function", "Adapter must provide managed native inline input states");
      return controller.getChatSessionInputState(resource, { previousInputState: undefined }, token);
    },
    async injectInput(resource) {
      const state = await this.input(resource);
      state.sessionResource = resource;
      return state;
    },
    async open(resource) {
      const untitled = resource.path.startsWith("/untitled-");
      const state = await this.input(untitled ? undefined : resource);
      // Native 1.140.0 creates the replacement before disposing old resource states:
      // https://github.com/microsoft/vscode/blob/1.140.0/src/vs/workbench/api/common/extHostChatSessions.ts#L654-L683
      for (const previous of states) {
        const previousResource = previous.sessionResource ?? previous.untitledSessionResource;
        if (previousResource?.toString() === resource.toString()) previous.dispose();
      }
      if (untitled) state.untitledSessionResource = resource;
      else state.sessionResource = resource;
      const session = await vscode.provider.provideChatSessionContent(resource, token, { inputState: state });
      editorOptions.set(resource.toString(), { ...session.options });
      return { state, session };
    },
    select(resource, group, value) {
      const updates = { [group.id]: value };
      Object.assign(editorOptions.get(resource.toString()), updates);
      broadcast(updates);
    },
    flush() {
      const pending = echoes.splice(0);
      pending.forEach(broadcast);
      assert.equal(echoes.length, 0, "Programmatic host echoes must not cause publication loops");
    },
    visible(resource) {
      const options = editorOptions.get(resource.toString()) ?? {};
      return catalogue.filter((group) => {
        if (group.when === "false") return false;
        const match = /^chatSessionOption\.(\w+) == '(\w+)'$/.exec(group.when ?? "");
        return match && options[match[1]]?.id === match[2] && options[group.id] && group.items.length;
      });
    },
  };
  return { vscode, context, controller, data, participants, modelProviders, commands, fileSystems, host };
}

const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };

function configured(t, scenario = "config", permission = async () => "no", roots = [__dirname]) {
  const editor = api();
  editor.vscode.workspace.workspaceFolders = roots.map((fsPath) => ({ uri: { scheme: "file", fsPath } }));
  const backend = new Sessions({ command: process.execPath, args: [path.join(__dirname, "fixtures/agent.cjs"), scenario], cwd: __dirname, permission });
  const errors = [];
  editor.vscode.window.showErrorMessage = (message) => { errors.push(message); };
  t.after(() => editor.context.subscriptions.forEach((subscription) => subscription.dispose()));
  extension.register(editor.vscode, editor.context, backend);
  return { ...editor, backend, errors };
}

async function emptySession(editor) {
  const item = await editor.controller.newChatSessionItemHandler({ request: { prompt: "" } }, token);
  return { item, record: editor.backend.records.get(item.resource.path.slice(1)), ...await editor.host.open(item.resource) };
}

async function traffic(backend, method) {
  return (await backend.client.requestExtension("echo", { control: "stats" })).traffic.filter((entry) => entry.method === method);
}

function localTemplate(t, template) {
  const directory = fs.mkdtempSync(path.join(__dirname, ".local-template-"));
  const previous = process.env.OPENCODE_CONFIG_DIR;
  process.env.OPENCODE_CONFIG_DIR = directory;
  fs.mkdirSync(path.join(directory, "commands"));
  const file = path.join(directory, "commands/review-test.md");
  fs.writeFileSync(file, template);
  t.after(() => { process.env.OPENCODE_CONFIG_DIR = previous; fs.rmSync(directory, { recursive: true, force: true }); });
  return file;
}

test("local slash Send streams expanded text and preserves original native history for the next Send", async (t) => {
  const file = localTemplate(t, "---\ndescription: Brief answer\n---\nAnswer briefly:\n$ARGUMENTS");
  const editor = configured(t, "commands");
  const { item, session, record } = await emptySession(editor);
  const [_, command] = await editor.vscode.customizations.provider.provideChatSessionCustomizations(item.resource, token);
  const output = [];
  const chatContext = { history: [], chatSessionContext: { chatSessionItem: item } };
  const stream = { markdown: (value) => output.push(value.value), push() {} };
  await session.requestHandler({ prompt: "/review-test question", references: [{ value: command.uri }], attempt: 0 }, chatContext, stream, token);
  assert.deepEqual(output, ["answer:Answer briefly:\nquestion"]);
  assert.equal(record.history[0].text, "Answer briefly:\nquestion");
  const restored = await editor.vscode.provider.provideChatSessionContent(item.resource, token);
  assert.equal(restored.history[0].prompt, "/review-test question");
  chatContext.history = [new editor.vscode.ChatRequestTurn2("/review-test question")];
  fs.writeFileSync(file, "Changed template $ARGUMENTS");
  await session.requestHandler({ prompt: "next", attempt: 0 }, chatContext, stream, token);
  assert.deepEqual((await traffic(editor.backend, "session/prompt")).map((entry) => entry.params.prompt[0].text), ["Answer briefly:\nquestion", "next"]);
});

test("local slash native/wire mapping never enters workspace storage", async (t) => {
  localTemplate(t, 'Review $ARGUMENTS');
  const editor = configured(t, "commands");
  const { session } = await emptySession(editor);
  await session.requestHandler({ prompt: '/review-test question', attempt: 0 }, { history: [] }, { markdown() {}, push() {} }, token);
  assert.deepEqual(Object.keys(editor.data.get("sessions")[0]).sort(), ["created", "cwd", "id", "label"]);
});

test("local slash fresh load uses expanded backend history without re-expanding templates or enabling edits", async (t) => {
  const file = localTemplate(t, "Original $ARGUMENTS");
  const editor = configured(t, "commands-template-replay");
  const { item, session, record } = await emptySession(editor);
  await session.requestHandler({ prompt: "/review-test question", attempt: 0 }, { history: [] }, { markdown() {}, push() {} }, token);
  fs.unlinkSync(file);
  record.configValid = false;
  const restored = await editor.vscode.provider.provideChatSessionContent(item.resource, token);
  assert.equal(restored.history[0].prompt, "Original question");
  assert.equal(record.history[0].nativeText, undefined, "The raw invocation mapping is memory-only and is discarded on fresh load");
  await restored.requestHandler({ prompt: "next", attempt: 0 }, { history: restored.history }, { markdown() {}, push() {} }, token);
  await assert.rejects(restored.requestHandler({ prompt: "replacement", attempt: 0 }, { history: [new editor.vscode.ChatRequestTurn2("/review-test question")] }, { markdown() {}, push() {} }, token), /Editing.*disabled/);
  assert.deepEqual((await traffic(editor.backend, "session/prompt")).map((entry) => entry.params.prompt[0].text), ["Original question", "next"]);
});

test("local slash Send rereads templates after config waits", async (t) => {
  const file = localTemplate(t, "Old $ARGUMENTS");
  const editor = configured(t, "config-delayed");
  const { item, session, record } = await emptySession(editor);
  await editor.backend.client.requestExtension("echo", { control: "update-commands", sessionId: record.id, availableCommands: [{ name: "review-test", description: "Review" }] });
  const barrier = configBarrier(t, editor.backend.client);
  const setter = editor.backend.setConfigOption(record, "mode", "custom-agent", record.configRevision);
  await barrier;
  const send = session.requestHandler({ prompt: "/review-test question", attempt: 0 }, { history: [], chatSessionContext: { chatSessionItem: item } }, { markdown() {}, push() {} }, token);
  await editor.backend.client.requestExtension("echo", { control: "stats" });
  fs.writeFileSync(file, "Fresh $ARGUMENTS");
  await editor.backend.client.requestExtension("echo", { control: "release-config" });
  await setter;
  await send;
  assert.equal((await traffic(editor.backend, "session/prompt"))[0].params.prompt[0].text, "Fresh question");
});

test("local slash removed commands fail without history or ACP prompt", async (t) => {
  localTemplate(t, "Review $ARGUMENTS");
  const editor = configured(t, "commands");
  const { session, record } = await emptySession(editor);
  await editor.backend.client.requestExtension("echo", { control: "update-commands", sessionId: record.id, availableCommands: [] });
  await assert.rejects(session.requestHandler({ prompt: "/review-test question", attempt: 0 }, { history: [] }, { markdown() {}, push() {} }, token), /not advertised/);
  assert.equal((await traffic(editor.backend, "session/prompt")).length, 0);
  assert.deepEqual(record.history, []);
});

test("local slash missing or unsupported definitions fail before history or ACP prompt", async (t) => {
  const file = localTemplate(t, "---\nagent: plan\n---\nPRIVATE TEMPLATE");
  const editor = configured(t, "commands");
  const { session, record } = await emptySession(editor);
  const send = () => session.requestHandler({ prompt: "/review-test PRIVATE ARGUMENT", attempt: 0 }, { history: [] }, { markdown() {}, push() {} }, token);
  await assert.rejects(send(), (error) => /Unsupported/.test(error.message) && !error.message.includes("PRIVATE"));
  fs.unlinkSync(file);
  await assert.rejects(send(), /No local template/);
  assert.deepEqual(record.history, []);
  assert.equal(record.turn, undefined);
  assert.equal((await traffic(editor.backend, "session/prompt")).length, 0);
});

test("local slash rejects oversized expansion before history or ACP prompt", async (t) => {
  localTemplate(t, 'Review ' + '$ARGUMENTS'.repeat(100));
  const editor = configured(t, "commands");
  const { session, record } = await emptySession(editor);
  await assert.rejects(session.requestHandler({ prompt: '/review-test ' + 'x'.repeat(4096), attempt: 0 }, { history: [] }, { markdown() {}, push() {} }, token), /Expanded template exceeds.*limit/);
  assert.deepEqual(record.history, []);
  assert.equal(record.turn, undefined);
  assert.equal((await traffic(editor.backend, "session/prompt")).length, 0);
});

test("local slash final advertised check rejects revocation during template reading without references", { timeout: 5000 }, async (t) => {
  const file = localTemplate(t, "Review $ARGUMENTS");
  const editor = configured(t, "commands");
  const { session, record } = await emptySession(editor);
  const promises = require("node:fs/promises");
  const open = promises.open;
  let entered, release;
  const ready = new Promise((resolve) => { entered = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  promises.open = async (source, ...args) => {
    if (path.resolve(String(source)) === file) { entered(); await held; }
    return open(source, ...args);
  };
  t.after(() => { release(); promises.open = open; });
  const send = session.requestHandler({ prompt: "/review-test question", references: [], attempt: 0 }, { history: [] }, { markdown() {}, push() {} }, token);
  const rejection = assert.rejects(send, /not advertised/);
  await ready;
  await editor.backend.client.requestExtension("echo", { control: "update-commands", sessionId: record.id, availableCommands: [] });
  release();
  await rejection;
  assert.deepEqual(record.history, []);
  assert.equal(record.turn, undefined);
  assert.equal((await traffic(editor.backend, "session/prompt")).length, 0);
});

test("local slash adapter uses each session cwd for relative fallback templates instead of process or focused workspace", async (t) => {
  const globalFile = localTemplate(t, "unused");
  fs.unlinkSync(globalFile);
  const root = path.dirname(path.dirname(globalFile));
  const directories = ['A', 'B'].map((name) => path.join(root, name));
  for (const [index, cwd] of directories.entries()) {
    fs.mkdirSync(path.join(cwd, 'team-prompts'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'team-prompts/review-test.md'), `Review ${index === 0 ? 'A' : 'B'} $ARGUMENTS`);
  }
  const editor = configured(t, "commands", undefined, directories);
  editor.vscode.window.showWorkspaceFolderPick = async () => editor.vscode.workspace.workspaceFolders[0];
  const a = await emptySession(editor);
  editor.vscode.window.showWorkspaceFolderPick = async () => editor.vscode.workspace.workspaceFolders[1];
  const b = await emptySession(editor);
  for (const { record } of [a, b]) await editor.backend.client.requestExtension("echo", { control: "update-commands", sessionId: record.id, availableCommands: [{ name: "review-test", description: "Review" }] });
  assert.notEqual(editor.backend.options.cwd, a.record.cwd);
  assert.notEqual(editor.backend.options.cwd, b.record.cwd);
  const scopes = [];
  editor.vscode.workspace.getConfiguration = (_section, resource) => {
    scopes.push(resource.path);
    return { get: (key, fallback) => key === 'commandTemplateDirectories' ? ['team-prompts'] : fallback };
  };
  editor.vscode.workspace.workspaceFolders.reverse();
  for (const { item, session } of [a, b]) await session.requestHandler({ prompt: '/review-test file', attempt: 0 }, { history: [], chatSessionContext: { chatSessionItem: item } }, { markdown() {}, push() {} }, token);
  assert.deepEqual(scopes, directories);
  assert.deepEqual((await traffic(editor.backend, "session/prompt")).map((entry) => [entry.params.sessionId, entry.params.prompt[0].text]), [[a.record.id, 'Review A file'], [b.record.id, 'Review B file']]);
});

function picker(state, name) { return state.groups.find((group) => group.name === name && group.selected); }

async function settled(record) {
  await record.configPending?.catch(() => {});
  await Promise.resolve();
}

function configBarrier(t, connection) {
  return new Promise((resolve) => {
    const listener = (method, params) => {
      if (method !== "session/update" || params._meta?.fixture !== "config_pending") return;
      connection.off("notification", listener);
      resolve();
    };
    connection.on("notification", listener);
    t.after(() => connection.off("notification", listener));
  });
}

async function updateGroupedCatalog(editor, record) {
  const options = structuredClone(record.configOptions);
  options[0].options = [{ group: "provider/custom", name: "Provider", options: options[0].options.map((item) => ({ ...item, _meta: { tooltip: "[run](command:evil)" }, modelMetadata: { vendor: "fake" } })) }];
  options[0].options[0].options[1].name = "$(zap) [run](command:evil) <img>";
  options[0].options[0].options[1].description = "[detail](command:evil)";
  await editor.backend.client.requestExtension("echo", { control: "update-config", sessionId: record.id, configOptions: options });
}

test("inline activation and generic drafts remain lazy and cannot expose REAL selectors", async (t) => {
  const editor = configured(t);
  const draft = await editor.host.input(undefined);
  assert.equal(editor.backend.client, undefined);
  assert.equal(draft.groups.length, 1);
  assert.equal(draft.groups[0].when, "false");
  assert.equal(draft.groups[0].selected.locked, true);
  const real = await emptySession(editor);
  const draft2 = await editor.host.input(undefined);
  assert.ok(draft2.groups.filter((group) => group.when !== "false").every((group) => group.selected === undefined));
  editor.host.broadcast(Object.fromEntries(real.state.groups.filter((group) => group.selected).map((group) => [group.id, group.selected])));
  assert.equal((await traffic(editor.backend, "session/set_config_option")).length, 0);
  assert.deepEqual(real.record.history, []);
  assert.equal(draft2.groups.find((group) => group.when === "false").selected.id, draft.groups[0].selected.id);
});

test("inline eager New saves one empty ACP session then moves its REAL native chat to sidebar", async (t) => {
  const editor = configured(t);
  const opened = [];
  const sources = [];
  const Source = editor.vscode.CancellationTokenSource;
  editor.vscode.CancellationTokenSource = class extends Source { constructor() { super(); sources.push(this); } };
  editor.vscode.commands.executeCommand = async (command, resource, options) => {
    assert.equal(editor.data.get("sessions")?.length, 1, "Persist before opening chat");
    opened.push({ command, resource, options });
    if (command === "vscode.open") return editor.host.open(resource);
    assert.equal(command, "workbench.action.chat.openInSidebar");
    assert.equal(resource, undefined, "Native move command uses the editor just opened, not a new draft URI");
    assert.equal(options, undefined);
    assert.deepEqual(editor.host.visible(opened[0].resource).map((group) => group.name), ["Model", "Agent", "Reasoning"]);
  };
  await editor.commands.get("opencode.newSession")();
  assert.equal(opened.length, 2, "New must not leave the session in a Chat editor");
  assert.equal(opened[0].command, "vscode.open");
  assert.equal(opened[1].command, "workbench.action.chat.openInSidebar");
  assert.equal(opened[0].resource.toString(), "opencode:/session-1");
  assert.deepEqual(opened[0].options, { preview: false });
  const record = editor.backend.records.get("session-1");
  assert.deepEqual(record.history, []);
  assert.equal((await traffic(editor.backend, "session/new")).length, 1);
  assert.equal((await traffic(editor.backend, "session/load")).length, 0);
  assert.equal((await traffic(editor.backend, "session/prompt")).length, 0);
  assert.deepEqual(editor.host.visible(opened[0].resource).map((group) => group.name), ["Model", "Agent", "Reasoning"]);
  assert.deepEqual(Object.keys(editor.data.get("sessions")[0]).sort(), ["created", "cwd", "id", "label"]);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].disposed, true);
});

test("inline eager New cwd cancellation creates nothing", async (t) => {
  const editor = configured(t, "config", undefined, [__dirname, path.join(__dirname, "fixtures")]);
  let choices = 0;
  editor.vscode.window.showWorkspaceFolderPick = async () => { choices++; return undefined; };
  await assert.rejects(editor.commands.get("opencode.newSession")(), /selection cancelled/);
  assert.equal(choices, 1);
  assert.equal(editor.backend.client, undefined);
  assert.equal(editor.backend.records.size, 0);
  assert.equal(editor.data.has("sessions"), false);
});

test("inline eager New uses one multi-root cwd choice", async (t) => {
  const editor = configured(t, "config", undefined, [__dirname, path.join(__dirname, "fixtures")]);
  const { backend } = editor;
  const second = editor.vscode.workspace.workspaceFolders[1];
  let choices = 0;
  editor.vscode.window.showWorkspaceFolderPick = async () => { choices++; return second; };
  editor.vscode.commands.executeCommand = async (command, resource) => {
    if (command === "vscode.open") await editor.host.open(resource);
    else assert.equal(command, "workbench.action.chat.openInSidebar");
  };
  await editor.commands.get("opencode.newSession")();
  assert.equal(choices, 1);
  assert.equal(backend.records.get("session-1").cwd, second.uri.fsPath);
  assert.equal((await traffic(backend, "session/new")).length, 1);
});

test("plus manifest action precedes native New Chat only in trusted OpenCode workspaces", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../package.json"), "utf8"));
  // 1.140.0 ChatNewMenu is a split button whose primary action is the first menu entry.
  // Native New Chat occupies group 1_open, order 1. This checks our contribution boundary, not rendering.
  const action = manifest.contributes.menus?.["chat/newSession"]?.find((item) => item.command === "opencode.newSession");
  assert.ok(action, "The upper plus must not create a selector-less generic draft");
  const [group, order] = action.group.split("@");
  assert.equal(group, "1_open");
  assert.ok(Number(order) < 1, "OpenCode must precede native New Chat without relying on title tie-breaking");
  assert.equal(manifest.contributes.commands.find((item) => item.command === action.command)?.icon, "$(plus)");
  const available = (context) => action.when.split(" && ").every((term) => {
    if (term === "isWorkspaceTrusted") return context.trusted;
    if (term === "workspaceFolderCount > 0") return context.folders > 0;
    if (term === "chatSessionType == opencode") return context.type === "opencode";
    assert.fail(`Unexpected menu condition: ${term}`);
  });
  assert.equal(available({ trusted: true, folders: 1, type: "opencode" }), true);
  assert.equal(available({ trusted: true, folders: 1, type: "local" }), false);
  assert.equal(available({ trusted: false, folders: 1, type: "opencode" }), false);
  assert.equal(available({ trusted: true, folders: 0, type: "opencode" }), false);
});

test("plus contributed command opens one empty sidebar session with inline selectors before Send", async (t) => {
  const editor = configured(t);
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../package.json"), "utf8"));
  const action = manifest.contributes.menus?.["chat/newSession"]?.find((item) => item.command === "opencode.newSession");
  assert.ok(action);
  const routes = [];
  editor.vscode.commands.executeCommand = async (id, resource) => {
    routes.push(id);
    if (id === "vscode.open") await editor.host.open(resource);
  };
  await editor.commands.get(action.command)();
  assert.deepEqual(routes, ["vscode.open", "workbench.action.chat.openInSidebar"]);
  assert.deepEqual(editor.host.visible(editor.controller.items.get("opencode:/session-1").resource).map((group) => group.name), ["Model", "Agent", "Reasoning"]);
  assert.equal((await traffic(editor.backend, "session/new")).length, 1);
  assert.equal((await traffic(editor.backend, "session/prompt")).length, 0);
});

test("inline union isolates two REAL cwd catalogs and resource-owned options under broadcasts", async (t) => {
  const editor = configured(t, "config", undefined, [__dirname, path.join(__dirname, "fixtures")]);
  editor.vscode.window.showWorkspaceFolderPick = async () => editor.vscode.workspace.workspaceFolders[0];
  const a = await emptySession(editor);
  // Another cwd uses the same literal agent/effort IDs, but distinct model catalog.
  editor.vscode.window.showWorkspaceFolderPick = async () => editor.vscode.workspace.workspaceFolders[1];
  const b = await emptySession(editor);
  const aGroups = editor.host.visible(a.item.resource);
  const bGroups = editor.host.visible(b.item.resource);
  assert.equal(aGroups.length, 3);
  assert.equal(bGroups.length, 3);
  assert.equal(picker(b.state, "Model").selected.name, "Initial");
  assert.equal(b.record.configOptions[0].currentValue, "provider/fixtures/initial");
  assert.ok(aGroups.every((group) => !bGroups.some((other) => other.id === group.id)));
  assert.equal(Object.keys(a.session.options).length, 4);
  assert.ok(bGroups.every((group) => !(group.id in a.session.options)));
  const agent = picker(a.state, "Agent");
  editor.host.select(a.item.resource, agent, agent.items.find((item) => item.name === "Custom agent").id);
  await settled(a.record);
  editor.host.flush();
  assert.equal(a.record.configOptions.find((option) => option.id === "mode").currentValue, "custom-agent");
  assert.equal(b.record.configOptions.find((option) => option.id === "mode").currentValue, "workspace-agent");
  const calls = await traffic(editor.backend, "session/set_config_option");
  assert.deepEqual(calls.map((entry) => entry.params), [{ sessionId: a.record.id, configId: "mode", value: "custom-agent" }]);
  assert.equal(editor.host.visible(a.item.resource).length, 3);
  assert.equal(editor.host.visible(b.item.resource).length, 3);
});

test("inline own A choice after a foreign B marker still targets A and preserves both cwd catalogs", async (t) => {
  const editor = configured(t, "config", undefined, [__dirname, path.join(__dirname, "fixtures")]);
  editor.vscode.window.showWorkspaceFolderPick = async () => editor.vscode.workspace.workspaceFolders[0];
  const initialA = await emptySession(editor);
  editor.vscode.window.showWorkspaceFolderPick = async () => editor.vscode.workspace.workspaceFolders[1];
  const b = await emptySession(editor);
  // Resolve A against the union containing B, so the host can deliver B's marker item.
  const a = { ...initialA, ...await editor.host.open(initialA.item.resource) };
  const bSnapshot = structuredClone(b.record.configOptions);
  const bRevision = b.record.configRevision;
  const aGroupIds = editor.host.visible(a.item.resource).map((group) => group.id);
  const bGroupIds = editor.host.visible(b.item.resource).map((group) => group.id);
  const marker = b.state.groups.find((group) => group.id === "opencode_session");
  editor.host.broadcast({ [marker.id]: marker.selected });
  assert.equal(a.state.groups.find((group) => group.id === "opencode_session").selected.id, marker.selected.id);
  assert.equal((await traffic(editor.backend, "session/set_config_option")).length, 0);

  const model = picker(a.state, "Model");
  editor.host.select(a.item.resource, model, model.items.find((item) => item.name === "Reasoning model").id);
  await settled(a.record);
  editor.host.flush();
  assert.deepEqual((await traffic(editor.backend, "session/set_config_option")).map((entry) => entry.params), [{ sessionId: a.record.id, configId: "model", value: "provider/test/reasoning/extra" }]);
  assert.equal(a.record.configOptions[0].currentValue, "provider/test/reasoning/extra");
  assert.deepEqual(b.record.configOptions, bSnapshot);
  assert.equal(b.record.configRevision, bRevision);
  assert.deepEqual(editor.host.visible(a.item.resource).map((group) => group.id), aGroupIds);
  assert.deepEqual(editor.host.visible(b.item.resource).map((group) => group.id), bGroupIds);
  assert.equal(picker(a.state, "Model").selected.name, "Reasoning model");
  assert.equal(b.state.groups.find((group) => group.id === bGroupIds[0]).selected.name, "Initial");
  assert.deepEqual(editor.errors, []);
});

test("inline held configuration keeps old confirmed selection and displays a different available server confirmation", { timeout: 5000 }, async (t) => {
  const editor = configured(t, "config-delayed");
  const a = await emptySession(editor);
  const original = structuredClone(a.record.configOptions);
  const revision = a.record.configRevision;
  const confirmation = structuredClone(original);
  confirmation[0].currentValue = "provider/test/plain";
  await editor.backend.client.requestExtension("echo", { control: "next-config-response", result: { configOptions: confirmation } });
  const model = picker(a.state, "Model");
  const barrier = configBarrier(t, editor.backend.client);
  editor.host.select(a.item.resource, model, model.items.find((item) => item.name === "Reasoning model").id);
  assert.equal(picker(a.state, "Model").selected.name, "Initial");
  assert.equal(picker(a.state, "Model").selected.locked, true);
  await barrier;
  assert.deepEqual(a.record.configOptions, original);
  assert.equal(a.record.configOptions[0].currentValue, "provider/test/initial");
  assert.equal(a.record.configRevision, revision);
  assert.equal(picker(a.state, "Model").selected.name, "Initial");
  assert.equal(picker(a.state, "Model").selected.locked, true);
  assert.equal(editor.host.editorOptions.get(a.item.resource.toString())[model.id].name, "Initial");
  assert.equal(editor.host.editorOptions.get(a.item.resource.toString())[model.id].locked, true);
  assert.deepEqual(a.record.history, []);
  await editor.backend.client.requestExtension("echo", { control: "release-config" });
  await settled(a.record);
  editor.host.flush();
  assert.deepEqual(a.record.configOptions, confirmation);
  assert.equal(a.record.configOptions[0].currentValue, "provider/test/plain");
  assert.equal(picker(a.state, "Model").selected.name, "Plain model");
  assert.equal(picker(a.state, "Model").selected.locked, false);
  assert.equal(editor.host.editorOptions.get(a.item.resource.toString())[model.id].name, "Plain model");
  assert.deepEqual((await traffic(editor.backend, "session/set_config_option")).map((entry) => entry.params), [{ sessionId: a.record.id, configId: "model", value: "provider/test/reasoning/extra" }]);
  assert.equal((await traffic(editor.backend, "session/load")).length, 0);
  assert.equal((await traffic(editor.backend, "session/prompt")).length, 0);
  assert.deepEqual(a.record.history, []);
  assert.deepEqual(editor.errors, []);
});

test("inline pending broadcast and duplicate REAL states produce one literal setter", { timeout: 5000 }, async (t) => {
  const editor = configured(t, "config-delayed");
  const a = await emptySession(editor);
  const duplicate = await editor.host.injectInput(a.item.resource);
  await editor.vscode.provider.provideChatSessionContent(a.item.resource, token, { inputState: duplicate });
  const b = await emptySession(editor);
  const agent = picker(a.state, "Agent");
  const barrier = configBarrier(t, editor.backend.client);
  editor.host.select(a.item.resource, agent, agent.items.find((item) => item.name === "Custom agent").id);
  assert.ok(a.record.configPending);
  assert.equal(picker(a.state, "Agent").selected.locked, true);
  editor.host.broadcast(Object.fromEntries(b.state.groups.filter((group) => group.selected).map((group) => [group.id, group.selected])));
  editor.host.flush();
  await barrier;
  assert.equal((await traffic(editor.backend, "session/set_config_option")).length, 1);
  assert.deepEqual(editor.errors, []);
  await editor.backend.client.requestExtension("echo", { control: "release-config" });
  await settled(a.record);
  editor.host.flush();
  assert.equal(picker(a.state, "Agent").selected.locked, false);
  assert.equal(picker(duplicate, "Agent").selected.name, "Custom agent");
  assert.equal((await traffic(editor.backend, "session/set_config_option")).length, 1);
});

test("inline model changes rebuild effort and local unavailable items never reach ACP", async (t) => {
  const editor = configured(t);
  const a = await emptySession(editor);
  let model = picker(a.state, "Model");
  editor.host.select(a.item.resource, model, model.items.find((item) => item.name === "Reasoning model").id);
  await settled(a.record);
  let effort = picker(a.state, "Reasoning");
  assert.match(effort.selected.name, /removed-current/);
  assert.equal(effort.selected.locked, true);
  assert.ok(effort.items.includes(effort.selected));
  a.state.quiet(a.state.groups.map((group) => group.id === effort.id ? { ...group, selected: { ...effort.selected, id: "invented" } } : group));
  a.state.change.fire();
  assert.ok(editor.errors.length);
  assert.equal((await traffic(editor.backend, "session/set_config_option")).length, 1);
  effort = picker(a.state, "Reasoning");
  editor.host.select(a.item.resource, effort, effort.items.find((item) => item.name === "Deep").id);
  await settled(a.record);
  assert.equal(a.record.configOptions.find((option) => option.id === "effort").currentValue, "deep-custom");
  model = picker(a.state, "Model");
  editor.host.select(a.item.resource, model, model.items.find((item) => item.name === "Plain model").id);
  await settled(a.record);
  assert.deepEqual(editor.host.visible(a.item.resource).map((group) => group.name), ["Model", "Agent"]);
  assert.deepEqual((await traffic(editor.backend, "session/set_config_option")).map((entry) => entry.params.value), ["provider/test/reasoning/extra", "deep-custom", "provider/test/plain"]);
});

test("inline invalidation is locked unavailable until explicit reload, with no setter replay", { timeout: 5000 }, async (t) => {
  const editor = configured(t, "config-delayed-error");
  const a = await emptySession(editor);
  const agent = picker(a.state, "Agent");
  const barrier = configBarrier(t, editor.backend.client);
  editor.host.select(a.item.resource, agent, agent.items.find((item) => item.name === "Custom agent").id);
  await barrier;
  await editor.backend.client.requestExtension("echo", { control: "release-config" });
  await settled(a.record);
  assert.equal(a.record.configValid, false);
  assert.ok(editor.host.visible(a.item.resource).every((group) => group.selected.locked && /unavailable/i.test(group.selected.name)));
  editor.host.flush();
  assert.equal((await traffic(editor.backend, "session/load")).length, 0);
  const reloaded = await editor.host.open(a.item.resource);
  assert.equal(a.record.configValid, true);
  assert.equal(picker(reloaded.state, "Agent").selected.name, "Custom agent");
  editor.host.flush();
  assert.equal((await traffic(editor.backend, "session/set_config_option")).length, 1);
  assert.equal((await traffic(editor.backend, "session/load")).length, 1);
});

test("inline stale or malformed selection restores confirmed state without RPC", async (t) => {
  const editor = configured(t);
  const a = await emptySession(editor);
  const old = a.state.groups;
  await editor.backend.client.requestExtension("echo", { control: "update-config", sessionId: a.record.id, configOptions: a.record.configOptions });
  const agent = picker({ groups: old }, "Agent");
  a.state.quiet(old.map((group) => group.id === agent.id ? { ...group, selected: group.items[1] } : group));
  a.state.change.fire();
  assert.ok(editor.errors.some((error) => /stale/i.test(error)));
  for (const selected of [undefined, { id: 42 }, { id: "foreign" }]) {
    a.state.quiet(a.state.groups.map((group) => group.id === agent.id ? { ...group, selected } : group));
    a.state.change.fire();
    assert.equal(picker(a.state, "Agent").selected.name, "Workspace agent");
  }
  assert.equal((await traffic(editor.backend, "session/set_config_option")).length, 0);
});

test("inline disposal reclaims only dead REAL groups and pending setters do not mutate disposed UI", { timeout: 5000 }, async (t) => {
  const editor = configured(t, "config-delayed");
  const a = await emptySession(editor);
  const b = await emptySession(editor);
  const agent = picker(a.state, "Agent");
  const barrier = configBarrier(t, editor.backend.client);
  editor.host.select(a.item.resource, agent, agent.items[1].id);
  await barrier;
  a.state.dispose();
  assert.equal(a.state.change.listeners.size, 0);
  assert.equal(a.state.disposal.listeners.size, 0);
  assert.equal(editor.host.visible(a.item.resource).length, 0);
  assert.equal(editor.host.visible(b.item.resource).length, 3);
  await editor.backend.client.requestExtension("echo", { control: "release-config" });
  await settled(a.record);
  editor.host.flush();
  assert.equal(a.record.configOptions.find((option) => option.id === "mode").currentValue, "custom-agent");
  assert.equal(editor.host.visible(b.item.resource).length, 3);
});

test("inline native replacement during pending configuration disposes old A and confirms only live A without losing B", { timeout: 5000 }, async (t) => {
  const editor = configured(t, "config-delayed");
  const a = await emptySession(editor);
  const b = await emptySession(editor);
  const bSnapshot = structuredClone(b.record.configOptions);
  const bGroupIds = editor.host.visible(b.item.resource).map((group) => group.id);
  const agent = picker(a.state, "Agent");
  const selected = agent.items[1].id;
  const barrier = configBarrier(t, editor.backend.client);
  editor.host.select(a.item.resource, agent, selected);
  await barrier;
  let replacementAtDisposal;
  a.state.onDidDispose(() => {
    const unbound = [...editor.host.states].filter((state) => !state.sessionResource && !state.untitledSessionResource);
    assert.equal(unbound.length, 1, "Create the new unbound state before disposing the old A");
    replacementAtDisposal = unbound[0];
  });
  const reopened = await editor.host.open(a.item.resource);
  assert.equal(reopened.state, replacementAtDisposal);
  assert.equal(reopened.state.sessionResource, a.item.resource);
  assert.equal(editor.host.states.has(reopened.state), true);
  assert.equal(editor.host.states.has(a.state), false);
  assert.equal(a.state.change.listeners.size, 0);
  assert.equal(a.state.disposal.listeners.size, 0);
  const disposedGroups = a.state.groups;
  assert.equal(picker(reopened.state, "Agent").selected.name, "Workspace agent");
  assert.equal(picker(reopened.state, "Agent").selected.locked, true);
  assert.deepEqual(editor.host.visible(b.item.resource).map((group) => group.id), bGroupIds);
  editor.host.broadcast({ [agent.id]: selected });
  assert.deepEqual(editor.errors, []);
  await editor.backend.client.requestExtension("echo", { control: "release-config" });
  await settled(a.record);
  editor.host.flush();
  assert.equal(picker(reopened.state, "Agent").selected.name, "Custom agent");
  assert.equal(picker(reopened.state, "Agent").selected.locked, false);
  assert.equal(a.state.groups, disposedGroups);
  assert.deepEqual(b.record.configOptions, bSnapshot);
  assert.equal(b.state.groups.find((group) => group.id === bGroupIds[1]).selected.name, "Workspace agent");
  assert.deepEqual(editor.host.visible(b.item.resource).map((group) => group.id), bGroupIds);
  assert.deepEqual((await traffic(editor.backend, "session/set_config_option")).map((entry) => entry.params), [{ sessionId: a.record.id, configId: "mode", value: "custom-agent" }]);
  assert.equal((await traffic(editor.backend, "session/load")).length, 0);
  assert.equal((await traffic(editor.backend, "session/prompt")).length, 0);
});

test("inline error notification dismissal cannot clear a newer pending desired selection", { timeout: 5000 }, async (t) => {
  const editor = configured(t, "config-delayed-error");
  let dismiss;
  const notification = new Promise((resolve) => { dismiss = resolve; });
  editor.vscode.window.showErrorMessage = (message) => {
    editor.errors.push(message);
    return editor.errors.length === 1 ? notification : Promise.resolve(undefined);
  };
  const a = await emptySession(editor);
  let agent = picker(a.state, "Agent");
  let barrier = configBarrier(t, editor.backend.client);
  editor.host.select(a.item.resource, agent, agent.items[1].id);
  await barrier;
  await editor.backend.client.requestExtension("echo", { control: "release-config" });
  await settled(a.record);
  const reloaded = await editor.host.open(a.item.resource);
  agent = picker(reloaded.state, "Agent");
  const desired = agent.items.find((item) => item.name === "Workspace agent").id;
  barrier = configBarrier(t, editor.backend.client);
  editor.host.select(a.item.resource, agent, desired);
  await barrier;
  dismiss();
  await new Promise(setImmediate);
  editor.host.broadcast({ [agent.id]: desired });
  assert.equal(editor.errors.length, 1, "Old notification dismissal must not forget the accepted newer choice");
  await editor.backend.client.requestExtension("echo", { control: "release-config" });
  await settled(a.record);
  assert.equal((await traffic(editor.backend, "session/set_config_option")).length, 2);
});

for (const stop of [false, true]) test(`inline active prompt locks configuration and ${stop ? "Stop" : "completion"} unlocks it`, { timeout: 5000 }, async (t) => {
  let entered;
  let release;
  const permissionEntered = new Promise((resolve) => { entered = resolve; });
  const editor = configured(t, "config", (_params, signal) => {
    entered();
    return new Promise((resolve) => {
      release = () => resolve("no");
      signal.addEventListener("abort", () => resolve(undefined), { once: true });
    });
  });
  const a = await emptySession(editor);
  let cancel;
  let cancellationDisposed = false;
  const requestToken = { isCancellationRequested: false, onCancellationRequested: (listener) => { cancel = listener; return { dispose: () => { cancellationDisposed = true; } }; } };
  const send = a.session.requestHandler({ prompt: "question", attempt: 0 }, { history: [] }, { markdown() {}, push() {} }, requestToken);
  await permissionEntered;
  const agent = picker(a.state, "Agent");
  assert.equal(agent.selected.locked, true);
  editor.host.select(a.item.resource, agent, agent.items[1].id);
  assert.ok(editor.errors.some((message) => /busy/i.test(message)));
  assert.equal((await traffic(editor.backend, "session/set_config_option")).length, 0);
  if (stop) cancel();
  else release();
  await send;
  assert.equal(picker(a.state, "Agent").selected.locked, false);
  assert.equal(a.record.turn, undefined);
  assert.equal(cancellationDisposed, true);
  assert.equal(a.record.configOptions.find((option) => option.id === "mode").currentValue, "workspace-agent");
});

for (const fail of [false, true]) test(`inline reserved Send ${fail ? "rejects uncertain configuration" : "Stop leaves accepted configuration pending"} without prompt or history`, { timeout: 5000 }, async (t) => {
  const editor = configured(t, fail ? "config-delayed-error" : "config-delayed");
  const a = await emptySession(editor);
  const agent = picker(a.state, "Agent");
  const barrier = configBarrier(t, editor.backend.client);
  editor.host.select(a.item.resource, agent, agent.items[1].id);
  await barrier;
  let cancel;
  const requestToken = { isCancellationRequested: false, onCancellationRequested: (listener) => { cancel = listener; return { dispose() {} }; } };
  const send = a.session.requestHandler({ prompt: "waiting", attempt: 0 }, { history: [] }, { markdown() { assert.fail("No prompt must start"); }, push() {} }, requestToken);
  const result = fail ? assert.rejects(send, /requestHandler.*configuration failed/) : send;
  await new Promise(setImmediate);
  assert.ok(a.record.turn);
  assert.equal(picker(a.state, "Agent").selected.locked, true);
  if (!fail) {
    cancel();
    await result;
    assert.equal(a.record.turn, undefined);
    assert.ok(a.record.configPending);
    assert.equal(picker(a.state, "Agent").selected.locked, true);
  }
  assert.equal((await traffic(editor.backend, "session/prompt")).length, 0);
  assert.equal((await traffic(editor.backend, "session/cancel")).length, 0);
  await editor.backend.client.requestExtension("echo", { control: "release-config" });
  await result;
  await settled(a.record);
  assert.deepEqual(a.record.history, []);
  assert.equal(a.record.turn, undefined);
  assert.equal(picker(a.state, "Agent").selected.locked, fail);
  assert.equal(a.record.configValid, !fail);
});

test("inline grouped catalogs expose only plain text metadata", async (t) => {
  const editor = configured(t);
  const a = await emptySession(editor);
  await updateGroupedCatalog(editor, a.record);
  const model = picker(a.state, "Model");
  const choice = model.items.find((item) => item.name === "$(zap) [run](command:evil) <img>");
  assert.ok(choice);
  assert.equal(choice.description, "[detail](command:evil)");
  assert.deepEqual(Object.keys(choice).sort(), ["description", "id", "name"]);
});

test("inline grouped catalogs send literal ACP values", async (t) => {
  const editor = configured(t);
  const a = await emptySession(editor);
  await updateGroupedCatalog(editor, a.record);
  const model = picker(a.state, "Model");
  const choice = model.items.find((item) => item.name === "$(zap) [run](command:evil) <img>");
  editor.host.select(a.item.resource, model, choice.id);
  await settled(a.record);
  assert.equal(a.record.configOptions[0].currentValue, "provider/test/reasoning/extra");
  assert.deepEqual((await traffic(editor.backend, "session/set_config_option")).map((entry) => entry.params), [{ sessionId: a.record.id, configId: "model", value: "provider/test/reasoning/extra" }]);
  assert.deepEqual(a.record.history, []);
});

test("inline opaque choice IDs do not collapse distinct raw string values", async (t) => {
  const editor = configured(t);
  const a = await emptySession(editor);
  await editor.backend.client.requestExtension("echo", { control: "update-config", sessionId: a.record.id, configOptions: [{
    id: "model", type: "select", name: "Model", currentValue: "\ud800", options: [{ value: "\ud800", name: "First" }, { value: "\ud801", name: "Second" }],
  }] });
  const model = picker(a.state, "Model");
  assert.equal(model.items.length, 2);
  assert.notEqual(model.items[0].id, model.items[1].id);
  assert.equal(model.selected.name, "First");
});

test("inline Reasoning is hidden when effort has no flat or grouped choices", async (t) => {
  const editor = configured(t);
  const a = await emptySession(editor);
  for (const options of [[], [{ group: "empty", name: "Empty", options: [] }]]) {
    const configOptions = a.record.configOptions.map((option) => option.id === "effort" ? { ...option, options } : option);
    await editor.backend.client.requestExtension("echo", { control: "update-config", sessionId: a.record.id, configOptions });
    assert.equal(picker(a.state, "Reasoning"), undefined);
    assert.deepEqual(editor.host.visible(a.item.resource).map((group) => group.name), ["Model", "Agent"]);
  }
});

test("inline generic untitled content publishes only unconfigured options before lazy materialization", async (t) => {
  const editor = configured(t);
  const draft = editor.vscode.Uri.from({ scheme: "opencode", path: "/untitled-config" });
  const state = await editor.host.input(undefined);
  const session = await editor.vscode.provider.provideChatSessionContent(draft, token, { inputState: state });
  assert.equal(editor.backend.client, undefined);
  assert.equal(Object.keys(session.options).length, 1);
  assert.deepEqual(session.history, []);
  await session.requestHandler({ prompt: "first", attempt: 0 }, {}, { markdown() {}, push() {} }, token);
  assert.equal((await traffic(editor.backend, "session/new")).length, 1);
  assert.equal((await traffic(editor.backend, "session/prompt")).length, 1);
  assert.equal(editor.backend.records.size, 1);
});

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

test("dynamic slash reports missing customization API before registering or starting ACP", (t) => {
  const { vscode, context, participants, fileSystems } = api();
  delete vscode.chat.registerChatSessionCustomizationProvider;
  const backend = new Sessions({ command: process.execPath, cwd: __dirname, permission: async () => "no" });
  t.after(() => backend.dispose());
  assert.throws(() => extension.register(vscode, context, backend), /chatSessionCustomizationProvider unavailable/);
  assert.equal(participants.size, 0);
  assert.equal(fileSystems.size, 0);
  assert.equal(vscode.customizations, undefined);
  assert.equal(backend.client, undefined);
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

test("native slash manifest enables dynamic prompts but not checkpoint editing or other attachments", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../package.json"), "utf8"));
  const session = manifest.contributes.chatSessions.find((item) => item.type === "opencode");
  assert.equal(session.commands, undefined, "Do not duplicate compact or invent availability through static commands");
  assert.ok(manifest.enabledApiProposals.includes("chatSessionCustomizationProvider"));
  assert.deepEqual(session.capabilities, { supportsPromptAttachments: true });
});

test("dynamic slash queries stay lazy for drafts, cancelled, foreign and unknown resources", async (t) => {
  const editor = configured(t, "commands");
  const registration = editor.vscode.customizations;
  assert.ok(registration, "Register the native per-resource customization provider");
  assert.equal(registration.id, "opencode");
  assert.deepEqual(registration.metadata.supportedTypes, [editor.vscode.ChatSessionCustomizationType.Prompt]);
  for (const resource of [editor.vscode.Uri.from({ scheme: "opencode", path: "/untitled-dynamic" }),
    editor.vscode.Uri.from({ scheme: "opencode", path: "/missing" }), editor.vscode.Uri.from({ scheme: "other", path: "/session-1" })]) {
    assert.deepEqual(await registration.provider.provideChatSessionCustomizations(resource, token), []);
  }
  assert.deepEqual(await registration.provider.provideChatSessionCustomizations(editor.vscode.Uri.from({ scheme: "opencode", path: "/session-1" }), { ...token, isCancellationRequested: true }), []);
  assert.equal(editor.backend.client, undefined);
  assert.equal(editor.backend.records.size, 0);
});

test("dynamic slash rejects noncanonical REAL URIs without reconnecting ACP", async (t) => {
  const editor = configured(t, "commands");
  const item = await editor.controller.newChatSessionItemHandler({ request: { prompt: "" } }, token);
  editor.backend.client.dispose();
  for (const extra of [{ query: "foreign=1" }, { fragment: "foreign" }, { authority: "foreign" }]) {
    const resource = editor.vscode.Uri.from({ scheme: "opencode", path: item.resource.path, ...extra });
    assert.deepEqual(await editor.vscode.customizations.provider.provideChatSessionCustomizations(resource, token), []);
    assert.equal(editor.backend.client, undefined, "Unknown URI must not load a known session by path");
  }
});

async function commandSession(t) {
  const editor = configured(t, "commands");
  const item = await editor.controller.newChatSessionItemHandler({ request: { prompt: "" } }, token);
  const provider = editor.vscode.customizations.provider;
  const entries = await provider.provideChatSessionCustomizations(item.resource, token);
  const fileSystem = editor.fileSystems.get(entries[0].uri.scheme);
  return { editor, item, provider, entries, fileSystem, files: fileSystem.provider };
}

test("dynamic slash provider projects advertised descriptions and hints as invocable prompts", async (t) => {
  const { editor, entries } = await commandSession(t);
  assert.deepEqual(entries.map((item) => item.name), ["compact", "review-test"]);
  assert.ok(entries.every((item) => item.type.id === "prompt" && item.userInvocable && item.source === "extension"));
  assert.equal(entries[1].description, "Review project — files to review");
  assert.equal((await traffic(editor.backend, "session/prompt")).length, 0);
});

test("dynamic slash provider isolates cwd snapshots during another session update", async (t) => {
  const editor = configured(t, "commands", undefined, [__dirname, path.join(__dirname, "fixtures")]);
  let pick = 0;
  editor.vscode.window.showWorkspaceFolderPick = async () => editor.vscode.workspace.workspaceFolders[pick++];
  const first = await editor.controller.newChatSessionItemHandler({ request: { prompt: "" } }, token);
  const second = await editor.controller.newChatSessionItemHandler({ request: { prompt: "" } }, token);
  const provider = editor.vscode.customizations.provider;
  const read = (item) => provider.provideChatSessionCustomizations(item.resource, token);
  assert.deepEqual((await read(first)).map((item) => item.name), ["compact", "review-test"]);
  assert.deepEqual((await read(second)).map((item) => item.name), ["compact", "review-fixtures"]);
  await editor.backend.client.requestExtension("echo", { control: "update-commands", sessionId: first.resource.path.slice(1), availableCommands: [{ name: "lint", description: "Lint project" }] });
  assert.deepEqual((await read(second)).map((item) => item.name), ["compact", "review-fixtures"]);
});

test("dynamic slash provider refreshes native consumers on live replacement", async (t) => {
  const { editor, item, provider } = await commandSession(t);
  let refreshes = 0;
  const listener = provider.onDidChange(() => refreshes++);
  t.after(() => listener.dispose());
  await editor.backend.client.requestExtension("echo", { control: "update-commands", sessionId: item.resource.path.slice(1), availableCommands: [{ name: "lint", description: "Lint project" }] });
  assert.equal(refreshes, 1);
  assert.deepEqual((await provider.provideChatSessionCustomizations(item.resource, token)).map((item) => item.name), ["lint"]);
});

test("dynamic slash provider removes completions for an empty live advertisement", async (t) => {
  const { editor, item, provider } = await commandSession(t);
  await editor.backend.client.requestExtension("echo", { control: "update-commands", sessionId: item.resource.path.slice(1), availableCommands: [] });
  assert.deepEqual(await provider.provideChatSessionCustomizations(item.resource, token), []);
});

test("dynamic slash metadata is never persisted with saved session IDs", async (t) => {
  const { editor } = await commandSession(t);
  assert.deepEqual(Object.keys(editor.data.get("sessions")[0]).sort(), ["created", "cwd", "id", "label"]);
});

test("dynamic slash virtual files contain inert command metadata only", async (t) => {
  const { entries: [command], fileSystem, files } = await commandSession(t);
  assert.ok(fileSystem, "Prompt parsing reads fileService, not only virtual text documents");
  assert.equal(fileSystem.options.isReadonly, true);
  assert.match(command.uri.path, /\.prompt\.md$/);
  assert.equal(Buffer.from(files.readFile(command.uri)).toString(), '---\nname: "compact"\n---\n');
  assert.equal(files.stat(command.uri).size, Buffer.byteLength('---\nname: "compact"\n---\n'));
});

for (const operation of ["writeFile", "delete", "rename", "createDirectory"]) test(`dynamic slash virtual filesystem denies ${operation}`, async (t) => {
  const { entries: [command], files } = await commandSession(t);
  const args = operation === "writeFile" ? [command.uri, Buffer.from("evil"), {}]
    : operation === "rename" ? [command.uri, command.uri, {}] : [command.uri, {}];
  assert.throws(() => files[operation](...args), /NoPermissions/);
});

test("dynamic slash virtual filesystem rejects unissued URIs", async (t) => {
  const { editor, entries: [command], files } = await commandSession(t);
  assert.throws(() => files.readFile(editor.vscode.Uri.from({ scheme: command.uri.scheme, path: "/forged.prompt.md" })), /FileNotFound/);
});

test("dynamic slash catalog removal revokes virtual file reads", async (t) => {
  const { editor, item, entries: [command], files } = await commandSession(t);
  await editor.backend.client.requestExtension("echo", { control: "update-commands", sessionId: item.resource.path.slice(1), availableCommands: [] });
  assert.throws(() => files.readFile(command.uri), /FileNotFound/);
});

test("dynamic slash excludes names native completion would rewrite rather than corrupting commands", async (t) => {
  const editor = configured(t, "commands");
  const item = await editor.controller.newChatSessionItemHandler({ request: { prompt: "" } }, token);
  const logs = [];
  editor.backend.options.onLog = (text) => logs.push(text);
  await editor.backend.client.requestExtension("echo", { control: "update-commands", sessionId: item.resource.path.slice(1), availableCommands: [
    { name: "review.code-2_\u0434\u0430\u043d\u043d\u044b\u0435", description: "Safe" }, { name: "nested:command", description: "Native replaces colon" },
    { name: "dir/command", description: "Native cannot insert slash" }, { name: "two words", description: "Not a token" },
  ] });
  const entries = await editor.vscode.customizations.provider.provideChatSessionCustomizations(item.resource, token);
  assert.deepEqual(entries.map((entry) => entry.name), ["review.code-2_\u0434\u0430\u043d\u043d\u044b\u0435"]);
  assert.ok(logs.some((text) => text.includes("nested:command")));
});

test("dynamic slash excludes global native commands without excluding other-session builtins", async (t) => {
  const editor = configured(t, "commands");
  const item = await editor.controller.newChatSessionItemHandler({ request: { prompt: "" } }, token);
  const logs = [];
  editor.backend.options.onLog = (text) => logs.push(text);
  await editor.backend.client.requestExtension("echo", { control: "update-commands", sessionId: item.resource.path.slice(1), availableCommands:
    ["clear", "models", "debug", "fork", "vscode-pet", "tools", "help", "review"].map((name) => ({ name, description: "ACP command" })) });
  const entries = await editor.vscode.customizations.provider.provideChatSessionCustomizations(item.resource, token);
  assert.deepEqual(entries.map((entry) => entry.name), ["tools", "help", "review"]);
  for (const name of ["clear", "models", "debug", "fork", "vscode-pet"]) assert.ok(logs.some((text) => text.includes(JSON.stringify(name)) && /intercept/i.test(text)));
});

test("dynamic slash rechecks revoked references after waiting for a configuration setter", { timeout: 5000 }, async (t) => {
  const editor = configured(t, "config-delayed");
  const a = await emptySession(editor);
  await editor.backend.client.requestExtension("echo", { control: "update-commands", sessionId: a.record.id,
    availableCommands: [{ name: "review", description: "Review" }] });
  const [command] = await editor.vscode.customizations.provider.provideChatSessionCustomizations(a.item.resource, token);
  const barrier = configBarrier(t, editor.backend.client);
  const setter = editor.backend.setConfigOption(a.record, "mode", "custom-agent", a.record.configRevision);
  await barrier;
  const send = editor.participants.get("opencode")({ prompt: "/review args", attempt: 0,
    references: [{ id: "vscode.prompt.file", value: command.uri }] },
    { history: [], chatSessionContext: { chatSessionItem: a.item } }, { markdown() {}, push() {} }, token);
  const rejection = assert.rejects(send, /prompt reference/);
  await editor.backend.client.requestExtension("echo", { control: "stats" });
  assert.ok(a.record.turn, "Send is reserved while waiting for config");
  await editor.backend.client.requestExtension("echo", { control: "update-commands", sessionId: a.record.id, availableCommands: [] });
  await editor.backend.client.requestExtension("echo", { control: "release-config" });
  await setter;
  await rejection;
  assert.deepEqual(a.record.history, []);
  assert.equal((await traffic(editor.backend, "session/prompt")).length, 0);
  assert.equal(a.record.turn, undefined);
});

test("dynamic slash customizations follow materialized untitled aliases without another session", async (t) => {
  const editor = configured(t, "commands");
  const resource = editor.vscode.Uri.from({ scheme: "opencode", path: "/untitled-dynamic" });
  await editor.participants.get("opencode")({ prompt: "/review-test keep  literal", references: [], attempt: 0 },
    { history: [], chatSessionContext: { chatSessionItem: { resource } } }, { markdown() {}, push() {} }, token);
  const entries = await editor.vscode.customizations.provider.provideChatSessionCustomizations(resource, token);
  assert.deepEqual(entries.map((entry) => entry.name), ["compact", "review-test"]);
  assert.equal((await traffic(editor.backend, "session/new")).length, 1);
  assert.deepEqual((await traffic(editor.backend, "session/prompt"))[0].params.prompt, [{ type: "text", text: "Fixture review keep  literal" }]);
});

test("dynamic slash expands the local template and keeps arguments literal with virtual prompt references", async (t) => {
  const editor = configured(t, "commands");
  const item = await editor.controller.newChatSessionItemHandler({ request: { prompt: "" } }, token);
  const entries = await editor.vscode.customizations.provider.provideChatSessionCustomizations(item.resource, token);
  const reference = { id: "vscode.prompt.file", value: entries[1].uri };
  const chatContext = { history: [], chatSessionContext: { chatSessionItem: item } };
  const handler = editor.participants.get("opencode");
  await handler({ prompt: "/review-test keep  exact/args", attempt: 0, references: [reference] }, chatContext, { markdown() {}, push() {} }, token);
  assert.deepEqual((await traffic(editor.backend, "session/prompt"))[0].params.prompt, [{ type: "text", text: "Fixture review keep  exact/args" }]);
});

test("dynamic slash accepts next Send with native virtual reference history", async (t) => {
  const { editor, item, entries } = await commandSession(t);
  const reference = { id: "vscode.prompt.file", value: entries[1].uri };
  const chatContext = { history: [], chatSessionContext: { chatSessionItem: item } };
  const handler = editor.participants.get("opencode");
  await handler({ prompt: "/review-test keep  exact/args", attempt: 0, references: [reference] }, chatContext, { markdown() {}, push() {} }, token);
  chatContext.history = [new editor.vscode.ChatRequestTurn2("/review-test keep  exact/args", undefined, [reference])];
  await handler({ prompt: "next", attempt: 0, references: [] }, chatContext, { markdown() {}, push() {} }, token);
  assert.equal((await traffic(editor.backend, "session/prompt")).length, 2);
});

for (const invalid of ["foreign", "stale", "forged", "external"]) test(`dynamic slash rejects ${invalid} prompt references before ACP Send`, async (t) => {
  const editor = configured(t, "commands");
  const own = await editor.controller.newChatSessionItemHandler({ request: { prompt: "" } }, token);
  const other = await editor.controller.newChatSessionItemHandler({ request: { prompt: "" } }, token);
  const entries = await editor.vscode.customizations.provider.provideChatSessionCustomizations((invalid === "foreign" ? other : own).resource, token);
  let uri = entries[0].uri;
  if (invalid === "forged") uri = editor.vscode.Uri.from({ scheme: uri.scheme, path: "/not-issued.prompt.md" });
  if (invalid === "external") uri = editor.vscode.Uri.from({ scheme: "file", path: "/external.prompt.md" });
  if (invalid === "stale") await editor.backend.client.requestExtension("echo", { control: "update-commands", sessionId: own.resource.path.slice(1), availableCommands: [] });
  const record = editor.backend.records.get(own.resource.path.slice(1));
  await assert.rejects(editor.participants.get("opencode")({ prompt: "/compact", references: [{ id: "vscode.prompt.file", value: uri }], attempt: 0 },
    { history: [], chatSessionContext: { chatSessionItem: own } }, { markdown() {}, push() {} }, token), /prompt reference/);
  assert.deepEqual(record.history, []);
  assert.equal((await traffic(editor.backend, "session/prompt")).length, 0);
});

test("dynamic slash disposal removes listeners and revokes virtual file access", async (t) => {
  const editor = configured(t, "commands");
  const item = await editor.controller.newChatSessionItemHandler({ request: { prompt: "" } }, token);
  const provider = editor.vscode.customizations.provider;
  const [command] = await provider.provideChatSessionCustomizations(item.resource, token);
  const files = editor.fileSystems.get(command.uri.scheme).provider;
  editor.context.subscriptions.forEach((subscription) => subscription.dispose());
  assert.equal(editor.backend.listenerCount("commands"), 0);
  assert.equal(editor.fileSystems.size, 0);
  assert.throws(() => files.readFile(command.uri), /FileNotFound/);
  assert.deepEqual(await provider.provideChatSessionCustomizations(item.resource, token), []);
});

test("native slash rejects addition of a command to unchanged raw historical prompt", async (t) => {
  const editor = configured(t, "commands");
  const item = await editor.controller.newChatSessionItemHandler({ request: { prompt: "" } }, token);
  const handler = editor.participants.get("opencode");
  const chatContext = { history: [], chatSessionContext: { chatSessionItem: item } };
  const stream = { markdown() {}, push() {} };
  await handler({ prompt: "/review-test args", attempt: 0 }, chatContext, stream, token);
  const record = editor.backend.records.get(item.resource.path.slice(1));
  const before = structuredClone(record.history);
  chatContext.history = [new editor.vscode.ChatRequestTurn2("/review-test args", "injected")];
  await assert.rejects(handler({ prompt: "next", attempt: 0 }, chatContext, stream, token), /Editing.*disabled/);
  assert.deepEqual(record.history, before);
  assert.equal((await traffic(editor.backend, "session/prompt")).length, 1);
});

for (const untitled of [false, true]) for (const example of [
  { command: "compact", prompt: "", text: "/compact", expanded: "Fixture compact" },
  { command: "compact", prompt: "keep  API details", text: "/compact keep  API details", expanded: "Fixture compact keep  API details" },
  { command: undefined, prompt: "/review-test literal/args", text: "/review-test literal/args", expanded: "Fixture review literal/args" },
]) test(`native slash expands ACP text (${untitled ? "untitled" : "saved"}, ${example.text})`, async (t) => {
  // VS Code removes registered slash commands from prompt and stores command separately,
  // including in ChatRequestTurn2. The ACP fixture only echoes text; it does not compact.
  const { vscode, context, controller, participants } = api();
  const backend = new Sessions({ command: process.execPath, args: [path.join(__dirname, "fixtures/agent.cjs"), "commands"], cwd: __dirname, permission: async () => "no" });
  t.after(() => backend.dispose());
  extension.register(vscode, context, backend);
  const item = untitled ? { resource: vscode.Uri.from({ scheme: "opencode", path: "/untitled-slash" }) }
    : await controller.newChatSessionItemHandler({ request: example }, token);
  if (!untitled) assert.equal(item.label, example.text, "Set the command label before the first Send");
  const chatContext = { history: [], chatSessionContext: { chatSessionItem: item } };
  const text = [];
  const stream = { markdown: (value) => text.push(value.value), push() {} };
  const handler = participants.get("opencode");
  await handler({ command: example.command, prompt: example.prompt, attempt: 0 }, chatContext, stream, token);
  assert.deepEqual(text, [`answer:${example.expanded}`]);
  const record = [...backend.records.values()][0];
  assert.equal(record.label, example.text);
  assert.deepEqual((await traffic(backend, "session/prompt")).map((entry) => entry.params), [
    { sessionId: record.id, prompt: [{ type: "text", text: example.expanded }] },
  ]);
  assert.deepEqual(record.history.filter((turn) => turn.role === "user").map((turn) => turn.text), [example.expanded]);
  assert.deepEqual(record.history.filter((turn) => turn.role === "user").map((turn) => turn.nativeText), [example.text]);
});

for (const source of ["native", "provider"]) test(`native slash accepts next Send with ${source} command history`, async (t) => {
  const editor = configured(t, "commands");
  const item = await editor.controller.newChatSessionItemHandler({ request: { command: "compact", prompt: "keep notes" } }, token);
  const chatContext = { history: [], chatSessionContext: { chatSessionItem: item } };
  const stream = { markdown() {}, push() {} };
  await editor.participants.get("opencode")({ command: "compact", prompt: "keep notes", attempt: 0 }, chatContext, stream, token);
  const session = await editor.vscode.provider.provideChatSessionContent(item.resource, token);
  const history = source === "native" ? [new editor.vscode.ChatRequestTurn2("keep notes", "compact")] : session.history;
  await session.requestHandler({ prompt: "next", attempt: 0 }, { history }, stream, token);
  assert.deepEqual((await traffic(editor.backend, "session/prompt")).map((entry) => entry.params.prompt), [
    [{ type: "text", text: "Fixture compact keep notes" }], [{ type: "text", text: "next" }],
  ]);
  assert.deepEqual(editor.backend.records.get(item.resource.path.slice(1)).history.filter((turn) => turn.role === "user").map((turn) => turn.text), ["Fixture compact keep notes", "next"]);
});

for (const violation of ["Retry", "command-only edit"]) test(`native slash rejects ${violation} with complete history without another ACP prompt`, async (t) => {
  const editor = configured(t, "commands");
  const item = await editor.controller.newChatSessionItemHandler({ request: { command: "compact", prompt: "keep notes" } }, token);
  const chatContext = { history: [], chatSessionContext: { chatSessionItem: item } };
  const handler = editor.participants.get("opencode");
  const stream = { markdown() {}, push() {} };
  await handler({ command: "compact", prompt: "keep notes", attempt: 0 }, chatContext, stream, token);
  const record = editor.backend.records.get(item.resource.path.slice(1));
  const before = structuredClone(record.history);
  const history = [new editor.vscode.ChatRequestTurn2("keep notes", violation === "Retry" ? "compact" : "different-command")];
  // Keep history complete and arguments identical. Change only attempt or the historical command.
  await assert.rejects(handler({ command: "compact", prompt: "keep notes", attempt: violation === "Retry" ? 1 : 0 },
    { ...chatContext, history }, stream, token), violation === "Retry" ? /Retry.*disabled/ : /Editing.*disabled/);
  assert.equal((await traffic(editor.backend, "session/prompt")).length, 1);
  assert.deepEqual(record.history, before);
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

test("temporary Send diagnostics distinguish native entry, references and ACP completion without payloads", async (t) => {
  const { editor, item, entries: [command] } = await commandSession(t);
  const logs = [];
  editor.backend.options.onLog = (text) => logs.push(text);
  const secret = "PRIVATE-PROMPT-AND-RESPONSE";
  const output = [];
  await editor.participants.get("opencode")({ prompt: `/compact ${secret}`, references: [{ value: command.uri }], attempt: 0 },
    { history: [], chatSessionContext: { chatSessionItem: item } },
    { markdown: (value) => output.push(value.value), push() {} }, token);
  assert.deepEqual((await traffic(editor.backend, "session/prompt")).map((entry) => entry.params.prompt), [[{ type: "text", text: `Fixture compact ${secret}` }]]);
  assert.ok(output.length, "Tracing must preserve fixture streaming");
  const trace = logs.filter((line) => line.startsWith("[DEBUG-native-send]")).join("");
  for (const stage of ["participant.enter", "content.enter", "handler.enter", "references.accepted", "references.recheck.accepted", "acp.rpc.start", "acp.rpc.complete", "handler.complete"]) {
    assert.ok(trace.includes(`stage=${stage} `), `Missing diagnostic boundary ${stage}`);
  }
  assert.match(trace, /stage=handler.complete .*updates=[1-9]\d*/);
  assert.match(trace, /stage=acp.rpc.complete .*stopReason=end_turn/);
  assert.ok(!trace.includes(secret), "Do not log prompts or echoed responses");
  assert.ok(!trace.includes(command.uri.toString()), "Do not log reference paths");
});

test("temporary Send diagnostics locate rejected references without logging their values", async (t) => {
  const editor = configured(t, "");
  const { session, record } = await emptySession(editor);
  const logs = [];
  editor.backend.options.onLog = (text) => logs.push(text);
  await assert.rejects(session.requestHandler({ prompt: "PRIVATE-PROMPT", references: [{ value: editor.vscode.Uri.from({ scheme: "file", path: "/PRIVATE-REFERENCE" }) }], attempt: 0 },
    { history: [] }, { markdown() {}, push() {} }, token), /Unsupported or foreign/);
  assert.deepEqual(record.history, []);
  assert.equal((await traffic(editor.backend, "session/prompt")).length, 0);
  const trace = logs.join("");
  assert.match(trace, /stage=references.check /);
  assert.match(trace, /stage=handler.failed /);
  assert.ok(!trace.includes("stage=references.accepted "));
  assert.ok(!trace.includes("PRIVATE-") && !trace.includes("Unsupported or foreign"));
});

test("temporary Send diagnostics identify cancellation before handler entry without starting ACP", async (t) => {
  const editor = configured(t, "");
  const logs = [];
  editor.backend.options.onLog = (text) => logs.push(text);
  await editor.participants.get("opencode")({ prompt: "PRIVATE-PROMPT" },
    { chatSessionContext: { chatSessionItem: { resource: editor.vscode.Uri.from({ scheme: "opencode", path: "/untitled-cancel" }) } } },
    { markdown() {}, push() {} }, { ...token, isCancellationRequested: true });
  assert.equal(editor.backend.client, undefined);
  assert.match(logs.join(""), /stage=participant.cancelled /);
  assert.ok(!logs.join("").includes("stage=handler.enter "));
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
  assert.deepEqual(invoked, ["workbench.action.chat.openNewChatSessionInPlace.opencode"]);
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
  assert.deepEqual(invoked, ["workbench.action.chat.openNewChatSessionInPlace.opencode"]);
});
