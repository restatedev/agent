import assert from "node:assert/strict";
import {test} from "node:test";
import {Agent} from "../../src/agent/service.ts";
import {AgentScheduler} from "../../src/scheduler/service.ts";
import {AgentNotifications} from "../../src/notifications/service.ts";
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
  assert.ok(a.sends.some(send => send.service === "AgentNotifications" && send.parameter === "profile"));
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

test("notifications publish locally with no account lookup or global feed", async () => {
  const f = context("demo");
  await f.invoke(AgentNotifications.object.publish, "history");
  const result = await f.invoke(AgentNotifications.object.snapshot);
  assert.equal(result.versions.history, 1);
  assert.equal(result.revision, 1);
  assert.equal(f.calls.length, 0);
  assert.equal(f.sends.length, 0);
});

test("schedules reject stale timers and deliver into the same agent with the chosen routing policy", async () => {
  const f = context("demo", {}, call => {
    assert.equal(call.service, "Agent");
    assert.equal(call.key, "demo");
    assert.equal(call.method, "metadata", "delivery must not block the scheduler");
    return {name: "demo"};
  });
  const deliveries = () => f.sends.filter(send => send.method === "deliver");
  const spec = {scheduleId: "reminder", message: "Check weather", delaySeconds: 10, repeatEverySeconds: null, whenBusy: "queue"};
  assert.equal((await f.invoke(AgentScheduler.object.upsert, spec)).accepted, true);
  await f.invoke(AgentScheduler.object.fire, {scheduleId: "reminder"});
  assert.equal(deliveries().length, 0, "a stale invocation must not deliver");
  f.state.get("schedules")[0].timerId = "inv-test";
  await f.invoke(AgentScheduler.object.fire, {scheduleId: "reminder"});
  assert.equal(deliveries().length, 1);
  assert.equal(deliveries()[0].service, "Agent");
  assert.equal(deliveries()[0].key, "demo");
  assert.deepEqual(deliveries()[0].parameter, {source: "schedule", sourceId: "reminder", message: "Check weather", whenBusy: "queue", interruptReason: 'Scheduled message "reminder" became due', coalesce: true});
  assert.deepEqual(await f.invoke(AgentScheduler.object.list), []);
  await f.invoke(AgentScheduler.object.fire, {scheduleId: "reminder"});
  assert.equal(deliveries().length, 1, "late duplicate timers must not deliver again");
});

test("recurring schedules advance durable timers; retirement cancels all and prevents resurrection", async () => {
  const f = context("demo", {}, call => call.method === "metadata" ? {name: "demo"} : null);
  const spec = {scheduleId: "repeat", message: "Check", delaySeconds: 2, repeatEverySeconds: 60, whenBusy: "queue"};
  await f.invoke(AgentScheduler.object.upsert, spec);
  const firstTimer = f.state.get("schedules")[0].timerId;
  await f.invoke(AgentScheduler.object.upsert, spec);
  assert.ok(f.cancelled.includes(firstTimer));
  f.state.get("schedules")[0].timerId = "inv-test";
  await f.invoke(AgentScheduler.object.fire, {scheduleId: "repeat"});
  const next = f.state.get("schedules")[0];
  assert.notEqual(next.timerId, "inv-test");
  assert.equal(next.nextRunAt, 1700000060000);
  await f.invoke(AgentScheduler.object.retire);
  assert.ok(f.cancelled.includes(next.timerId));
  assert.equal((await f.invoke(AgentScheduler.object.upsert, spec)).accepted, false);
  assert.deepEqual(await f.invoke(AgentScheduler.object.list), []);
});

test("a directly invoked scheduler refuses child agents before creating a timer", async () => {
  const f = context("child", {}, call => {
    assert.equal(call.method, "metadata");
    return {name: "child", parentAgentId: "parent"};
  });
  const spec = {scheduleId: "reminder", message: "Check", delaySeconds: 2, repeatEverySeconds: null, whenBusy: "queue"};
  const result = await f.invoke(AgentScheduler.object.upsert, spec);
  assert.equal(result.accepted, false);
  assert.match(result.error, /Sub-agents cannot schedule/);
  assert.equal(f.sends.length, 0);
  assert.deepEqual(await f.invoke(AgentScheduler.object.list), []);
});

test("model schedule tools are authorized against the live, non-interrupting turn", async () => {
  const spec = {scheduleId: "reminder", message: "Check", delaySeconds: 2, repeatEverySeconds: null, whenBusy: "queue"};
  const accepted = {accepted: true, replaced: false, schedule: {...spec, delaySeconds: undefined, nextRunAt: 1}};
  const f = context("demo", {turn: {id: "turn", tools, steeringBatches: []}}, call => {
    assert.equal(call.service, "AgentScheduler");
    assert.equal(call.key, "demo");
    return call.method === "upsert" ? accepted : {accepted: true, cancelled: true};
  });
  await assert.rejects(f.invoke(Agent.object.createSchedule, {...spec, turnId: "old"}), /active, non-interrupting Turn/);
  await assert.rejects(f.invoke(Agent.object.cancelSchedule, {scheduleId: "reminder", turnId: "old"}), /active, non-interrupting Turn/);
  assert.equal(f.calls.length, 0);

  assert.equal((await f.invoke(Agent.object.createSchedule, {...spec, turnId: "turn"})).accepted, true);
  assert.deepEqual(f.calls.at(-1).parameter, spec, "the turn ID is not forwarded to the scheduler");
  assert.equal((await f.invoke(Agent.object.cancelSchedule, {scheduleId: "reminder", turnId: "turn"})).cancelled, true);
  assert.equal(f.calls.length, 2);

  f.state.get("turn").interruptReason = "Stop";
  await assert.rejects(f.invoke(Agent.object.createSchedule, {...spec, turnId: "turn"}), /active, non-interrupting Turn/);
  assert.equal(f.calls.length, 2, "an interrupted turn must not install a schedule");

  f.state.set("turn", {id: "turn", tools: {...tools, builtin: {mode: "selected", names: ["listSchedules"]}}, steeringBatches: []});
  await assert.rejects(f.invoke(Agent.object.createSchedule, {...spec, turnId: "turn"}), /cannot create schedules/);
  await assert.rejects(f.invoke(Agent.object.cancelSchedule, {scheduleId: "reminder", turnId: "turn"}), /cannot cancel schedules/);
  assert.equal(f.calls.length, 2);
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
