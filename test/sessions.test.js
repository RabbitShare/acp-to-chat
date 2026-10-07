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

test("template preparation Stop before submission never sends cancel or history", async (t) => {
  const backend = sessions(t);
  const record = await backend.create(__dirname);
  const stop = new AbortController();
  let entered, release;
  const ready = new Promise((resolve) => { entered = resolve; });
  const prepared = new Promise((resolve) => { release = resolve; });
  const send = backend.prompt(record, "/review question", stop.signal, () => {}, () => {}, async () => { entered(); return prepared; });
  await ready;
  assert.ok(record.turn);
  stop.abort();
  release("Expanded question");
  assert.equal((await send).stopReason, "cancelled");
  assert.deepEqual(record.history, []);
  assert.equal(record.turn, undefined);
  const { traffic } = await backend.client.requestExtension("echo", { control: "stats" });
  assert.equal(traffic.filter((entry) => ["session/prompt", "session/cancel"].includes(entry.method)).length, 0);
});

test("template preparation reserves the prompt slot against another Send and config setter", async (t) => {
  const backend = sessions(t);
  const record = await backend.create(__dirname);
  let entered, release;
  const ready = new Promise((resolve) => { entered = resolve; });
  const prepared = new Promise((resolve) => { release = resolve; });
  t.after(() => release('Review question'));
  const send = backend.prompt(record, '/review question', new AbortController().signal, () => {}, () => {}, async () => { entered(); return prepared; });
  await ready;
  await assert.rejects(backend.prompt(record, 'other', new AbortController().signal, () => {}), /already active/);
  await assert.rejects(backend.setConfigOption(record, 'mode', 'custom-agent', record.configRevision), /already active/);
  release('Review question');
  await send;
  assert.equal(record.turn, undefined);
});

test("template preparation rechecks references synchronously after async expansion without adding a turn", async (t) => {
  const backend = sessions(t);
  const record = await backend.create(__dirname);
  let revoked = false;
  await assert.rejects(backend.prompt(record, "/review question", new AbortController().signal, () => {}, () => {
    assert.ok(revoked, "Must run after template expansion");
    throw new Error("revoked reference");
  }, async () => { revoked = true; return "Expanded question"; }), /revoked reference/);
  assert.deepEqual(record.history, []);
  assert.equal(record.turn, undefined);
  const { traffic } = await backend.client.requestExtension("echo", { control: "stats" });
  assert.equal(traffic.filter((entry) => entry.method === "session/prompt").length, 0);
});

for (const scenario of ["commands", "commands-after-new"]) test(`commands retain new notifications (${scenario})`, async (t) => {
  const backend = sessions(t, undefined, scenario);
  const record = await backend.create(__dirname);
  await backend.client.requestExtension("echo", { control: "stats" });
  assert.deepEqual(record.availableCommands, [{ name: "compact", description: "Compact the session" },
    { name: "review-test", description: "Review project", input: { hint: "files to review" } }]);
});

test("commands isolate concurrent new catalogs by cwd", async (t) => {
  const backend = sessions(t, undefined, "commands");
  const [first, second] = await Promise.all([backend.create(__dirname), backend.create(path.join(__dirname, "fixtures"))]);
  assert.equal(first.availableCommands[1].name, "review-test");
  assert.equal(second.availableCommands[1].name, "review-fixtures");
});

test("commands retain metadata advertised during load", async (t) => {
  const backend = sessions(t, undefined, "commands");
  const loaded = await backend.load({ id: "saved", cwd: path.join(__dirname, "fixtures") });
  assert.deepEqual(loaded.availableCommands, [{ name: "compact", description: "Compact the session" },
    { name: "review-fixtures", description: "Review project", input: { hint: "files to review" } }]);
});

test("commands replace a snapshot with projected metadata", async (t) => {
  const backend = sessions(t, undefined, "commands");
  const record = await backend.create(__dirname);
  const replacement = [{ name: "custom", description: "$(zap) [link](command:evil)", input: null, _meta: { secret: "ignored" } }];
  await backend.client.requestExtension("echo", { control: "update-commands", sessionId: record.id, availableCommands: replacement });
  assert.deepEqual(record.availableCommands, [{ name: "custom", description: "$(zap) [link](command:evil)", input: null }]);
});

test("commands reject malformed snapshots atomically", async (t) => {
  const backend = sessions(t, undefined, "commands");
  const record = await backend.create(__dirname);
  const before = structuredClone(record.availableCommands);
  const duplicate = { name: "custom", description: "Valid" };
  for (const availableCommands of [undefined, null, {}, [null], [{ name: "", description: "bad" }],
    [{ name: "bad", description: 42 }], [{ name: "bad", description: "bad", input: {} }],
    [{ name: "bad", description: "bad", input: { hint: false } }], [duplicate, duplicate],
    [{ name: "valid", description: "valid" }, { name: "invalid" }]]) {
    backend.update({ sessionId: record.id, update: { sessionUpdate: "available_commands_update", availableCommands } });
    assert.deepEqual(record.availableCommands, before);
  }
});

test("commands reject raw malformed optional input before SDK salvage", async (t) => {
  const backend = sessions(t, undefined, "commands");
  const record = await backend.create(__dirname);
  const before = structuredClone(record.availableCommands);
  await backend.client.requestExtension("echo", { control: "update-commands", sessionId: record.id,
    availableCommands: [{ name: "custom", description: "bad optional input", input: { hint: false } }] });
  assert.deepEqual(record.availableCommands, before, "Raw malformed input cannot be salvaged into a replacement");
});

test("commands never materialize unknown sessions outside new", async (t) => {
  const backend = sessions(t, undefined, "commands");
  backend.update({ sessionId: "unknown", update: { sessionUpdate: "available_commands_update", availableCommands: [] } });
  assert.equal(backend.records.has("unknown"), false);
});

test("commands clear on an empty live catalog and emit refresh", async (t) => {
  const backend = sessions(t, undefined, "commands");
  const record = await backend.create(__dirname);
  const events = [];
  backend.on("commands", (changed) => events.push(changed.id));
  await backend.client.requestExtension("echo", { control: "update-commands", sessionId: record.id, availableCommands: [] });
  assert.deepEqual(record.availableCommands, []);
  assert.deepEqual(events, [record.id]);
});

test("commands metadata never enters conversation history", async (t) => {
  const backend = sessions(t, undefined, "commands");
  const record = await backend.create(__dirname);
  await backend.client.requestExtension("echo", { control: "update-commands", sessionId: record.id,
    availableCommands: [{ name: "live", description: "Live" }] });
  assert.deepEqual(record.history, []);
});

test("commands metadata never reaches the active turn renderer", async (t) => {
  const backend = sessions(t, undefined, "commands");
  const record = await backend.create(__dirname);
  const updates = [];
  record.turn = { controller: new AbortController(), onUpdate: (update) => updates.push(update) };
  await backend.client.requestExtension("echo", { control: "update-commands", sessionId: record.id,
    availableCommands: [{ name: "live", description: "Live" }] });
  assert.deepEqual(updates, []);
  record.turn = undefined;
});

test("commands clear on connection failure", async (t) => {
  const backend = sessions(t, undefined, "commands-no-load");
  const record = await backend.create(__dirname);
  assert.ok(record.availableCommands.length);
  backend.client.dispose();
  assert.deepEqual(record.availableCommands, []);
});

test("commands notify consumers after buffered new metadata belongs to a known record", async (t) => {
  const backend = sessions(t, undefined, "commands");
  const observed = [];
  backend.on("commands", (record) => {
    assert.equal(backend.records.get(record.id), record);
    observed.push(record.availableCommands.map((command) => command.name));
  });
  await backend.create(__dirname);
  assert.deepEqual(observed, [["compact", "review-test"]]);
});

for (const [limit, availableCommands] of [
  ["count", Array.from({ length: 513 }, (_, index) => ({ name: String(index), description: "" }))],
  ["name", [{ name: "x".repeat(257), description: "" }]],
  ["description", [{ name: "review", description: "x".repeat(8193) }]],
  ["hint", [{ name: "review", description: "", input: { hint: "x".repeat(2049) } }]],
  ["UTF-8 bytes", Array.from({ length: 512 }, (_, index) => ({ name: String(index), description: "🌍".repeat(256) }))],
]) test(`commands reject oversized ${limit} atomically before native amplification`, async (t) => {
  const backend = sessions(t, undefined, "commands");
  const record = await backend.create(__dirname);
  const before = structuredClone(record.availableCommands);
  let events = 0;
  backend.on("commands", () => events++);
  backend.update({ sessionId: record.id, update: { sessionUpdate: "available_commands_update", availableCommands } });
  assert.deepEqual(record.availableCommands, before);
  assert.equal(events, 0);
});

test("commands reject oversized advertisements through SDK traffic", async (t) => {
  const backend = sessions(t, undefined, "commands");
  const record = await backend.create(__dirname);
  const before = structuredClone(record.availableCommands);
  await backend.client.requestExtension("echo", { control: "update-commands", sessionId: record.id,
    availableCommands: Array.from({ length: 513 }, (_, index) => ({ name: String(index), description: "" })) });
  assert.deepEqual(record.availableCommands, before);
});

for (const availableCommands of [
  Array.from({ length: 512 }, (_, index) => ({ name: String(index), description: "" })),
  [{ name: "x".repeat(256), description: "x".repeat(8192), input: { hint: "x".repeat(2048) } }],
]) test(`commands accept metadata at supported ${availableCommands.length === 512 ? "count" : "field"} limits`, async (t) => {
  const backend = sessions(t, undefined, "commands");
  const record = await backend.create(__dirname);
  await backend.client.requestExtension("echo", { control: "update-commands", sessionId: record.id, availableCommands });
  assert.deepEqual(record.availableCommands, availableCommands);
});

test("commands bound the total pre-new metadata buffer without materializing unknown IDs", async (t) => {
  const backend = sessions(t, undefined, "commands-buffer-limit");
  const record = await backend.create(__dirname);
  assert.equal(record.availableCommands.length, 0, "Over-budget pre-new snapshot is not retained");
  assert.equal(backend.records.size, 1);
  await backend.client.requestExtension("echo", { control: "update-commands", sessionId: record.id,
    availableCommands: [{ name: "live", description: "Live" }] });
  assert.deepEqual(record.availableCommands, [{ name: "live", description: "Live" }]);
});

test("commands fresh load clears a nonempty snapshot without advertisement", async (t) => {
  const backend = sessions(t, undefined, "commands-no-load");
  const record = await backend.create(__dirname);
  assert.ok(record.availableCommands.length);
  record.configValid = false; // Config uncertainty requires fresh load on the same live connection.
  const connection = backend.client;
  await backend.load(record);
  assert.deepEqual(record.availableCommands, []);
  assert.equal(backend.client, connection);
  assert.equal((await configTraffic(backend)).filter((entry) => entry.method === "session/load").length, 1);
});

test("commands failed load revokes metadata advertised during replay", async (t) => {
  const backend = sessions(t, undefined, "commands-load-error");
  const snapshots = [];
  backend.on("commands", (record) => snapshots.push(record.availableCommands.map((command) => command.name)));
  await assert.rejects(backend.load({ id: "saved", cwd: __dirname }), /load failed after commands/);
  assert.deepEqual(snapshots, [[], ["compact", "review-test"], []]);
  assert.deepEqual(backend.records.get("saved").availableCommands, []);
});

test("config new/load retain per-cwd catalogs", async (t) => {
  const backend = sessions(t, undefined, "config");
  const first = await backend.create(__dirname);
  const second = await backend.create(path.join(__dirname, "fixtures"));
  assert.equal(first.configOptions[0].currentValue, "provider/test/initial");
  assert.equal(second.configOptions[0].currentValue, "provider/fixtures/initial");
  assert.equal(first.configOptions[1].currentValue, "workspace-agent");
  assert.equal(first.configOptions[2].currentValue, "default");
  assert.ok(Number.isInteger(first.configRevision));
  const loaded = await backend.load({ id: "saved", cwd: __dirname });
  assert.deepEqual(loaded.configOptions, first.configOptions);
});

test("config new/load default absent/null options to empty catalogs", async (t) => {
  for (const scenario of [undefined, "config-null"]) {
    const defaults = sessions(t, undefined, scenario);
    assert.deepEqual((await defaults.create(__dirname)).configOptions, []);
    assert.deepEqual((await defaults.load({ id: "saved", cwd: __dirname })).configOptions, []);
  }
});

for (const phase of ["new", "load"]) {
  test(`config rejects malformed present ${phase} catalog rather than defaulting`, async (t) => {
    const backend = sessions(t, undefined, `config-malformed-${phase}`);
    const operation = phase === "new" ? backend.create(__dirname) : backend.load({ id: "saved", cwd: __dirname });
    await assert.rejects(operation, /configOptions/);
    if (phase === "new") assert.equal(backend.records.size, 0);
    else {
      const record = backend.records.get("saved");
      assert.ok(record);
      assert.equal(record.configValid, false);
      assert.equal(record.connection, undefined);
    }
  });
}

test("config updates replace grouped/empty snapshots without history or turn callbacks", async (t) => {
  const backend = sessions(t, undefined, "config");
  const record = await backend.create(__dirname);
  const events = [];
  const updates = [];
  backend.on("config", (changed) => events.push(changed));
  record.turn = { controller: new AbortController(), onUpdate: (update) => updates.push(update) };
  const revision = record.configRevision;
  backend.update({ sessionId: record.id, update: { sessionUpdate: "config_option_update", configOptions: [{
    id: "model", name: "Model", type: "select", category: "future-category", description: null,
    currentValue: "removed", _meta: { secret: "never project" }, options: [
      { group: "provider", name: "Provider", _meta: {}, options: [{ value: "provider/model/extra", name: "Available", description: "Details", _meta: {} }] },
    ],
  }, { id: "flag", name: "Flag", type: "boolean", currentValue: false }] } });
  assert.deepEqual(record.configOptions, [{ id: "model", name: "Model", type: "select", category: "future-category", description: null, currentValue: "removed", options: [{ group: "provider", name: "Provider", options: [{ value: "provider/model/extra", name: "Available", description: "Details" }] }] }]);
  assert.ok(record.configRevision > revision);
  assert.equal(events.length, 1);
  assert.equal(events[0], record);
  backend.update({ sessionId: record.id, update: { sessionUpdate: "config_option_update", configOptions: [] } });
  assert.deepEqual(record.configOptions, []);
  assert.deepEqual(record.history, []);
  assert.deepEqual(updates, []);
});

test("config malformed update catalogs are rejected atomically before optional salvage", async (t) => {
  const backend = sessions(t, undefined, "config");
  const record = await backend.create(__dirname);
  const original = structuredClone(record.configOptions);
  const revision = record.configRevision;
  let events = 0;
  backend.on("config", () => events++);
  const select = { id: "model", name: "Model", type: "select", currentValue: "missing", options: [{ value: "one", name: "One" }] };
  const group = { group: "provider", name: "Provider", options: [{ value: "one", name: "One" }] };
  for (const configOptions of [
    undefined, null, {}, [null],
    ...["id", "name", "currentValue"].flatMap((key) => [[{ ...select, [key]: "" }], [{ ...select, [key]: 42 }]]),
    [{ ...select, category: {} }], [{ ...select, description: 42 }],
    [select, select], [{ ...select, options: null }],
    [{ ...select, options: [{ value: "", name: "Empty" }] }],
    [{ ...select, options: [{ value: "one", name: "" }] }],
    [{ ...select, options: [{ value: "one", name: "One", description: false }] }],
    [{ ...select, options: [select.options[0], select.options[0]] }],
    [{ ...select, options: [group, select.options[0]] }],
    [{ ...select, options: [group, group] }],
    [{ ...select, options: [group, { ...group, group: "other" }] }],
    [{ ...select, options: [{ ...group, group: "" }] }],
    [{ ...select, options: [{ ...group, name: "" }] }],
    [{ ...select, options: [{ ...group, options: [group] }] }],
  ]) {
    backend.update({ sessionId: record.id, update: { sessionUpdate: "config_option_update", configOptions } });
    assert.deepEqual(record.configOptions, original);
    assert.equal(record.configRevision, revision);
  }
  assert.equal(events, 0);
});

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

async function configTraffic(backend) {
  return (await backend.client.requestExtension("echo", { control: "stats" })).traffic;
}

test("config setter sends literal model/agent/effort and replaces full confirmed catalogs", async (t) => {
  const backend = sessions(t, undefined, "config");
  const record = await backend.create(__dirname);
  const other = await backend.create(path.join(__dirname, "fixtures"));
  const otherSnapshot = structuredClone(other.configOptions);
  await backend.setConfigOption(record, "mode", "custom-agent", record.configRevision);
  await backend.setConfigOption(record, "effort", "unusual-variant", record.configRevision);
  await backend.setConfigOption(record, "effort", "default", record.configRevision);
  await backend.setConfigOption(record, "model", "provider/test/reasoning/extra", record.configRevision);
  assert.equal(record.configOptions[0].currentValue, "provider/test/reasoning/extra");
  assert.equal(record.configOptions[2].currentValue, "removed-current");
  assert.deepEqual(record.configOptions[2].options.map((item) => item.value), ["default", "deep-custom"]);
  await backend.setConfigOption(record, "effort", "deep-custom", record.configRevision);
  await backend.setConfigOption(record, "model", "provider/test/plain", record.configRevision);
  assert.equal(record.configOptions.some((item) => item.id === "effort"), false);
  assert.deepEqual(record.history, []);
  assert.deepEqual(other.configOptions, otherSnapshot);
  assert.deepEqual((await configTraffic(backend)).filter((entry) => entry.method === "session/set_config_option").map((entry) => entry.params.value), ["custom-agent", "unusual-variant", "default", "provider/test/reasoning/extra", "deep-custom", "provider/test/plain"]);
});

test("config setter rejects stale revision and absent membership without RPC", async (t) => {
  const backend = sessions(t, undefined, "config");
  const record = await backend.create(__dirname);
  const stale = record.configRevision;
  await backend.setConfigOption(record, "mode", "custom-agent", stale);
  await assert.rejects(backend.setConfigOption(record, "mode", "workspace-agent", stale), /stale/i);
  await assert.rejects(backend.setConfigOption(record, "mode", "made-up", record.configRevision), /unavailable/i);
  await assert.rejects(backend.setConfigOption(record, "made-up", "default", record.configRevision), /unavailable/i);
  assert.equal((await configTraffic(backend)).filter((entry) => entry.method === "session/set_config_option").length, 1);
});

test("config reserves change synchronously, Send waits and reserved/active prompts reject setters", { timeout: 3000 }, async (t) => {
  let entered;
  let releasePermission;
  const opened = new Promise((resolve) => { entered = resolve; });
  const permission = new Promise((resolve) => { releasePermission = resolve; });
  const backend = sessions(t, () => { entered(); return permission; }, "config-delayed");
  const record = await backend.create(__dirname);
  const pending = configBarrier(t, backend.client);
  const change = backend.setConfigOption(record, "mode", "custom-agent", record.configRevision);
  const busy = assert.rejects(backend.setConfigOption(record, "effort", "default", record.configRevision), /busy/i);
  await pending;
  await busy;
  const send = backend.prompt(record, "after config", new AbortController().signal, () => {});
  await assert.rejects(backend.setConfigOption(record, "mode", "workspace-agent", record.configRevision), /prompt.*active/i);
  assert.deepEqual(record.history, []);
  assert.equal((await configTraffic(backend)).some((entry) => entry.method === "session/prompt"), false);
  await backend.client.requestExtension("echo", { control: "release-config" });
  await change;
  await opened;
  try {
    await assert.rejects(backend.setConfigOption(record, "mode", "workspace-agent", record.configRevision), /prompt.*active/i);
    assert.equal(record.configOptions[1].currentValue, "custom-agent");
    assert.equal(record.history[0].text, "after config");
  } finally {
    releasePermission("no");
    await send;
  }
  assert.equal(record.configPending, undefined);
});

for (const scenario of ["config-delayed-error", "config-delayed-malformed"]) {
  test(`config ${scenario} prevents waiting Send and reloads uncertain attached state once`, { timeout: 3000 }, async (t) => {
    const backend = sessions(t, undefined, scenario);
    const record = await backend.create(__dirname);
    const revision = record.configRevision;
    const connection = record.connection;
    const pending = configBarrier(t, connection);
    const change = backend.setConfigOption(record, "mode", "custom-agent", revision);
    const rejectedChange = assert.rejects(change, /configuration failed|configOptions/);
    await pending;
    const updates = [];
    const send = backend.prompt(record, "must not send", new AbortController().signal, (update) => updates.push(update));
    const rejectedSend = assert.rejects(send, /configuration failed|configOptions/);
    await connection.requestExtension("echo", { control: "release-config" });
    await Promise.all([rejectedChange, rejectedSend]);
    assert.deepEqual(record.history, []);
    assert.deepEqual(record.configOptions, []);
    assert.equal(record.configValid, false);
    assert.equal(record.configPending, undefined);
    assert.equal(record.turn, undefined);
    assert.deepEqual(updates, []);
    const nextUpdates = [];
    await backend.prompt(record, "recovered Send", new AbortController().signal, (update) => nextUpdates.push(update));
    assert.equal(record.connection, connection, "Recovery must bypass same-connection fast path");
    assert.equal(record.configValid, true);
    assert.equal(record.configOptions[1].currentValue, "custom-agent", "No optimistic rollback after backend mutation");
    assert.deepEqual(record.history.filter((turn) => turn.role === "user").map((turn) => turn.text), ["previous question", "recovered Send"]);
    assert.equal(nextUpdates.some((update) => update.content?.text === "previous answer"), false);
    const traffic = await configTraffic(backend);
    assert.equal(traffic.filter((entry) => entry.method === "session/load").length, 1);
    assert.equal(traffic.filter((entry) => entry.method === "session/prompt").length, 1);
    assert.equal(traffic.filter((entry) => entry.method === "session/set_config_option").length, 1);
  });
}

test("config Stop while waiting returns cancelled without cancel RPC or claiming config cancellation", { timeout: 3000 }, async (t) => {
  const backend = sessions(t, undefined, "config-delayed");
  const record = await backend.create(__dirname);
  const pending = configBarrier(t, backend.client);
  const change = backend.setConfigOption(record, "mode", "custom-agent", record.configRevision);
  await pending;
  const stop = new AbortController();
  const send = backend.prompt(record, "cancelled before Send", stop.signal, () => {});
  stop.abort();
  assert.equal((await send).stopReason, "cancelled");
  assert.ok(record.configPending, "Already sent config remains pending after Stop");
  assert.equal(record.turn, undefined);
  assert.equal(getEventListeners(stop.signal, "abort").length, 0);
  assert.deepEqual(record.history, []);
  assert.equal((await configTraffic(backend)).some((entry) => ["session/cancel", "session/prompt"].includes(entry.method)), false);
  await backend.client.requestExtension("echo", { control: "release-config" });
  await change;
  assert.equal(record.configOptions[1].currentValue, "custom-agent");
});

test("config reconnect replaces selections, rejects pre-load revision and ignores old connection notifications", async (t) => {
  const backend = sessions(t, undefined, "config");
  const record = await backend.create(__dirname);
  await backend.setConfigOption(record, "mode", "custom-agent", record.configRevision);
  const old = backend.client;
  const revision = record.configRevision;
  const closed = new Promise((resolve) => old.child.once("close", resolve));
  old.dispose();
  await closed;
  await assert.rejects(backend.setConfigOption(record, "mode", "workspace-agent", revision), /stale/i);
  assert.equal(record.configOptions[1].currentValue, "workspace-agent");
  const currentRevision = record.configRevision;
  old.emit("notification", "session/update", { sessionId: record.id, update: { sessionUpdate: "config_option_update", configOptions: [] } });
  old.emit("notification", "session/update", { sessionId: record.id, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "obsolete" } } });
  assert.equal(record.configRevision, currentRevision);
  assert.equal(record.history[1].updates.length, 1);
  assert.equal((await configTraffic(backend)).some((entry) => entry.method === "session/set_config_option"), false);
});

test("config raw wire updates reject malformed optional fields and accept grouped membership", async (t) => {
  const backend = sessions(t, undefined, "config");
  const record = await backend.create(__dirname);
  const original = structuredClone(record.configOptions);
  const revision = record.configRevision;
  for (const bad of [{ ...original[0], description: 42 }, { ...original[0], category: false }, { ...original[0], options: [{ value: "one", name: "One", description: {} }] }]) {
    await backend.client.requestExtension("echo", { control: "update-config", sessionId: record.id, configOptions: [bad] });
    assert.deepEqual(record.configOptions, original);
    assert.equal(record.configRevision, revision);
  }
  const grouped = [{ ...original[1], options: [{ group: "agents", name: "Agents", options: original[1].options }] }];
  await backend.client.requestExtension("echo", { control: "update-config", sessionId: record.id, configOptions: grouped });
  assert.deepEqual(record.configOptions, grouped);
  await backend.setConfigOption(record, "mode", "custom-agent", record.configRevision);
  assert.equal(record.configOptions[1].currentValue, "custom-agent");
});

test("config mixed wire catalog rejects all entries atomically then accepts a valid full replacement", async (t) => {
  const backend = sessions(t, undefined, "config");
  const record = await backend.create(__dirname);
  const original = structuredClone(record.configOptions);
  const revision = record.configRevision;
  const events = [];
  backend.on("config", (changed) => events.push(changed));
  const replacement = [
    { id: "model", name: "Model", type: "select", currentValue: "provider/test/plain", options: [{ value: "provider/test/plain", name: "Plain model" }] },
    { id: "mode", name: "Agent", type: "select", category: "mode", description: "Confirmed agent", currentValue: "custom-agent", options: [{ value: "custom-agent", name: "Custom agent" }] },
  ];
  for (const malformed of [{ description: 42 }, { category: false }]) {
    await backend.client.requestExtension("echo", { control: "update-config", sessionId: record.id, configOptions: [replacement[0], { ...replacement[1], ...malformed }] });
    assert.deepEqual(record.configOptions, original);
    assert.equal(record.configRevision, revision);
    assert.deepEqual(events, []);
  }
  await backend.client.requestExtension("echo", { control: "update-config", sessionId: record.id, configOptions: replacement });
  assert.deepEqual(record.configOptions, replacement);
  assert.equal(record.configOptions[0].currentValue, "provider/test/plain");
  assert.equal(record.configOptions[1].currentValue, "custom-agent");
  assert.equal(record.configRevision, revision + 1);
  assert.deepEqual(events, [record]);
  assert.deepEqual(record.history, []);
});

for (const result of [null, {}, { configOptions: null }, { configOptions: {} }, { configOptions: [{ id: "model", name: "Model", type: "select", currentValue: "current", options: [{ value: "one", name: "One", description: 42 }] }] }]) {
  test(`config set requires full valid options for ${JSON.stringify(result)}`, async (t) => {
    const backend = sessions(t, undefined, "config");
    const record = await backend.create(__dirname);
    await backend.client.requestExtension("echo", { control: "next-config-response", result });
    await assert.rejects(backend.setConfigOption(record, "mode", "custom-agent", record.configRevision), /configOptions/);
    assert.equal(record.configValid, false);
    assert.deepEqual(record.configOptions, []);
    const invalidRevision = record.configRevision;
    await assert.rejects(backend.setConfigOption(record, "mode", "workspace-agent", invalidRevision), /stale/i);
    assert.equal(record.configValid, true);
    assert.equal(record.configOptions[1].currentValue, "custom-agent");
    assert.equal((await configTraffic(backend)).filter((entry) => entry.method === "session/set_config_option").length, 1);
  });
}

test("config valid empty set response clears catalog instead of retaining old selections", async (t) => {
  const backend = sessions(t, undefined, "config");
  const record = await backend.create(__dirname);
  await backend.client.requestExtension("echo", { control: "next-config-response", result: { configOptions: [] } });
  await backend.setConfigOption(record, "mode", "custom-agent", record.configRevision);
  assert.deepEqual(record.configOptions, []);
  assert.equal(record.configValid, true);
});

test("config shared deadline closes pending change and another session prompt without loosening timeout", { timeout: 3000 }, async (t) => {
  const deadlines = new Map();
  const schedule = global.setTimeout;
  const clear = global.clearTimeout;
  t.mock.method(global, "setTimeout", (callback, delay, ...args) => {
    const timer = schedule(callback, delay, ...args);
    if (delay === 30000) deadlines.set(timer, callback);
    return timer;
  });
  t.mock.method(global, "clearTimeout", (timer) => { deadlines.delete(timer); clear(timer); });
  let entered;
  const opened = new Promise((resolve) => { entered = resolve; });
  const backend = sessions(t, async (params, signal) => {
    entered();
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    return undefined;
  }, "config-delayed");
  const first = await backend.create(__dirname);
  const second = await backend.create(path.join(__dirname, "fixtures"));
  const pending = configBarrier(t, backend.client);
  const change = backend.setConfigOption(first, "mode", "custom-agent", first.configRevision);
  const rejectedChange = assert.rejects(change, /session\/set_config_option.*timed out after 30000ms/);
  await pending;
  assert.equal(deadlines.size, 1);
  const expire = [...deadlines.values()][0];
  const waiting = backend.prompt(first, "waiting", new AbortController().signal, () => {});
  const rejectedWaiting = assert.rejects(waiting, /timed out after 30000ms/);
  const other = backend.prompt(second, "active", new AbortController().signal, () => {});
  const rejectedOther = assert.rejects(other, /timed out after 30000ms/);
  await opened;
  expire();
  await Promise.all([rejectedChange, rejectedWaiting, rejectedOther]);
  assert.equal(backend.client, undefined);
  assert.equal(first.configPending, undefined);
  assert.equal(first.turn, undefined);
  assert.equal(second.turn, undefined);
  assert.equal(first.configValid, false);
  assert.equal(second.configValid, false);
  assert.deepEqual(first.history, []);
  assert.equal(deadlines.size, 0);
});

test("config recovery rebuilds replay history once without streaming old tools or opening replay permission UI", async (t) => {
  let permissionCalls = 0;
  const backend = sessions(t, () => { permissionCalls++; return "yes"; }, "config-recovery-replay");
  const record = await backend.create(__dirname);
  await backend.client.requestExtension("echo", { control: "next-config-response", result: {} });
  await assert.rejects(backend.setConfigOption(record, "mode", "custom-agent", record.configRevision), /configOptions/);
  const updates = [];
  await backend.prompt(record, "fresh prompt", new AbortController().signal, (update) => updates.push(update));
  assert.equal(permissionCalls, 1, "Only the new prompt can request permission");
  assert.equal(record.history[1].updates.filter((update) => update.toolCallId === "replayed-tool").length, 1);
  assert.equal(updates.some((update) => update.toolCallId === "replayed-tool" || update.content?.text === "previous answer"), false);
  const stats = await backend.client.requestExtension("echo", { control: "stats" });
  assert.deepEqual(stats.replayPermission, { outcome: { outcome: "cancelled" } });
  await backend.prompt(record, "second prompt", new AbortController().signal, () => {});
  assert.equal(record.history[1].updates.filter((update) => update.toolCallId === "replayed-tool").length, 1);
  assert.equal((await configTraffic(backend)).filter((entry) => entry.method === "session/load").length, 1);
});

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
