"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { Cause, Effect } = require("effect");
let makeConnection;
try { ({ makeConnection } = require("../dist/machines/connection")); } catch (error) {
  if (error.code !== "MODULE_NOT_FOUND") throw error;
}

const options = {
  command: process.execPath,
  args: [path.join(__dirname, "fixtures/agent.cjs")],
  cwd: __dirname,
};

test("ConnectionMachine public CJS entrypoint imports without timers, process launch or runtime vscode", () => {
  const result = spawnSync(process.execPath, ["-e", `
    require("node:child_process").spawn = () => { throw new Error("Unexpected ACP launch"); };
    global.setTimeout = () => { throw new Error("Unexpected timer on import"); };
    const Module = require("node:module");
    const load = Module._load;
    Module._load = function (id, ...args) {
      if (id === "vscode") throw new Error("Unexpected runtime vscode");
      return load.call(this, id, ...args);
    };
    const exported = require(${JSON.stringify(path.resolve(__dirname, "../dist/machines/connection"))});
    if (!exported.ConnectionMachine || !exported.ConnectionState || !exported.ConnectionEvents ||
        !exported.ConnectionServices || typeof exported.makeConnection !== "function") process.exitCode = 1;
  `], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("ConnectionMachine is lazy, joins one initialized generation, and terminal disposal forbids reentry", { timeout: 3000 }, async () => {
  assert.equal(typeof makeConnection, "function", "Executable ConnectionMachine owner is missing");
  let initializations = 0;
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const owner = yield* makeConnection({ ...options, onClient: (client) => {
      const write = client.child.stdin.write;
      client.child.stdin.write = function (bytes, ...args) {
        if (JSON.parse(Buffer.from(bytes).toString()).method === "initialize") initializations++;
        return write.call(this, bytes, ...args);
      };
    } }, 7);
    assert.equal(owner.client, undefined, "Creating owner must not spawn ACP");
    const [first, second] = yield* Effect.all([owner.connectEffect(), owner.connectEffect()], { concurrency: "unbounded" });
    assert.equal(first, second);
    assert.equal(initializations, 1);
    assert.equal(owner.client, first);
    assert.equal(first.capabilities.loadSession, true);
    const snapshot = yield* owner.ref.snapshot;
    assert.equal(snapshot.state.value.generation, 7);
    assert.equal(snapshot.state.state.path, "Ready");
    yield* owner.disposeEffect();
    const closed = yield* owner.ref.snapshot;
    assert.equal(closed.state.state.path, "Closed");
    const result = yield* Effect.exit(owner.connectEffect());
    assert.equal(result._tag, "Failure");
    assert.equal(owner.client, first, "Terminal owner must never replace its transport");
  })));
});

test("ConnectionMachine joined startup callers receive same failure and scope releases transport", { timeout: 3000 }, async () => {
  assert.equal(typeof makeConnection, "function", "Executable ConnectionMachine owner is missing");
  let transport;
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const owner = yield* makeConnection({ ...options, command: path.join(__dirname, "fixtures/missing-executable") }, 8);
    const results = yield* Effect.all([Effect.exit(owner.connectEffect()), Effect.exit(owner.connectEffect())], { concurrency: "unbounded" });
    for (const result of results) assert.equal(result._tag, "Failure");
    assert.equal(Cause.squash(results[0].cause), Cause.squash(results[1].cause));
    transport = owner.client;
    assert.ok(transport.failure);
    yield* owner.disposeEffect();
  })));
  assert.equal(transport.disposing, true);
});

test("ConnectionMachine closes an idle owner without launching and never reenters after disposal", { timeout: 3000 }, async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const owner = yield* makeConnection(options, 10);
    owner.dispose();
    const result = yield* Effect.exit(owner.connectEffect());
    assert.equal(result._tag, "Failure");
    yield* owner.disposeEffect();
    assert.equal(owner.client, undefined);
    assert.equal((yield* owner.ref.state).state.path, "Closed");
  })));
});

test("ConnectionMachine disposal during initialize settles joined callers and joins child cleanup", { timeout: 3000 }, async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    let owner;
    owner = yield* makeConnection({ ...options, onClient: (client) => {
      const write = client.child.stdin.write;
      client.child.stdin.write = function (bytes, ...args) {
        if (JSON.parse(Buffer.from(bytes).toString()).method === "initialize") {
          owner.dispose();
          return true;
        }
        return write.call(this, bytes, ...args);
      };
    } }, 11);
    const results = yield* Effect.all([Effect.exit(owner.connectEffect()), Effect.exit(owner.connectEffect())], { concurrency: "unbounded" });
    for (const result of results) assert.equal(result._tag, "Failure");
    yield* owner.disposeEffect();
    assert.equal((yield* owner.ref.state).state.path, "Closed");
    assert.notEqual(owner.client.child.exitCode ?? owner.client.child.signalCode, null);
  })));
});

for (const scenario of ["initialize-null", "initialize-invalid"]) {
  test(`ConnectionMachine ${scenario} rejects all startup callers and closes transport`, { timeout: 3000 }, async () => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const owner = yield* makeConnection({ ...options, args: [...options.args, scenario] }, 12);
      const results = yield* Effect.all([Effect.exit(owner.connectEffect()), Effect.exit(owner.connectEffect())], { concurrency: "unbounded" });
      for (const result of results) {
        assert.equal(result._tag, "Failure");
        assert.match(Cause.squash(result.cause).message, /Sessions.connect.*protocolVersion/);
      }
      assert.equal(Cause.squash(results[0].cause), Cause.squash(results[1].cause));
      yield* owner.disposeEffect();
      assert.equal(owner.client.disposing, true);
    })));
  });
}

test("ConnectionMachine scope closes an initialized transport without explicit disposal", { timeout: 3000 }, async () => {
  assert.equal(typeof makeConnection, "function", "Executable ConnectionMachine owner is missing");
  let transport;
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const owner = yield* makeConnection(options, 9);
    transport = yield* owner.connectEffect();
  })));
  assert.equal(transport.disposing, true);
  assert.notEqual(transport.child.exitCode ?? transport.child.signalCode, null);
});
