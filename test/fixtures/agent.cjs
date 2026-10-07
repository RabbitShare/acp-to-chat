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
const configurations = new Map();
const traffic = [];
const templateHistory = new Map();
let heldConfig;
let nextConfigResponse;
let replayPermission;
function catalog(cwd) {
  const suffix = require("node:path").basename(cwd);
  return [
    { id: "model", name: "Model", type: "select", category: "model", currentValue: `provider/${suffix}/initial`, options: [
      { value: `provider/${suffix}/initial`, name: "Initial" },
      { value: `provider/${suffix}/reasoning/extra`, name: "Reasoning model" },
      { value: `provider/${suffix}/plain`, name: "Plain model" },
    ] },
    { id: "mode", name: "Agent", type: "select", category: "mode", currentValue: "workspace-agent", options: [
      { value: "workspace-agent", name: "Workspace agent" }, { value: "custom-agent", name: "Custom agent" },
    ] },
    { id: "effort", name: "Reasoning", type: "select", category: "thought_level", currentValue: "default", options: [
      { value: "default", name: "Default" }, { value: "unusual-variant", name: "Unusual" },
    ] },
  ];
}
function configResult(options, phase) {
  if (!scenario?.startsWith("config")) return {};
  if (scenario === "config-null") return { configOptions: null };
  if (scenario === `config-malformed-${phase}`) return { configOptions: [{ ...options[0], category: 42 }] };
  return { configOptions: options };
}
function commandCatalog(cwd) {
  return [{ name: "compact", description: "Compact the session" },
    { name: `review-${require("node:path").basename(cwd)}`, description: "Review project", input: { hint: "files to review" } }];
}
function commandUpdate(sessionId, availableCommands) {
  send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "available_commands_update", availableCommands } } });
}
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
  if (message.method) traffic.push({ method: message.method, params: message.params });

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
    if (message.params.control === "update-commands") {
      commandUpdate(message.params.sessionId, message.params.availableCommands);
      send({ id: message.id, result: {} });
      return;
    }
    if (message.params.control === "next-config-response") {
      nextConfigResponse = message.params.result;
      send({ id: message.id, result: {} });
      return;
    }
    if (message.params.control === "update-config") {
      send({ method: "session/update", params: { sessionId: message.params.sessionId, update: { sessionUpdate: "config_option_update", configOptions: message.params.configOptions } } });
      send({ id: message.id, result: {} });
      return;
    }
    if (message.params.control === "stats") {
      send({ id: message.id, result: { traffic, replayPermission } });
      return;
    }
    if (message.params.control === "release-config") {
      heldConfig?.();
      heldConfig = undefined;
      send({ id: message.id, result: {} });
      return;
    }
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
  } else if (message.id === "replay-permission") {
    replayPermission = message.result;
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
    const options = catalog(message.params.cwd);
    configurations.set(sessionId, options);
    if (scenario === "commands-buffer-limit") {
      const commands = Array.from({ length: 120 }, (_, index) => ({ name: String(index), description: "x".repeat(2048) }));
      for (let index = 0; index < 4; index++) commandUpdate(`unknown-${index}`, commands);
      commandUpdate(sessionId, commands);
    } else if (scenario?.startsWith("commands") && scenario !== "commands-after-new") commandUpdate(sessionId, commandCatalog(message.params.cwd));
    send({ id: message.id, result: { sessionId, ...configResult(options, "new") } });
    if (scenario === "commands-after-new") commandUpdate(sessionId, commandCatalog(message.params.cwd));
    if (scenario === "crash-idle") setTimeout(() => process.exit(7), 100);
  } else if (message.method === "session/load") {
    workingDirectories.set(message.params.sessionId, message.params.cwd);
    const options = configurations.get(message.params.sessionId) ?? catalog(message.params.cwd);
    configurations.set(message.params.sessionId, options);
    if (scenario?.startsWith("commands") && scenario !== "commands-no-load") commandUpdate(message.params.sessionId, commandCatalog(message.params.cwd));
    if (scenario === "commands-load-error") {
      send({ id: message.id, error: { code: -32000, message: "load failed after commands" } });
      return;
    }
    if (scenario === "commands-template-replay") {
      for (const text of templateHistory.get(message.params.sessionId) ?? []) {
        send({ method: "session/update", params: { sessionId: message.params.sessionId, update: { sessionUpdate: "user_message_chunk", content: { type: "text", text } } } });
        send({ method: "session/update", params: { sessionId: message.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `answer:${text}` } } } });
      }
      send({ id: message.id, result: configResult(options, "load") });
      return;
    }
    send({ method: "session/update", params: { sessionId: message.params.sessionId, update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "previous question" } } } });
    send({ method: "session/update", params: { sessionId: message.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "previous answer" } } } });
    if (scenario === "config-recovery-replay") {
      send({ method: "session/update", params: { sessionId: message.params.sessionId, update: { sessionUpdate: "tool_call", toolCallId: "replayed-tool", title: "Replayed tool", status: "completed" } } });
      send({ id: "replay-permission", method: "session/request_permission", params: { sessionId: message.params.sessionId, toolCall: { toolCallId: "replayed-tool", title: "Never execute during replay" }, options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }] } });
    }
    if (scenario === "tool-content-replay") send({ method: "session/update", params: { sessionId: message.params.sessionId, update: {
      sessionUpdate: "tool_call", toolCallId: "replayed-tool", title: "Validation", status: "completed", content: [
        { type: "content", _meta: { wrapper: "replayed" }, content: { type: "image", data: "replayed-image", mimeType: "image/png", uri: "file:///replayed-image", annotations: { audience: ["user"], priority: 0.75 }, _meta: { source: "history" } } },
        { type: "content", content: { type: "resource_link", uri: "file:///report", name: "report", title: "Validation result", description: "2 tests failed", mimeType: "text/plain", size: 10, annotations: null, _meta: null } },
      ],
    } } });
    send({ id: message.id, result: configResult(options, "load") });
  } else if (message.method === "session/set_config_option") {
    const { sessionId, configId, value } = message.params;
    let options = configurations.get(sessionId);
    const selected = options?.find((option) => option.id === configId);
    if (!selected || !selected.options.some((option) => option.value === value)) {
      send({ id: message.id, error: { code: -32602, message: "invalid configuration selection" } });
      return;
    }
    selected.currentValue = value;
    if (configId === "model") {
      options = options.filter((option) => option.id !== "effort");
      if (value.includes("/reasoning/")) options.push({ id: "effort", name: "Reasoning", type: "select", currentValue: "removed-current", options: [{ value: "default", name: "Default" }, { value: "deep-custom", name: "Deep" }] });
      configurations.set(sessionId, options);
    }
    const reply = () => {
      if (nextConfigResponse !== undefined) {
        send({ id: message.id, result: nextConfigResponse });
        nextConfigResponse = undefined;
      }
      else if (scenario === "config-delayed-error") send({ id: message.id, error: { code: -32000, message: "configuration failed after mutation" } });
      else if (scenario === "config-delayed-malformed") send({ id: message.id, result: { configOptions: [{ ...options[0], description: 42 }] } });
      else {
        send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "config_option_update", configOptions: options } } });
        send({ id: message.id, result: { configOptions: options } });
      }
    };
    if (scenario?.startsWith("config-delayed")) {
      heldConfig = reply;
      send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "session_info_update", title: "Configuration pending" }, _meta: { fixture: "config_pending" } } });
    } else reply();
  } else if (message.method === "session/prompt") {
    const sessionId = message.params.sessionId;
    if (scenario === "commands-template-replay") {
      const history = templateHistory.get(sessionId) ?? [];
      history.push(message.params.prompt[0].text);
      templateHistory.set(sessionId, history);
    }
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
