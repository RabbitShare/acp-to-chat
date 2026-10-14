"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { Deferred, Effect, Exit } = require("effect");

for (const name of ["session", "turn"]) test(`${name} executable machine entrypoint imports without IO`, () => {
  const result = spawnSync(process.execPath, ["-e", `
    require("node:child_process").spawn = () => { throw new Error("Unexpected ACP launch"); };
    global.setTimeout = () => { throw new Error("Unexpected timer"); };
    const Module = require("node:module"), load = Module._load;
    Module._load = function (id, ...args) {
      if (id === "vscode") throw new Error("Unexpected vscode");
      return load.call(this, id, ...args);
    };
    const exports = require(${JSON.stringify(path.resolve(__dirname, `../dist/machines/${name}`))});
    if (!exports.${name === "session" ? "SessionMachine" : "TurnMachine"}) process.exitCode = 1;
  `], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("SessionMachine fresh load leaves uncertain configuration without replaying setter", async () => {
  const { startSessionMachine, SessionServices, SessionEvents, SessionOperation } = require("../dist/machines/session");
  let setters = 0, loads = 0;
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const ref = yield* startSessionMachine().pipe(Effect.provideService(SessionServices, {
      load: (op) => Effect.sync(() => { loads++; op.result = Exit.void; return op; }),
      set: (op) => Effect.suspend(() => { setters++; op.uncertain = true; op.result = Exit.fail(new Error("uncertain")); return Effect.fail(op.result.cause.error); }),
    }));
    const change = new SessionOperation({ configId: "mode", value: "literal", revision: 1 });
    yield* ref.send(SessionEvents.Set({ operation: change }));
    assert.equal((yield* Effect.exit(Deferred.await(change.done)))._tag, "Failure");
    yield* Effect.yieldNow;
    assert.equal((yield* ref.state).states.Config.state.path, "Config.Uncertain");
    const load = new SessionOperation();
    yield* ref.send(SessionEvents.Load({ operation: load }));
    yield* Deferred.await(load.done);
    yield* Effect.yieldNow;
    assert.equal((yield* ref.state).states.Config.state.path, "Config.Idle");
    assert.equal(loads, 1);
    assert.equal(setters, 1);
  })));
});

test("SessionMachine exposes load failure as a distinct topology outcome", async () => {
  const { startSessionMachine, SessionServices, SessionEvents, SessionOperation } = require("../dist/machines/session");
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const ref = yield* startSessionMachine().pipe(Effect.provideService(SessionServices, {
      load: (op) => Effect.suspend(() => { op.result = Exit.fail(new Error("load failed")); return Effect.fail(op.result.cause.error); }),
      set: (op) => Effect.succeed(op),
    }));
    const load = new SessionOperation();
    yield* ref.send(SessionEvents.Load({ operation: load }));
    assert.equal((yield* Effect.exit(Deferred.await(load.done)))._tag, "Failure");
    yield* Effect.yieldNow;
    assert.equal((yield* ref.state).states.Load.state.path, "Load.Failed");
  })).pipe(Effect.timeout(300)));
});

test("SessionMachine rejected setter enters uncertain configuration and completes its own operation", async () => {
  const { startSessionMachine, SessionServices, SessionEvents, SessionOperation } = require("../dist/machines/session");
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const ref = yield* startSessionMachine().pipe(Effect.provideService(SessionServices, {
      load: (op) => Effect.succeed(op),
      set: (op) => Effect.suspend(() => { op.result = Exit.fail(new Error("stale selection")); return Effect.fail(op.result.cause.error); }),
    }));
    const change = new SessionOperation({ configId: "mode", value: "stale", revision: 1 });
    yield* ref.send(SessionEvents.Set({ operation: change }));
    assert.equal((yield* Effect.exit(Deferred.await(change.done)))._tag, "Failure");
    yield* Effect.yieldNow;
    assert.equal((yield* ref.state).states.Config.state.path, "Config.Uncertain");
  })).pipe(Effect.timeout(300)));
});

test("TurnMachine retains Active prompt invocation through repeated Stop", async () => {
  const { startTurnMachine, TurnServices, TurnEvents } = require("../dist/machines/turn");
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const response = yield* Deferred.make();
    const started = yield* Deferred.make();
    const cancelling = yield* Deferred.make();
    const completed = yield* Deferred.make();
    const observing = yield* Deferred.make();
    let prompts = 0, cancels = 0, interrupted = false, permissionsClosed = false;
    const ref = yield* startTurnMachine("test").pipe(Effect.provideService(TurnServices, {
      config: Effect.void, load: Effect.void, template: Effect.void, files: Effect.void,
      prompt: Effect.sync(() => { prompts++; }).pipe(Effect.andThen(Deferred.succeed(started, undefined)),
        Effect.andThen(Deferred.await(response)), Effect.onInterrupt(() => Effect.sync(() => { interrupted = true; }))),
      cancel: Effect.sync(() => { cancels++; }).pipe(Effect.andThen(Deferred.succeed(cancelling, undefined)), Effect.asVoid),
      permissions: Effect.scoped(Effect.acquireRelease(Deferred.succeed(observing, undefined),
        () => Effect.sync(() => { permissionsClosed = true; })).pipe(Effect.andThen(Effect.never))),
      complete: Deferred.succeed(completed, undefined).pipe(Effect.asVoid), stopped: Effect.die("Active cannot stop preparation"),
      failed: (error) => Effect.die(error),
    }));
    yield* Deferred.await(started);
    yield* Deferred.await(observing).pipe(Effect.timeout(200));
    yield* ref.send(TurnEvents.Stop());
    yield* ref.send(TurnEvents.Stop());
    yield* Deferred.await(cancelling);
    assert.equal((yield* ref.state).state.state.path, "Active.Cancelling");
    assert.equal(interrupted, false);
    assert.equal(permissionsClosed, false, "Permission observer belongs to retained Active parent");
    assert.equal(prompts, 1);
    assert.equal(cancels, 1);
    yield* Deferred.succeed(response, { stopReason: "cancelled" });
    yield* Deferred.await(completed);
    assert.equal(interrupted, false);
    assert.equal(permissionsClosed, true);
  })));
});

test("TurnMachine synchronous failure during load settles completion instead of stranding reservation", async () => {
  const { TurnOwner } = require("../dist/machines/turn");
  const error = new Error("load connection failed");
  const record = { id: "saved", cwd: __dirname, history: [], availableCommands: [], configOptions: [], configRevision: 0, configValid: false };
  let turn;
  turn = new TurnOwner(record, { loadEffect: () => Effect.sync(() => turn.fail(error)) },
    { isCurrent: () => false, status: () => {}, permission: () => undefined, log: () => {} },
    "never", new AbortController().signal, () => {}, () => {});
  record.turn = turn.projection;
  let timer;
  try {
    await assert.rejects(Promise.race([Effect.runPromise(turn.runEffect()), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("load failure stranded machine completion")), 200);
    })]), /load connection failed/);
  } finally { clearTimeout(timer); }
  assert.equal(record.turn, undefined);
});
