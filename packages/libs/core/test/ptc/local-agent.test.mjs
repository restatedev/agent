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
  assert.deepEqual(deliveries()[0].parameter, {source: "schedule", sourceId: "reminder", message: "Check weather", whenBusy: "queue", interruptReason: 'Scheduled message "reminder" became due'});
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
