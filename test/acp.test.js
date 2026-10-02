"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { AcpClient } = require("../dist/acp");

function client(t, options = {}) {
  assert.equal(typeof AcpClient, "function", "ACP transport is not implemented");
  const connection = new AcpClient(process.execPath, [path.join(__dirname, "fixtures/agent.cjs")], { cwd: __dirname, ...options });
  t.after(() => connection.dispose());
  return connection;
}

test("correlates concurrent responses received out of order", async (t) => {
  const connection = client(t);
  const [first, second] = await Promise.all([connection.request("echo", { n: 1 }), connection.request("echo", { n: 2 })]);
  assert.deepEqual(first, { text: "Hello 🌍", params: { n: 1 } });
  assert.deepEqual(second, { text: "Hello 🌍", params: { n: 2 } });
});

test("decodes a UTF-8 character split across writes", async (t) => {
  const result = await client(t).request("echo", { n: 3 });
  assert.equal(result.text, "Hello 🌍");
});

test("surfaces remote request errors with method context", async (t) => {
  await assert.rejects(client(t).request("fail", {}), /fail.*agent failure/);
});

test("rejects outstanding requests when the process exits", async (t) => {
  await assert.rejects(client(t).request("exit", {}), /exit.*3/);
});

test("fails closed on malformed stdout", async (t) => {
  await assert.rejects(client(t).request("invalid", {}), /protocol|JSON/i);
});

test("boundary rejects a valid JSON request with an invalid ID before the callback", { timeout: 2000 }, async (t) => {
  let calls = 0;
  const connection = client(t, { onRequest: () => { calls++; } });
  await assert.rejects(connection.request("invalid-request-id", {}, 500), /\[AcpClient.receive\] Invalid request id/);
  assert.equal(calls, 0);
});

test("boundary sends a method-context wire error when a client callback throws non-Error", async (t) => {
  const connection = client(t, { onRequest: (method) => {
    assert.equal(method, "client/callback");
    throw "callback failed";
  } });
  assert.deepEqual(await connection.request("client-callback", {}), {
    jsonrpc: "2.0", id: "callback-1",
    error: { code: -32601, message: "[AcpClient.answer] method=client/callback: callback failed" },
  });
});

test("times out a stalled request", async (t) => {
  await assert.rejects(client(t).request("hang", {}, 100), /hang.*timed out/);
});

test("answers permission requests explicitly and delivers notifications", async (t) => {
  const updates = [];
  const connection = client(t, { onRequest: async (method, params) => {
    assert.equal(method, "session/request_permission");
    assert.equal(params.sessionId, "session-1");
    return { outcome: { outcome: "selected", optionId: "no" } };
  } });
  connection.on("notification", (method, params) => updates.push(params.update));
  const result = await connection.request("session/prompt", { sessionId: "session-1", prompt: [{ type: "text", text: "hello" }] });
  assert.equal(result.stopReason, "end_turn");
  assert.deepEqual(updates.at(-1).rawOutput, { outcome: { outcome: "selected", optionId: "no" } });
});

test("dispose kills a process that ignores EOF and SIGTERM", { timeout: 5000 }, async (t) => {
  const connection = new AcpClient(process.execPath, [path.join(__dirname, "fixtures/agent.cjs"), "stubborn"], { cwd: __dirname });
  t.after(() => connection.child.kill("SIGKILL"));
  await connection.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
  const closed = new Promise((resolve) => connection.child.once("close", (code, signal) => resolve({ code, signal })));
  connection.dispose();
  connection.dispose();
  assert.equal((await closed).signal, "SIGKILL");
});
