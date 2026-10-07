"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { Writable } = require("node:stream");
const { AcpClient } = require("../dist/acp");
const { $defs: protocolSchemas } = require("@agentclientprotocol/sdk/schema/schema.json");

// Evaluate only the JSON Schema keywords used by these wire fixtures. This uses
// the public, pinned SDK schema, not copies of ACP fields or private Zod exports.
function matchesSchema(value, schema) {
  if (schema.$ref) return matchesSchema(value, protocolSchemas[schema.$ref.slice("#/$defs/".length)]);
  if (schema.allOf && !schema.allOf.every((part) => matchesSchema(value, part))) return false;
  if (schema.anyOf && !schema.anyOf.some((part) => matchesSchema(value, part))) return false;
  if (schema.oneOf && schema.oneOf.filter((part) => matchesSchema(value, part)).length !== 1) return false;
  if ("const" in schema && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type) {
    const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    const types = [].concat(schema.type);
    if (!types.includes(type) && !(types.includes("integer") && Number.isInteger(value))) return false;
  }
  if (typeof value === "number" && ((schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum))) return false;
  if (Array.isArray(value) && schema.items && !value.every((item) => matchesSchema(item, schema.items))) return false;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (schema.required?.some((key) => !Object.hasOwn(value, key))) return false;
    for (const [key, field] of Object.entries(value)) {
      if (schema.properties?.[key] && !matchesSchema(field, schema.properties[key])) return false;
      if (schema.additionalProperties === false && !schema.properties?.[key]) return false;
    }
  }
  return true;
}

function assertProtocolPayload(value, name) {
  const schema = protocolSchemas[name];
  assert.ok(matchesSchema(value, schema), `${name} must match the official SDK wire schema before normalization`);
  const variants = (schema.anyOf ?? []).filter((part) => matchesSchema(value, part));
  assert.ok(Object.keys(value).every((key) => Object.hasOwn(schema.properties, key) ||
    variants.some((part) => Object.hasOwn(part.properties ?? {}, key))), `${name}: test-only fields belong in _meta`);
}

function client(t, options = {}) {
  assert.equal(typeof AcpClient, "function", "ACP transport is not implemented");
  const connection = new AcpClient(process.execPath, [path.join(__dirname, "fixtures/agent.cjs")], { cwd: __dirname, ...options });
  t.after(() => connection.dispose());
  return connection;
}

test("correlates concurrent responses received out of order", async (t) => {
  const connection = client(t);
  const [first, second] = await Promise.all([connection.requestExtension("echo", { n: 1 }), connection.requestExtension("echo", { n: 2 })]);
  assert.deepEqual(first, { text: "Hello 🌍", params: { n: 1 } });
  assert.deepEqual(second, { text: "Hello 🌍", params: { n: 2 } });
});

test("decodes a UTF-8 character split across writes", async (t) => {
  const result = await client(t).requestExtension("echo", { n: 3 });
  assert.equal(result.text, "Hello 🌍");
});

test("surfaces remote request errors with method context", async (t) => {
  await assert.rejects(client(t).requestExtension("fail", {}), /fail.*agent failure/);
});

test("rejects outstanding requests when the process exits", async (t) => {
  await assert.rejects(client(t).requestExtension("exit", {}), /exit.*3/);
});

test("fails closed on malformed stdout", async (t) => {
  await assert.rejects(client(t).requestExtension("invalid", {}), /protocol|JSON/i);
});

test("boundary rejects a valid JSON request with an invalid ID before the callback", { timeout: 2000 }, async (t) => {
  let calls = 0;
  const connection = client(t, { onRequest: () => { calls++; } });
  await assert.rejects(connection.requestExtension("invalid-request-id", {}, 500), /\[AcpClient.receive\] Invalid request id/);
  assert.equal(calls, 0);
});

test("boundary sends a method-context wire error when a client callback throws non-Error", async (t) => {
  const connection = client(t, { onRequest: (method) => {
    assert.equal(method, "client/callback");
    throw "callback failed";
  } });
  assert.deepEqual(await connection.requestExtension("client-callback", {}), {
    jsonrpc: "2.0", id: "callback-1",
    error: { code: -32601, message: "[AcpClient.answer] method=client/callback: callback failed" },
  });
});

test("times out a stalled request", async (t) => {
  await assert.rejects(client(t).requestExtension("hang", {}, 100), /hang.*timed out/);
});

test("timeout closes the shared connection and settles other pending requests", { timeout: 2000 }, async (t) => {
  const connection = client(t);
  let failures = 0;
  connection.on("failure", () => failures++);
  const other = connection.requestExtension("hang", {}, 0);
  const otherResult = other.then(() => undefined, (error) => error);
  await assert.rejects(connection.requestExtension("hang", {}, 100), /hang.*timed out/);
  assert.ok(connection.failure, "deadline must close the SDK connection, not only race its promise");
  assert.match((await otherResult).message, /hang.*timed out/);
  await assert.rejects(connection.requestExtension("echo", { n: 3 }), /timed out/);
  assert.equal(failures, 1);
});

test("rejects a response with a wrong JSON-RPC envelope without waiting for deadline", { timeout: 2000 }, async (t) => {
  const connection = client(t);
  await assert.rejects(connection.requestExtension("invalid-envelope", {}, 500), /envelope|protocol/i);
  assert.ok(connection.failure);
});

test("limits an incoming message to 16 MiB of bytes, not UTF-16 characters", { timeout: 5000 }, async (t) => {
  const connection = client(t);
  await assert.rejects(connection.requestExtension("oversized", {}, 2000), /16 MiB|16777216/);
  assert.ok(connection.failure);
});

test("unexpected stdout EOF settles a request even when the process stays alive", { timeout: 2000 }, async (t) => {
  const connection = client(t);
  await assert.rejects(connection.requestExtension("stdout-eof", {}, 500), /EOF/);
  assert.ok(connection.failure);
});

test("answers permission requests explicitly and delivers notifications", async (t) => {
  const updates = [];
  const connection = client(t, { onRequest: async (method, params) => {
    assert.equal(method, "session/request_permission");
    assert.equal(params.sessionId, "session-1");
    return { outcome: { outcome: "selected", optionId: "no" } };
  } });
  connection.on("notification", (method, params) => updates.push(params.update));
  await connection.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
  const { sessionId } = await connection.request("session/new", { cwd: __dirname, mcpServers: [] });
  const result = await connection.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "hello" }] });
  assert.equal(result.stopReason, "end_turn");
  assert.deepEqual(updates.at(-1).rawOutput, { outcome: { outcome: "selected", optionId: "no" } });
});

test("independent fixture standard traffic matches public SDK 1.7 schemas with test data in metadata", async (t) => {
  const received = [];
  const sent = [];
  const connection = client(t, { onRequest: async (method, params) => {
    assert.equal(method, "session/request_permission");
    assertProtocolPayload(params, "RequestPermissionRequest");
    const result = { outcome: { outcome: "selected", optionId: "yes" } };
    assertProtocolPayload(result, "RequestPermissionResponse");
    return result;
  } });
  const write = connection.child.stdin.write;
  t.mock.method(connection.child.stdin, "write", function (bytes, ...args) {
    sent.push(JSON.parse(Buffer.from(bytes).toString()));
    return write.call(this, bytes, ...args);
  });
  connection.on("notification", (method, params) => {
    assert.equal(method, "session/update");
    assertProtocolPayload(params, "SessionNotification");
    received.push(params);
  });
  const initialized = await connection.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
  assertProtocolPayload(initialized, "InitializeResponse");
  const created = await connection.request("session/new", { cwd: __dirname, mcpServers: [] });
  assertProtocolPayload(created, "NewSessionResponse");
  const loaded = await connection.request("session/load", { sessionId: created.sessionId, cwd: __dirname, mcpServers: [] });
  assertProtocolPayload(loaded, "LoadSessionResponse");
  const result = await connection.request("session/prompt", { sessionId: created.sessionId, prompt: [{ type: "text", text: "schema control" }] });
  assertProtocolPayload(result, "PromptResponse");
  assert.deepEqual(result._meta.permission, { outcome: { outcome: "selected", optionId: "yes" } });
  assert.equal(result._meta.cwd, __dirname);
  assert.equal(received.length, 4, "load replay and prompt text/tool must all reach the client");
  for (const [method, name] of [["initialize", "InitializeRequest"], ["session/new", "NewSessionRequest"], ["session/load", "LoadSessionRequest"], ["session/prompt", "PromptRequest"]]) {
    assertProtocolPayload(sent.find((message) => message.method === method).params, name);
  }
  // Negative controls prove that required fields and enum/nested content guards
  // fail instead of passing solely because SDK result types look correct.
  for (const [name, value] of [["InitializeResponse", { protocolVersion: "1" }], ["NewSessionResponse", {}], ["PromptResponse", { stopReason: "invented" }], ["SessionNotification", { sessionId: "s", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: 1 } } }]]) {
    assert.equal(matchesSchema(value, protocolSchemas[name]), false);
  }
});

test("independent fixture tool-content replay matches public SDK 1.7 schemas", async (t) => {
  const connection = new AcpClient(process.execPath, [path.join(__dirname, "fixtures/agent.cjs"), "tool-content-replay"], { cwd: __dirname });
  t.after(() => connection.dispose());
  const updates = [];
  connection.on("notification", (method, params) => {
    assert.equal(method, "session/update");
    assertProtocolPayload(params, "SessionNotification");
    updates.push(params.update);
  });
  await connection.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
  await connection.request("session/load", { sessionId: "saved-tool-content", cwd: __dirname, mcpServers: [] });
  assert.equal(updates.length, 3);
  const tool = updates.at(-1);
  assert.equal(tool.sessionUpdate, "tool_call");
  assert.equal("rawOutput" in tool, false);
  assert.equal(tool.content[0].content.uri, "file:///replayed-image");
  assert.equal(tool.content[1].content.description, "2 tests failed");
  for (const [name, value] of [
    ["ImageContent", { data: 42, mimeType: "image/png", uri: "file:///image" }],
    ["ResourceLink", { uri: "file:///report", name: "report", size: 1.5 }],
    ["Annotations", { audience: ["system"] }],
    ["Annotations", { priority: "high" }],
    ["Annotations", { _meta: [] }],
  ]) assert.equal(matchesSchema(value, protocolSchemas[name]), false);
});

test("independent fixture config new/load/set/update traffic matches public SDK 1.7 schemas", async (t) => {
  const connection = new AcpClient(process.execPath, [path.join(__dirname, "fixtures/agent.cjs"), "config"], { cwd: __dirname });
  t.after(() => connection.dispose());
  const updates = [];
  const sent = [];
  const write = connection.child.stdin.write;
  t.mock.method(connection.child.stdin, "write", function (bytes, ...args) {
    sent.push(JSON.parse(Buffer.from(bytes).toString()));
    return write.call(this, bytes, ...args);
  });
  connection.on("notification", (method, params) => {
    assert.equal(method, "session/update");
    assertProtocolPayload(params, "SessionNotification");
    updates.push(params.update);
  });
  await connection.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
  const created = await connection.request("session/new", { cwd: __dirname, mcpServers: [] });
  assertProtocolPayload(created, "NewSessionResponse");
  const loaded = await connection.request("session/load", { sessionId: created.sessionId, cwd: __dirname, mcpServers: [] });
  assertProtocolPayload(loaded, "LoadSessionResponse");
  const changed = await connection.request("session/set_config_option", { sessionId: created.sessionId, configId: "model", value: "provider/test/reasoning/extra" });
  assertProtocolPayload(changed, "SetSessionConfigOptionResponse");
  assertProtocolPayload(sent.find((message) => message.method === "session/set_config_option").params, "SetSessionConfigOptionRequest");
  assert.equal(created.configOptions[2].currentValue, "default");
  assert.equal(changed.configOptions[2].currentValue, "removed-current");
  assert.deepEqual(updates.at(-1), { sessionUpdate: "config_option_update", configOptions: changed.configOptions });
  for (const [name, value] of [
    ["SetSessionConfigOptionResponse", {}],
    ["SessionConfigOption", { id: "model", name: "Model", type: "select", currentValue: "one", options: [{ value: "one", name: "One", description: 42 }] }],
    ["SessionNotification", { sessionId: "s", update: { sessionUpdate: "config_option_update", configOptions: null } }],
  ]) assert.equal(matchesSchema(value, protocolSchemas[name]), false);
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

for (const [method, expected] of [
  ["invalid", /protocol|JSON/i],
  ["invalid-request-id", /Invalid request id/],
  ["invalid-envelope", /envelope|protocol/i],
  ["oversized", /16 MiB|16777216/],
  ["stdout-eof", /EOF/],
  ["exit", /exit.*3/],
]) {
  test(`lifecycle ${method} closes all pending requests once and releases byte writer`, { timeout: 5000 }, async (t) => {
    const toWeb = Writable.toWeb;
    let output;
    t.mock.method(Writable, "toWeb", (...args) => (output = toWeb(...args)));
    const connection = client(t);
    const failures = [];
    const writes = [];
    const write = connection.child.stdin.write;
    t.mock.method(connection.child.stdin, "write", function (chunk, ...args) {
      writes.push(Buffer.from(chunk).toString());
      return write.call(this, chunk, ...args);
    });
    connection.on("failure", (error) => failures.push(error));
    const closed = new Promise((resolve) => connection.child.once("close", resolve));
    const pending = connection.requestExtension("hang", {}, 0);
    const failed = connection.requestExtension(method, {}, 0);
    const results = await Promise.allSettled([pending, failed]);
    for (const result of results) {
      assert.equal(result.status, "rejected");
      assert.match(result.reason.message, expected);
    }
    await closed;
    await new Promise(setImmediate);
    assert.equal(failures.length, 1);
    assert.equal(output.locked, false);
    assert.equal(connection.child.listenerCount("close"), 1, "EOF/dispose listeners must be removed");
    assert.equal(writes.some((bytes) => bytes.includes('"id":null')), false, "SDK protocol errors must fail closed before forwarding bytes");
  });
}

test("lifecycle async write rejection closes every pending request once", { timeout: 2000 }, async (t) => {
  const toWeb = Writable.toWeb;
  let byteOutput;
  t.mock.method(Writable, "toWeb", (...args) => {
    const output = toWeb(...args);
    byteOutput = new WritableStream({ write: async (bytes) => {
      if (new TextDecoder().decode(bytes).includes('"method":"session/cancel"')) {
        await new Promise(setImmediate);
        throw new Error("injected byte write failure");
      }
      const writer = output.getWriter();
      try { await writer.write(bytes); } finally { writer.releaseLock(); }
    } });
    return byteOutput;
  });
  const connection = client(t);
  await connection.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
  const failures = [];
  connection.on("failure", (error) => failures.push(error));
  const pending = connection.requestExtension("hang", {}, 0);
  const result = pending.then(() => undefined, (error) => error);
  const closed = new Promise((resolve) => connection.child.once("close", resolve));
  await assert.rejects(connection.notify("session/cancel", { sessionId: "session-1" }), /write failure/);
  assert.match((await result).message, /write failure/);
  await closed;
  assert.equal(failures.length, 1);
  assert.equal(byteOutput.locked, false, "Rejected byte write must release its writer");
});

test("lifecycle voluntary dispose rejects pending work without an unexpected crash", { timeout: 2000 }, async (t) => {
  const connection = client(t);
  await connection.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
  const failures = [];
  connection.on("failure", (error) => failures.push({ error, disposing: connection.disposing }));
  const pending = connection.requestExtension("hang", {}, 0);
  const result = pending.then(() => undefined, (error) => error);
  const closed = new Promise((resolve) => connection.child.once("close", resolve));
  connection.dispose();
  connection.dispose();
  assert.match((await result).message, /Connection closed/);
  await closed;
  assert.equal(failures.length, 1);
  assert.equal(failures[0].disposing, true);
});

for (const [method, expected] of [["exit", /exit.*3/], ["stdout-eof", /EOF/]]) {
  test(`lifecycle ${method} SDK/child close race clears deadline and disposal timers`, { timeout: 2000 }, async (t) => {
    const scheduled = new Map();
    const delays = [];
    const schedule = global.setTimeout;
    const clear = global.clearTimeout;
    t.mock.method(global, "setTimeout", (callback, delay, ...args) => {
      const timer = schedule(() => { scheduled.delete(timer); callback(...args); }, delay);
      scheduled.set(timer, delay);
      delays.push(delay);
      return timer;
    });
    t.mock.method(global, "clearTimeout", (timer) => { scheduled.delete(timer); clear(timer); });
    const connection = client(t);
    const closed = new Promise((resolve) => connection.child.once("close", resolve));
    await assert.rejects(connection.requestExtension(method, {}, 1000), expected);
    await closed;
    await new Promise(setImmediate);
    assert.deepEqual([...scheduled.values()], [], "race must not retain EOF/deadline/SIGTERM/SIGKILL timers");
    assert.equal(connection.child.listenerCount("close"), 1);
    if (method === "stdout-eof") {
      assert.ok(delays.includes(100), "Live process EOF must use bounded child-close coordination");
      assert.ok(delays.includes(2000) && delays.includes(3000), "Disposal timers must be exercised before checking cleanup");
    }
  });
}

for (const [stream, expected] of [["stdin", /AcpClient.write/], ["stdout", /AcpClient.receive/]]) {
  test(`lifecycle ${stream} error fails all pending work once`, { timeout: 2000 }, async (t) => {
    const connection = client(t);
    await connection.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    const failures = [];
    connection.on("failure", (error) => failures.push(error));
    const pending = [connection.requestExtension("hang", {}, 0), connection.requestExtension("hang", {}, 0)];
    const settled = Promise.allSettled(pending);
    const closed = new Promise((resolve) => connection.child.once("close", resolve));
    connection.child[stream].destroy(new Error(`injected ${stream} failure`));
    for (const result of await settled) {
      assert.equal(result.status, "rejected");
      assert.match(result.reason.message, expected);
    }
    await closed;
    assert.equal(failures.length, 1);
  });
}

test("lifecycle spawn failure retains executable and cwd context", { timeout: 2000 }, async (t) => {
  const command = path.join(__dirname, "fixtures", "missing-executable");
  const connection = new AcpClient(command, ["acp"], { cwd: __dirname });
  t.after(() => connection.dispose());
  const failures = [];
  connection.on("failure", (error) => failures.push(error));
  const settled = await Promise.allSettled([
    connection.requestExtension("hang", {}, 0), connection.requestExtension("hang", {}, 0),
  ]);
  for (const result of settled) {
    assert.equal(result.status, "rejected");
    assert.ok(result.reason.message.includes(`command=${command} cwd=${__dirname}`));
  }
  assert.equal(failures.length, 1);
});
