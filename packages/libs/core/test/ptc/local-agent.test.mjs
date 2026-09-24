import assert from "node:assert/strict";
import {test} from "node:test";
import {Agent} from "../../src/agent/service.ts";
import {context} from "./state-fixture.mjs";

const tools = {builtin: {mode: "all"}, dynamic: {mode: "selected", names: []}, mcp: []};

test("a new agent starts directly, snapshots local memory, and queues later input without accounts", async t => {
  const before = process.env.MCP_SERVERS_JSON;
  process.env.MCP_SERVERS_JSON = "[]";
  t.after(() => { if (before === undefined) delete process.env.MCP_SERVERS_JSON; else process.env.MCP_SERVERS_JSON = before; });
  const f = context("demo");
  const started = await f.invoke(Agent.object.ask, {message: "Hello"});
  assert.equal(started.decision, "start");
  assert.equal(f.calls.length, 0);
  const run = f.sends.find(send => send.method === "doTurn");
  assert.equal(run.service, "AgentSession");
  assert.equal(run.key, "demo");
  assert.deepEqual(run.parameter.memories, []);
  assert.equal(run.parameter.agentName, "demo");
  assert.equal(Object.hasOwn(run.parameter, "ownerUserId"), false);
  assert.equal(Object.hasOwn(run.parameter, "mcpCredentials"), false);
  assert.equal((await f.invoke(Agent.object.ask, {message: "Next"})).decision, "queue");
  assert.equal(f.sends.filter(send => send.method === "doTurn").length, 1);
});

test("memory is isolated per agent and only the current non-interrupting turn may save it", async () => {
  const a = context("a", {turn: {id: "turn", tools, steeringBatches: []}});
  const b = context("b");
  const changes = [{operation: "set", key: "units", content: "Fahrenheit"}];
  assert.equal((await a.invoke(Agent.object.updateMemory, {turnId: "old", changes})).applied, false);
  assert.equal((await a.invoke(Agent.object.updateMemory, {turnId: "turn", changes})).applied, true);
  assert.deepEqual((await a.invoke(Agent.object.profile)).memories, [{key: "units", content: "Fahrenheit"}]);
  assert.deepEqual((await b.invoke(Agent.object.profile)).memories, []);
  a.state.get("turn").interruptReason = "Stop";
  assert.equal((await a.invoke(Agent.object.updateMemory, {turnId: "turn", changes})).applied, false);
  assert.equal(await a.invoke(Agent.object.deleteMemory, {key: "units"}), true);
  assert.deepEqual((await a.invoke(Agent.object.profile)).memories, []);
  assert.ok(a.state.get("notifications").versions.profile > 0);
});

test("memory batches respect the cap atomically and replacement preserves unrelated keys", async () => {
  const memories = Array.from({length: 32}, (_, i) => ({key: `key-${i}`, content: `value-${i}`}));
  const f = context("a", {memories, turn: {id: "turn", tools, steeringBatches: []}});
  const changes = [{operation: "set", key: "key-0", content: "changed"}, {operation: "set", key: "overflow", content: "extra"}];
  assert.equal((await f.invoke(Agent.object.updateMemory, {turnId: "turn", changes})).applied, false);
  assert.deepEqual((await f.invoke(Agent.object.profile)).memories, memories);
  changes.unshift({operation: "delete", key: "key-1"});
  assert.equal((await f.invoke(Agent.object.updateMemory, {turnId: "turn", changes})).applied, true);
  const saved = (await f.invoke(Agent.object.profile)).memories;
  assert.equal(saved.length, 32);
  assert.equal(saved.find(entry => entry.key === "key-0").content, "changed");
  assert.equal(saved.find(entry => entry.key === "key-2").content, "value-2");
});

test("notifications advance locally and wake subscribers registered before the change", async () => {
  const f = context("demo");
  assert.equal(await f.invoke(Agent.object.subscribe, {afterRevision: 0, awakeableId: "watcher"}), null);
  await f.invoke(Agent.object.publish, "history");
  const result = await f.invoke(Agent.object.notifications);
  assert.equal(result.versions.history, 1);
  assert.equal(result.revision, 1);
  assert.deepEqual(f.signals, [{id: "watcher", value: result}]);
  assert.equal(f.state.has("notification-subscriptions"), false);
  // A watcher that registers after the change returns immediately.
  assert.deepEqual(await f.invoke(Agent.object.subscribe, {afterRevision: 0, awakeableId: "late"}), result);
  assert.equal(f.calls.length, 0);
  assert.equal(f.sends.length, 0);
});

const withMcpServers = t => {
  const before = process.env.MCP_SERVERS_JSON;
  process.env.MCP_SERVERS_JSON = "[]";
  t.after(() => { if (before === undefined) delete process.env.MCP_SERVERS_JSON; else process.env.MCP_SERVERS_JSON = before; });
};
const scheduleSpec = {scheduleId: "reminder", message: "Check weather", delaySeconds: 10, repeatEverySeconds: null, whenBusy: "queue"};

test("schedules reject stale timers and route due messages into the same agent", async t => {
  withMcpServers(t);
  const f = context("demo");
  const turns = () => f.sends.filter(send => send.method === "doTurn");
  assert.equal((await f.invoke(Agent.object.createSchedule, scheduleSpec)).accepted, true);
  const timer = f.sends.find(send => send.method === "fire");
  assert.deepEqual([timer.service, timer.key, timer.delay], ["Agent", "demo", 10_000]);
  await f.invoke(Agent.object.fire, {scheduleId: "reminder"});
  assert.equal(turns().length, 0, "a stale invocation must not deliver");
  f.state.get("schedules")[0].timerId = "inv-test";
  await f.invoke(Agent.object.fire, {scheduleId: "reminder"});
  assert.equal(turns().length, 1);
  assert.equal(turns()[0].key, "demo");
  assert.deepEqual(turns()[0].parameter.entries, [
    {role: "event", type: "delivery", source: "schedule", sourceId: "reminder", whenBusy: "queue", routing: "start"},
    {role: "user", text: "Check weather", delivery: "turn"},
  ]);
  assert.deepEqual(await f.invoke(Agent.object.schedules), []);
  assert.ok(f.state.get("notifications").versions.schedules > 0);
  await f.invoke(Agent.object.fire, {scheduleId: "reminder"});
  assert.equal(turns().length, 1, "late duplicate timers must not deliver again");
});

test("recurring schedules advance durable timers; retirement cancels all and prevents resurrection", async t => {
  withMcpServers(t);
  const f = context("demo");
  const spec = {...scheduleSpec, scheduleId: "repeat", delaySeconds: 2, repeatEverySeconds: 60};
  await f.invoke(Agent.object.createSchedule, spec);
  const firstTimer = f.state.get("schedules")[0].timerId;
  await f.invoke(Agent.object.createSchedule, spec);
  assert.ok(f.cancelled.includes(firstTimer));
  f.state.get("schedules")[0].timerId = "inv-test";
  await f.invoke(Agent.object.fire, {scheduleId: "repeat"});
  const next = f.state.get("schedules")[0];
  assert.notEqual(next.timerId, "inv-test");
  assert.equal(next.nextRunAt, 1700000060000);
  await f.invoke(Agent.object.retire, {});
  assert.ok(f.cancelled.includes(next.timerId));
  await assert.rejects(f.invoke(Agent.object.createSchedule, spec), /deleted/);
  assert.deepEqual(await f.invoke(Agent.object.schedules), []);
});

test("child agents cannot schedule, even when called directly", async () => {
  const f = context("child", {metadata: {name: "child", parentAgentId: "parent"}});
  const result = await f.invoke(Agent.object.createSchedule, scheduleSpec);
  assert.equal(result.accepted, false);
  assert.match(result.error, /Sub-agents cannot schedule/);
  assert.equal(f.sends.length, 0);
  assert.deepEqual(await f.invoke(Agent.object.schedules), []);
});

test("model schedule tools are authorized against the live, non-interrupting turn", async () => {
  const f = context("demo", {turn: {id: "turn", tools, steeringBatches: []}});
  const installed = async () => (await f.invoke(Agent.object.schedules)).length;
  await assert.rejects(f.invoke(Agent.object.createSchedule, {...scheduleSpec, turnId: "old"}), /active, non-interrupting Turn/);
  await assert.rejects(f.invoke(Agent.object.cancelSchedule, {scheduleId: "reminder", turnId: "old"}), /active, non-interrupting Turn/);
  assert.equal(await installed(), 0);

  assert.equal((await f.invoke(Agent.object.createSchedule, {...scheduleSpec, turnId: "turn"})).accepted, true);
  assert.equal(await installed(), 1);
  assert.equal((await f.invoke(Agent.object.cancelSchedule, {scheduleId: "reminder", turnId: "turn"})).cancelled, true);
  assert.equal(await installed(), 0);

  f.state.get("turn").interruptReason = "Stop";
  await assert.rejects(f.invoke(Agent.object.createSchedule, {...scheduleSpec, turnId: "turn"}), /active, non-interrupting Turn/);
  assert.equal(await installed(), 0, "an interrupted turn must not install a schedule");

  f.state.set("turn", {id: "turn", tools: {...tools, builtin: {mode: "selected", names: ["listSchedules"]}}, steeringBatches: []});
  await assert.rejects(f.invoke(Agent.object.createSchedule, {...scheduleSpec, turnId: "turn"}), /cannot create schedules/);
  await assert.rejects(f.invoke(Agent.object.cancelSchedule, {scheduleId: "reminder", turnId: "turn"}), /cannot cancel schedules/);
  assert.equal(await installed(), 0);
});

test("a coalescing delivery is skipped while its previous run is queued or active", async t => {
  const before = process.env.MCP_SERVERS_JSON;
  process.env.MCP_SERVERS_JSON = "[]";
  t.after(() => { if (before === undefined) delete process.env.MCP_SERVERS_JSON; else process.env.MCP_SERVERS_JSON = before; });
  const delivery = whenBusy => ({source: "schedule", sourceId: "tick", message: "Tick", whenBusy, coalesce: true});
  const userMessages = f => (f.state.get("pending") ?? []).filter(entry => entry.role === "user").length;

  // Queue: a busy agent keeps at most one queued run per schedule.
  const queued = context("demo", {turn: {id: "user-turn", tools, steeringBatches: []}});
  for (let i = 0; i < 5; i++) await queued.invoke(Agent.object.deliver, delivery("queue"));
  assert.equal(userMessages(queued), 1);
  // Other producers and non-coalescing deliveries still queue.
  await queued.invoke(Agent.object.deliver, {...delivery("queue"), sourceId: "other"});
  await queued.invoke(Agent.object.deliver, {...delivery("queue"), coalesce: undefined});
  assert.equal(userMessages(queued), 3);

  // Interrupt: once a run is queued behind an interrupt, or is itself the
  // active turn, later firings neither stack nor interrupt it again.
  const f = context("demo", {turn: {id: "user-turn", tools, steeringBatches: []}});
  await f.invoke(Agent.object.deliver, delivery("interrupt"));
  assert.equal(f.signals.length, 1);
  await f.invoke(Agent.object.deliver, delivery("interrupt"));
  assert.equal(userMessages(f), 1);
  const ended = await f.invoke(Agent.object.onTurnEnd, {turnId: "user-turn", status: "interrupted", reason: "due", consumedSteering: 0});
  assert.equal(ended.status, "interrupted");
  const successor = f.state.get("turn");
  assert.ok(successor.deliveries.length > 0, "the successor turn records the delivery it carries");
  await f.invoke(Agent.object.deliver, delivery("interrupt"));
  assert.equal(f.state.get("turn").interruptReason, undefined, "the scheduled run is not interrupted by its own next firing");
  assert.equal(userMessages(f), 0);
});

test("a successor that cannot start keeps its queued input and the finished outcome", async t => {
  const before = process.env.MCP_SERVERS_JSON;
  t.after(() => { if (before === undefined) delete process.env.MCP_SERVERS_JSON; else process.env.MCP_SERVERS_JSON = before; });
  const queued = {role: "user", text: "queued while busy", delivery: "queued"};
  const f = context("demo", {turn: {id: "turn", tools, steeringBatches: []}, pending: [queued]});
  process.env.MCP_SERVERS_JSON = "not json";
  const outcome = {turnId: "turn", status: "completed", response: "done", consumedSteering: 0};
  assert.deepEqual(await f.invoke(Agent.object.onTurnEnd, outcome), outcome);
  assert.equal(f.state.has("turn"), false);
  assert.deepEqual(f.state.get("pending"), [queued]);
  assert.equal(f.sends.filter(send => send.method === "doTurn").length, 0);
  await assert.rejects(f.invoke(Agent.object.ask, {message: "still broken"}), /MCP_SERVERS_JSON/);
  assert.deepEqual(f.state.get("pending"), [queued], "a failed start must not consume parked input");

  process.env.MCP_SERVERS_JSON = "[]";
  assert.equal((await f.invoke(Agent.object.ask, {message: "fixed"})).decision, "start");
  const run = f.sends.find(send => send.method === "doTurn");
  assert.deepEqual(run.parameter.entries.map(entry => entry.text), ["queued while busy", "fixed"]);
  assert.equal(f.state.has("pending"), false);
});

test("a late interrupt does not hide a failed turn's error", async (t) => {
  const before = process.env.MCP_SERVERS_JSON;
  process.env.MCP_SERVERS_JSON = "[]";
  t.after(() => {
    if (before === undefined) delete process.env.MCP_SERVERS_JSON;
    else process.env.MCP_SERVERS_JSON = before;
  });
  const interruptedTurn = () => ({
    turn: {id: "turn", tools, steeringBatches: [], interruptReason: "stop"},
  });

  // A failure keeps its status and error.
  const failed = {
    turnId: "turn",
    status: "failed",
    error: "model unavailable",
    consumedSteering: 0,
  };
  const afterFailure = context("demo", interruptedTurn());
  assert.deepEqual(
    await afterFailure.invoke(Agent.object.onTurnEnd, failed),
    failed,
  );

  // A completion becomes the interruption the user asked for.
  const completed = {
    turnId: "turn",
    status: "completed",
    response: "done",
    consumedSteering: 0,
  };
  const afterCompletion = context("demo", interruptedTurn());
  assert.deepEqual(
    await afterCompletion.invoke(Agent.object.onTurnEnd, completed),
    {
      turnId: "turn",
      status: "interrupted",
      reason: "stop",
      response: "done",
      consumedSteering: 0,
    },
  );
});

test("a busy agent rejects input beyond its queue limit", async () => {
  const f = context("demo", {
    turn: {id: "turn", tools, steeringBatches: []},
  });
  for (let i = 0; i < 32; i++) {
    await f.invoke(Agent.object.ask, {message: `message ${i}`});
  }

  await assert.rejects(
    f.invoke(Agent.object.ask, {message: "one too many"}),
    /already holds 32 queued messages/,
  );
  assert.equal(f.state.get("pending").length, 32);
});

test("a watch with no change returns the current watermarks at its timeout", async () => {
  const handlers = [];
  const f = context("demo", {}, (call) => {
    handlers.push(call.method);
    return null;
  });

  const snapshot = await f.invoke(Agent.object.watch, {
    afterRevision: 0,
    timeoutSeconds: 25,
  });

  assert.equal(snapshot.revision, 0);
  assert.deepEqual(handlers, ["subscribe", "unsubscribe"]);
});

test("steering the turn never consumed opens its successor in FIFO order", async (t) => {
  withMcpServers(t);
  const f = context("demo", {
    turn: {id: "turn", tools, steeringBatches: []},
  });
  await f.invoke(Agent.object.ask, {message: "queued first"});
  assert.equal(await f.invoke(Agent.object.steer, {message: "steer one"}), true);
  assert.equal(await f.invoke(Agent.object.steer, {message: "steer two"}), true);

  // Both batches reached the turn as signals, the first carrying the queue.
  const batches = f.signals.map((signal) => signal.value);
  assert.deepEqual(
    batches.map((batch) => batch.message),
    ["steer one", "steer two"],
  );
  assert.equal(batches[0].queued[0].text, "queued first");

  // The turn consumed only the first batch before it finished.
  await f.invoke(Agent.object.onTurnEnd, {
    turnId: "turn",
    status: "completed",
    response: "done",
    consumedSteering: 1,
  });

  const successor = f.sends.find((send) => send.method === "doTurn");
  const texts = successor.parameter.entries
    .filter((entry) => entry.role === "user")
    .map((entry) => entry.text);
  assert.deepEqual(texts, ["steer two"]);
});
