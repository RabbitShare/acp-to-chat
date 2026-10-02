"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { Sessions } = require("../dist/sessions");

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

for (const scenario of ["malformed-permission-tool", "malformed-permission-option"]) {
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
    assert.deepEqual(result.permission, { outcome: { outcome: "cancelled" } });
    assert.deepEqual(updates.at(-1).rawOutput, result.permission);
    assert.equal(calls, 0);
  });
}

test("boundary allows a valid permission during an active turn as positive control", async (t) => {
  let calls = 0;
  const backend = sessions(t, async () => { calls++; return "yes"; });
  const record = await backend.create(__dirname);
  const result = await backend.prompt(record, "question", new AbortController().signal, () => {});
  assert.deepEqual(result.permission, { outcome: { outcome: "selected", optionId: "yes" } });
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
    // Invalid text is not user history; its otherwise valid envelope may still reach the callback.
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
  assert.deepEqual(result.permission.outcome, { outcome: "cancelled" });
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
  assert.equal(a.permission.outcome.optionId, "yes");
  assert.equal(b.permission.outcome.optionId, "no");
  assert.equal(a.cwd, firstCwd);
  assert.equal(b.cwd, secondCwd);
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
