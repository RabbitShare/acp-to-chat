"use strict";

const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
let output = Promise.resolve();
const send = (message, splitUtf8 = false) => {
  output = output.then(() => new Promise((resolve) => {
    const bytes = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
    const split = splitUtf8 ? bytes.indexOf(Buffer.from("🌍")) + 1 : bytes.length;
    process.stdout.write(bytes.subarray(0, split));
    setImmediate(() => {
      process.stdout.write(bytes.subarray(split));
      resolve();
    });
  }));
};
const pending = new Map();
const permissions = new Map();
const workingDirectories = new Map();
let sessionCount = 0;
let firstEcho;
let callbackRequestId;
const scenario = process.argv[2];
if (scenario === "stubborn") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
}

lines.on("line", (line) => {
  const message = JSON.parse(line);

  if (message.method === "initialize") {
    if (scenario === "initialize-null" || scenario === "initialize-invalid") {
      send({ id: message.id, result: scenario === "initialize-null" ? null : { protocolVersion: "1" } });
      return;
    }
    if (scenario === "invalid-load-capability") {
      send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: "true" } } });
      return;
    }
    send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  } else if (message.method === "echo") {
    const reply = { id: message.id, result: { text: "Hello 🌍", params: message.params } };
    if (message.params.n === 1) firstEcho = reply;
    else if (message.params.n === 2) {
      send(reply, true);
      send(firstEcho, true);
    } else send(reply, true);
  } else if (message.method === "fail") {
    send({ id: message.id, error: { code: -32000, message: "agent failure" } });
  } else if (message.method === "exit") {
    process.exit(3);
  } else if (message.method === "invalid") {
    process.stdout.write("not json\n");
  } else if (message.method === "invalid-request-id") {
    send({ id: {}, method: "client/callback", params: {} });
  } else if (message.method === "invalid-envelope") {
    process.stdout.write(JSON.stringify({ jsonrpc: "1.0", id: "unmatched", result: {} }) + "\n");
  } else if (message.method === "oversized") {
    send({ id: message.id, result: { text: "🌍".repeat(5 * 1024 * 1024) } });
  } else if (message.method === "stdout-eof") {
    process.stdout.end();
  } else if (message.method === "client-callback") {
    callbackRequestId = message.id;
    send({ id: "callback-1", method: "client/callback", params: {} });
  } else if (message.id === "callback-1") {
    send({ id: callbackRequestId, result: message });
  } else if (message.method === "session/new") {
    if (typeof message.params.cwd !== "string" || !require("node:path").isAbsolute(message.params.cwd)) {
      send({ id: message.id, error: { code: -32602, message: "cwd must be absolute" } });
      return;
    }
    if (scenario === "new-null" || scenario === "new-invalid") {
      send({ id: message.id, result: scenario === "new-null" ? null : { sessionId: 1 } });
      return;
    }
    const sessionId = `session-${++sessionCount}`;
    workingDirectories.set(sessionId, message.params.cwd);
    send({ id: message.id, result: { sessionId } });
    if (scenario === "crash-idle") setTimeout(() => process.exit(7), 100);
  } else if (message.method === "session/load") {
    send({ method: "session/update", params: { sessionId: message.params.sessionId, update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "previous question" } } } });
    send({ method: "session/update", params: { sessionId: message.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "previous answer" } } } });
    if (scenario === "tool-content-replay") send({ method: "session/update", params: { sessionId: message.params.sessionId, update: {
      sessionUpdate: "tool_call", toolCallId: "replayed-tool", title: "Validation", status: "completed", content: [
        { type: "content", _meta: { wrapper: "replayed" }, content: { type: "image", data: "replayed-image", mimeType: "image/png", uri: "file:///replayed-image", annotations: { audience: ["user"], priority: 0.75 }, _meta: { source: "history" } } },
        { type: "content", content: { type: "resource_link", uri: "file:///report", name: "report", title: "Validation result", description: "2 tests failed", mimeType: "text/plain", size: 10, annotations: null, _meta: null } },
      ],
    } } });
    send({ id: message.id, result: {} });
  } else if (message.method === "session/prompt") {
    const sessionId = message.params.sessionId;
    if (message.params.prompt[0].text === "__fail__") {
      send({ id: message.id, error: { code: -32000, message: "prompt failed" } });
      return;
    }
    const permissionId = `permission-${message.id}`;
    pending.set(sessionId, { id: message.id, cancelled: false });
    permissions.set(permissionId, sessionId);
    if (scenario === "malformed-updates") {
      for (const update of [
        { sessionUpdate: "agent_message_chunk", messageId: {}, content: { type: "text", text: "bad message ID" } },
        { sessionUpdate: "tool_call_update", toolCallId: "bad", name: 42 },
        { sessionUpdate: "tool_call_update", toolCallId: "bad", title: 42 },
        { sessionUpdate: "tool_call_update", toolCallId: "bad", kind: "invented" },
        { sessionUpdate: "tool_call_update", toolCallId: "bad", status: "invented" },
      ]) send({ method: "session/update", params: { sessionId, update } });
    }
    send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `answer:${message.params.prompt[0].text}` } } } });
    const permission = { sessionId, toolCall: { toolCallId: `tool-${sessionId}`, title: "Run command", rawInput: { command: "pwd" } }, options: [{ optionId: "yes", name: "Allow once", kind: "allow_once" }, { optionId: "no", name: "Reject", kind: "reject_once" }] };
    if (scenario === "malformed-permission-tool") permission.toolCall.toolCallId = 1;
    if (scenario === "malformed-permission-option") permission.options[0].name = null;
    if (scenario === "malformed-permission-title") permission.toolCall.title = 42;
    if (scenario === "malformed-permission-kind") permission.options[0].kind = "not-an-ACP-permission-kind";
    send({ id: permissionId, method: "session/request_permission", params: permission });
    if (scenario === "crash-prompt") setTimeout(() => process.exit(8), 100);
  } else if (message.method === "session/cancel") {
    const turn = pending.get(message.params.sessionId);
    if (turn) turn.cancelled = true;
  } else if (permissions.has(message.id) && message.result) {
    const sessionId = permissions.get(message.id);
    const turn = pending.get(sessionId);
    if (scenario === "ignore-cancel" && turn?.cancelled) return;
    send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "tool_call", toolCallId: `tool-${sessionId}`, title: "Run command", status: "completed", rawOutput: message.result } } });
    if (turn) send({ id: turn.id, result: { stopReason: turn.cancelled ? "cancelled" : "end_turn", _meta: { permission: message.result, cwd: workingDirectories.get(sessionId) } } });
    pending.delete(sessionId);
    permissions.delete(message.id);
  }
});
