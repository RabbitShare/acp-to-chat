"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { Sessions } = require("../src/sessions");

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
