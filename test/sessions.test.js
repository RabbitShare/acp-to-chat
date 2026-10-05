"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { getEventListeners } = require("node:events");
const { Writable } = require("node:stream");
const { Sessions } = require("../dist/sessions");
const { choosePermission } = require("../dist/extension");

function sessions(t, permission = async () => "no", scenario) {
  assert.equal(typeof Sessions, "function", "Session lifecycle is not implemented");
  const backend = new Sessions({ command: process.execPath, args: [path.join(__dirname, "fixtures/agent.cjs"), ...(scenario ? [scenario] : [])], cwd: __dirname, permission });
  t.after(() => backend.dispose());
  return backend;
}

test("creates a session, streams output and retains conversation", async (t) => {
  const backend = sessions(t);
  const record = await backend.create(__dirname);
  const updates = [];
  await backend.prompt(record, "question", new AbortController().signal, (update) => updates.push(update));
  assert.equal(record.id, "session-1");
  assert.equal(record.history[0].text, "question");
  assert.equal(record.history[1].updates[0].content.text, "answer:question");
  assert.equal(updates.at(-1).rawOutput.outcome.optionId, "no");
});

test("loads a saved session and rebuilds replayed history", async (t) => {
  const backend = sessions(t);
  const record = await backend.load({ id: "session-1", cwd: __dirname, label: "saved" });
  assert.equal(record.history[0].text, "previous question");
  assert.equal(record.history[1].updates[0].content.text, "previous answer");
});

test("never approves a dismissed permission picker", async (t) => {
  const backend = sessions(t, async () => undefined);
  const record = await backend.create(__dirname);
  const updates = [];
  await backend.prompt(record, "question", new AbortController().signal, (update) => updates.push(update));
  assert.deepEqual(updates.at(-1).rawOutput.outcome, { outcome: "cancelled" });
});

test("does not forward an option ID absent from the agent request", async (t) => {
  const backend = sessions(t, async () => "made-up-approval");
  const record = await backend.create(__dirname);
  const updates = [];
  await backend.prompt(record, "question", new AbortController().signal, (update) => updates.push(update));
  assert.deepEqual(updates.at(-1).rawOutput.outcome, { outcome: "cancelled" });
});

for (const scenario of ["malformed-permission-tool", "malformed-permission-option", "malformed-permission-title", "malformed-permission-kind"]) {
  test(`boundary cancels ${scenario} during an active turn without opening permission UI`, { timeout: 2000 }, async (t) => {
    let calls = 0;
    const backend = sessions(t, async () => { calls++; return "yes"; }, scenario);
    const record = await backend.create(__dirname);
    const updates = [];
    const result = await backend.prompt(record, "question", new AbortController().signal, (update) => {
      assert.ok(record.turn, "The malformed wire request must be handled during an active turn");
      updates.push(update);
    });
    assert.equal(result.stopReason, "end_turn");
    assert.deepEqual(result._meta.permission, { outcome: { outcome: "cancelled" } });
    assert.deepEqual(updates.at(-1).rawOutput, result._meta.permission);
    assert.equal(calls, 0);
  });
}

test("boundary allows a valid permission during an active turn as positive control", async (t) => {
  let calls = 0;
  const backend = sessions(t, async () => { calls++; return "yes"; });
  const record = await backend.create(__dirname);
  const result = await backend.prompt(record, "question", new AbortController().signal, () => {});
  assert.deepEqual(result._meta.permission, { outcome: { outcome: "selected", optionId: "yes" } });
  assert.equal(calls, 1);
});

test("boundary ignores malformed updates without changing active history or callbacks", { timeout: 2000 }, async (t) => {
  let entered;
  let release;
  const permissionStarted = new Promise((resolve) => { entered = resolve; });
  const permissionResult = new Promise((resolve) => { release = resolve; });
  const backend = sessions(t, async () => { entered(); return permissionResult; });
  const record = await backend.create(__dirname);
  const updates = [];
  const turn = backend.prompt(record, "question", new AbortController().signal, (update) => updates.push(update));
  try {
    await permissionStarted;
    assert.ok(record.turn);
    assert.equal(record.turn.controller.signal.aborted, false);
    const historyBefore = structuredClone(record.history);
    const updatesBefore = structuredClone(updates);
    for (const update of [
      null,
      { sessionUpdate: "agent_message_chunk", messageId: {}, content: { type: "text", text: "bad message ID" } },
      { sessionUpdate: "tool_call", toolCallId: 1, title: "bad tool ID" },
      { sessionUpdate: "tool_call_update", toolCallId: "tool", status: false },
      { sessionUpdate: "tool_call", toolCallId: "tool" },
      { sessionUpdate: "tool_call_update", toolCallId: "tool", kind: "invented" },
      { sessionUpdate: "tool_call_update", toolCallId: "tool", status: "invented" },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: 42 } },
      { sessionUpdate: "future_update", title: "Do not dispatch unsupported variants" },
    ]) {
      backend.update({ sessionId: record.id, update });
      assert.deepEqual(record.history, historyBefore);
      assert.deepEqual(updates, updatesBefore);
    }
    const valid = { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "valid control" } };
    backend.update({ sessionId: record.id, update: valid });
    assert.deepEqual(record.history.at(-1).updates, [...historyBefore.at(-1).updates, valid]);
    assert.deepEqual(updates, [...updatesBefore, valid]);
  } finally {
    release("no");
    await turn;
  }
});

test("boundary preserves message grouping and partial tools with SDK update consumers", (t) => {
  const backend = new Sessions({ command: process.execPath, permission: async () => "no" });
  t.after(() => backend.dispose());
  const updates = [];
  const record = { id: "projection", cwd: __dirname, history: [], turn: { controller: new AbortController(), onUpdate: (update) => updates.push(update) } };
  backend.records.set(record.id, record);
  for (const update of [
    { sessionUpdate: "user_message_chunk", messageId: "user", content: { type: "text", text: "a" } },
    { sessionUpdate: "user_message_chunk", messageId: "user", content: { type: "text", text: "b" } },
    { sessionUpdate: "agent_message_chunk", messageId: "first", content: { type: "text", text: "answer" } },
    { sessionUpdate: "tool_call", toolCallId: "tool", title: "Execute", name: "bash", messageId: "first", kind: "execute", status: "in_progress" },
    { sessionUpdate: "tool_call_update", toolCallId: "tool", messageId: "first", rawOutput: "done" },
    { sessionUpdate: "agent_thought_chunk", messageId: "second", content: { type: "text", text: "thinking" } },
  ]) backend.update({ sessionId: record.id, update });
  assert.equal(record.history[0].text, "ab");
  assert.equal(record.history.length, 3);
  assert.equal(record.history[1].updates[1].name, "bash");
  assert.equal(record.history[1].updates[2].rawOutput, "done");
  assert.equal(record.history[2].updates[0].content.text, "thinking");
  assert.equal(updates.length, 6);
});

test("boundary delivers session info to the active callback without adding history", (t) => {
  const backend = new Sessions({ command: process.execPath, permission: async () => "no" });
  t.after(() => backend.dispose());
  const updates = [];
  const record = { id: "session-info", cwd: __dirname, history: [], turn: { controller: new AbortController(), onUpdate: (update) => updates.push(update) } };
  backend.records.set(record.id, record);
  backend.update({ sessionId: record.id, update: { sessionUpdate: "session_info_update", title: "Session title", updatedAt: "2026-10-03T00:00:00Z" } });
  assert.deepEqual(updates, [{ sessionUpdate: "session_info_update", title: "Session title", updatedAt: "2026-10-03T00:00:00Z" }]);
  assert.deepEqual(record.history, []);
});

test("boundary rejects malformed optional wire updates before SDK normalization", async (t) => {
  const backend = sessions(t, async () => "no", "malformed-updates");
  const record = await backend.create(__dirname);
  const updates = [];
  await backend.prompt(record, "question", new AbortController().signal, (update) => updates.push(update));
  assert.equal(updates.length, 2);
  assert.equal(record.history[1].updates.length, 2);
  assert.equal(updates[0].content.text, "answer:question");
  assert.equal(updates[1].title, "Run command");
});

test("boundary excludes invalid user text from active history and accepts valid user text", { timeout: 2000 }, async (t) => {
  let entered;
  let release;
  const permissionStarted = new Promise((resolve) => { entered = resolve; });
  const permissionResult = new Promise((resolve) => { release = resolve; });
  const backend = sessions(t, async () => { entered(); return permissionResult; });
  const record = await backend.create(__dirname);
  const updates = [];
  const turn = backend.prompt(record, "question", new AbortController().signal, (update) => updates.push(update));
  try {
    await permissionStarted;
    assert.ok(record.turn);
    assert.equal(record.turn.controller.signal.aborted, false);
    // Invalid text is not user history and does not reach typed update consumers.
    const historyWithControl = structuredClone(record.history);
    backend.update({ sessionId: record.id, update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: 1 } } });
    assert.deepEqual(record.history, historyWithControl);
    const updatesBefore = structuredClone(updates);
    const valid = { sessionUpdate: "user_message_chunk", content: { type: "text", text: "valid user control" } };
    backend.update({ sessionId: record.id, update: valid });
    assert.deepEqual(record.history, [...historyWithControl, { role: "user", text: "valid user control", messageId: undefined }]);
    assert.deepEqual(updates, [...updatesBefore, valid]);
  } finally {
    release("no");
    await turn;
  }
});

for (const scenario of ["initialize-null", "initialize-invalid", "new-null", "new-invalid"]) {
  test(`boundary rejects ${scenario} with session method context and no created record`, async (t) => {
    const backend = sessions(t, async () => "no", scenario);
    const expected = scenario.startsWith("initialize-")
      ? /\[Sessions.connect\] Unsupported ACP protocolVersion=/
      : /\[Sessions.create\] Missing sessionId cwd=/;
    await assert.rejects(backend.create(__dirname), expected);
    assert.equal(backend.records.size, 0);
  });
}

test("boundary does not enable saved-session loading for a non-boolean capability", async (t) => {
  const backend = sessions(t, async () => "no", "invalid-load-capability");
  await assert.rejects(backend.load({ id: "saved", cwd: __dirname }), /\[Sessions.load\] Agent cannot load saved sessionId=saved/);
  const record = backend.records.get("saved");
  assert.equal(record.connection, undefined);
  assert.deepEqual(record.history, []);
});

test("cancels an active turn while permission is pending", async (t) => {
  let entered;
  const permissionStarted = new Promise((resolve) => { entered = resolve; });
  const backend = sessions(t, async (params, signal) => {
    entered();
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    return "yes";
  });
  const record = await backend.create(__dirname);
  const controller = new AbortController();
  const turn = backend.prompt(record, "question", controller.signal, () => {});
  await permissionStarted;
  controller.abort();
  const result = await turn;
  assert.equal(result.stopReason, "cancelled");
  assert.deepEqual(result._meta.permission.outcome, { outcome: "cancelled" });
  assert.equal(record.turn, undefined);
});

test("rejects concurrent prompts in one session", async (t) => {
  let entered;
  const permissionStarted = new Promise((resolve) => { entered = resolve; });
  const backend = sessions(t, async (params, signal) => {
    entered();
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    return undefined;
  });
  const record = await backend.create(__dirname);
  const controller = new AbortController();
  const first = backend.prompt(record, "question", controller.signal, () => {});
  await permissionStarted;
  await assert.rejects(backend.prompt(record, "second", new AbortController().signal, () => {}), /already active.*session-1/);
  controller.abort();
  await first;
});

test("isolates updates and permissions across two sessions", async (t) => {
  const backend = sessions(t, async (params) => params.sessionId === "session-1" ? "yes" : "no");
  const firstCwd = __dirname;
  const secondCwd = path.join(__dirname, "fixtures");
  const first = await backend.create(firstCwd);
  const second = await backend.create(secondCwd);
  const [a, b] = await Promise.all([
    backend.prompt(first, "first question", new AbortController().signal, () => {}),
    backend.prompt(second, "second question", new AbortController().signal, () => {}),
  ]);
  assert.equal(first.history[1].updates[0].content.text, "answer:first question");
  assert.equal(second.history[1].updates[0].content.text, "answer:second question");
  assert.equal(a._meta.permission.outcome.optionId, "yes");
  assert.equal(b._meta.permission.outcome.optionId, "no");
  assert.equal(a._meta.cwd, firstCwd);
  assert.equal(b._meta.cwd, secondCwd);
});

test("bounded cancellation releases a turn when the agent ignores cancel", { timeout: 9000 }, async (t) => {
  let entered;
  const permissionStarted = new Promise((resolve) => { entered = resolve; });
  const backend = sessions(t, async (params, signal) => {
    entered();
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    return undefined;
  }, "ignore-cancel");
  const record = await backend.create(__dirname);
  const controller = new AbortController();
  const turn = backend.prompt(record, "question", controller.signal, () => {});
  await permissionStarted;
  controller.abort();
  assert.equal((await turn).stopReason, "cancelled");
  assert.equal(record.turn, undefined);
});

test("reports an unexpected idle process exit", { timeout: 2000 }, async (t) => {
  const backend = sessions(t, async () => undefined, "crash-idle");
  const failure = new Promise((resolve) => backend.once("failure", resolve));
  await backend.create(__dirname);
  assert.match((await failure).message, /exit.*7/);
});

test("connection failure marks an active turn failed, not completed", { timeout: 2000 }, async (t) => {
  const backend = sessions(t, async (params, signal) => {
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    return undefined;
  }, "crash-prompt");
  const statuses = [];
  backend.on("status", (record, status) => statuses.push(status));
  const record = await backend.create(__dirname);
  await assert.rejects(backend.prompt(record, "question", new AbortController().signal, () => {}), /exit.*8/);
  assert.equal(statuses.at(-1), "failed");
});

test("lifecycle failed async cancel aborts all turns, closes permission pickers and reloads saved history", { timeout: 3000 }, async (t) => {
  const timers = new Map();
  const schedule = global.setTimeout;
  const clear = global.clearTimeout;
  t.mock.method(global, "setTimeout", (callback, delay, ...args) => {
    const timer = schedule(() => { timers.delete(timer); callback(...args); }, delay);
    timers.set(timer, delay);
    return timer;
  });
  t.mock.method(global, "clearTimeout", (timer) => { timers.delete(timer); clear(timer); });
  const toWeb = Writable.toWeb;
  t.mock.method(Writable, "toWeb", (...args) => {
    const output = toWeb(...args);
    return new WritableStream({ write: async (bytes) => {
      if (new TextDecoder().decode(bytes).includes('"method":"session/cancel"')) {
        await new Promise(setImmediate);
        throw new Error("injected async cancel write failure");
      }
      const writer = output.getWriter();
      try { await writer.write(bytes); } finally { writer.releaseLock(); }
    } });
  });
  const pickers = [];
  let bothOpened;
  const opened = new Promise((resolve) => { bothOpened = resolve; });
  const vscode = { window: { createQuickPick: () => {
    const picker = {
      selectedItems: [], disposed: false, subscriptions: 0,
      onDidAccept: () => { picker.subscriptions++; return { dispose: () => picker.subscriptions-- }; },
      onDidHide: () => { picker.subscriptions++; return { dispose: () => picker.subscriptions-- }; },
      show: () => { if (pickers.length === 2) bothOpened(); },
      dispose: () => { picker.disposed = true; },
    };
    pickers.push(picker);
    return picker;
  } } };
  const backend = sessions(t, (params, signal) => choosePermission(vscode, params, signal));
  const first = await backend.create(__dirname);
  const second = await backend.create(path.join(__dirname, "fixtures"));
  const connection = backend.client;
  const ready = backend.ready;
  const failures = [];
  const statuses = new Map();
  backend.on("failure", (error) => failures.push(error));
  backend.on("status", (record, status) => statuses.set(record.id, status));
  const stop = new AbortController();
  const continueSignal = new AbortController().signal;
  const a = backend.prompt(first, "stop question", stop.signal, () => {});
  const b = backend.prompt(second, "other question", continueSignal, () => {});
  const other = b.then(() => undefined, (error) => error);
  await opened;
  const controllers = [first.turn.controller, second.turn.controller];
  const closed = new Promise((resolve) => connection.child.once("close", resolve));
  stop.abort();
  assert.equal((await a).stopReason, "cancelled", "User Stop remains cancellation");
  assert.match((await other).message, /async cancel write failure/);
  assert.equal(statuses.get(first.id), "completed");
  assert.equal(statuses.get(second.id), "failed", "Shared connection crash is not completion");
  assert.equal(failures.length, 1);
  assert.equal(first.turn, undefined);
  assert.equal(second.turn, undefined);
  assert.ok(controllers.every((controller) => controller.signal.aborted));
  assert.ok(pickers.every((picker) => picker.disposed && picker.subscriptions === 0));
  for (const signal of [stop.signal, continueSignal, ...controllers.map((controller) => controller.signal)]) {
    assert.equal(getEventListeners(signal, "abort").length, 0);
  }
  assert.equal(backend.ready, undefined);
  assert.equal(backend.client, undefined);
  await closed;
  await new Promise(setImmediate);
  assert.deepEqual([...timers.values()], [], "Completed failed turns must clear cancel/deadline/disposal timers");
  const reloaded = await backend.load({ id: second.id, cwd: second.cwd, label: second.label, created: second.created });
  assert.equal(reloaded, second);
  assert.notEqual(backend.ready, ready);
  assert.notEqual(reloaded.connection, connection);
  assert.equal(reloaded.history[0].text, "previous question");
  assert.equal(reloaded.history[1].updates[0].content.text, "previous answer");
  assert.equal(reloaded.loading, undefined);
});

test("lifecycle voluntary backend dispose does not emit crash", { timeout: 2000 }, async (t) => {
  const backend = sessions(t);
  await backend.create(__dirname);
  const failures = [];
  backend.on("failure", (error) => failures.push(error));
  const closed = new Promise((resolve) => backend.client.child.once("close", resolve));
  backend.dispose();
  backend.dispose();
  await closed;
  assert.deepEqual(failures, []);
  assert.equal(backend.client, undefined);
  assert.equal(backend.ready, undefined);
});

test("boundary rejects malformed permission kind and optional title before SDK normalization", { timeout: 2000 }, async (t) => {
  let entered;
  let release;
  const opened = new Promise((resolve) => { entered = resolve; });
  const permissionResult = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const backend = sessions(t, () => { calls++; entered(); return calls === 1 ? permissionResult : "yes"; });
  const record = await backend.create(__dirname);
  const turn = backend.prompt(record, "question", new AbortController().signal, () => {});
  try {
    await opened;
    const params = {
      sessionId: record.id,
      toolCall: { toolCallId: "tool", title: "Permission control" },
      options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }],
    };
    for (const malformed of [
      { ...params, options: [{ ...params.options[0], kind: "not-an-ACP-permission-kind" }] },
      { ...params, toolCall: { ...params.toolCall, title: 42 } },
    ]) {
      assert.deepEqual(await backend.requestPermission("session/request_permission", malformed), { outcome: { outcome: "cancelled" } });
      assert.equal(calls, 1, "Malformed request cannot open another permission picker");
    }
  } finally {
    release("no");
    await turn;
  }
});
