import assert from "node:assert/strict";
import {mock, test} from "node:test";
import {User} from "../../src/user/service.ts";
import {Agent} from "../../src/agent/service.ts";
import {AgentScheduler} from "../../src/scheduler/service.ts";
import {Sandbox} from "../../src/sandbox/service.ts";
import {sandboxProvider} from "../../src/sandbox/provider.ts";
import {context} from "./state-fixture.mjs";

test("deleting an owned agent revokes membership, retains connections and queues cleanup", async () => {
  const f = context("alice", {agents: [{agentId: "a", name: "A"}, {agentId: "b", name: "B"}], connections: [{server: {id: "notion"}}]});
  assert.equal(await f.invoke(User.object.deleteAgent, {agentId: "a"}), true);
  assert.deepEqual(f.state.get("agents"), [{agentId: "b", name: "B"}]);
  assert.equal(f.state.get("connections").length, 1);
  assert.equal(f.state.get("deleted-agent:a"), true);
  assert.deepEqual(f.sends.map(({service, key, method, parameter}) => ({service, key, method, parameter})), [{service: "Agent", key: "a", method: "retire", parameter: {ownerUserId: "alice"}}, {service: "UserNotifications", key: "alice", method: "publish", parameter: {kind: "profile"}}]);
  assert.equal(await f.invoke(User.object.ownsAgent, {agentId: "a"}), false);
  assert.equal(await f.invoke(User.object.deleteAgent, {agentId: "a"}), false);
  assert.equal(f.sends.length, 2);
});

test("deletion cannot target another user's agent", async () => {
  const f = context("alice", {agents: [{agentId: "a", name: "A"}]});
  assert.equal(await f.invoke(User.object.deleteAgent, {agentId: "bob-agent"}), false);
  assert.equal(f.sends.length, 0);
  assert.equal(f.state.get("agents").length, 1);
});

test("late create retries cannot resurrect a deleted agent", async () => {
  const f = context("alice", {"deleted-agent:a": true});
  await assert.rejects(f.invoke(User.object.createAgent, {agentId: "a", name: "A"}), /deleted/);
  assert.equal(f.sends.length, 0);
});

test("deletion removes only that agent's authorization waiters", async () => {
  const f = context("alice", {
    agents: [{agentId: "a", name: "A"}],
    authorizations: [
      {manual: false, waiters: [{agentId: "a"}]},
      {manual: false, waiters: [{agentId: "a"}, {agentId: "b"}]},
      {manual: true, waiters: [{agentId: "a"}]},
    ],
  });
  await f.invoke(User.object.deleteAgent, {agentId: "a"});
  assert.deepEqual(f.state.get("authorizations"), [
    {manual: false, waiters: [{agentId: "b"}]}, {manual: true, waiters: []},
  ]);
});

test("retirement interrupts the turn, drops queued work, and asynchronously retires resources", async () => {
  const f = context("a", {
    ownership: {ownerUserId: "alice", name: "A"},
    turn: {id: "turn-1", steeringBatches: [], tools: {}},
    pending: [{role: "user", text: "queued"}],
    approvals: [{turnId: "turn-1", approvalId: "approval"}],
  });
  await f.invoke(Agent.object.retire, {ownerUserId: "alice"});
  assert.equal(f.state.get("deleted"), true);
  assert.equal(f.state.has("pending"), false);
  assert.equal(f.state.has("approvals"), false);
  assert.equal(f.state.get("turn").interruptReason, "Agent deleted");
  assert.equal(f.signals[0].id, "turn-1");
  assert.ok(f.sends.some(s => s.service === "AgentScheduler" && s.method === "retire"));
  assert.ok(f.sends.some(s => s.service === "Sandbox" && s.method === "retire"));
  await assert.rejects(f.invoke(Agent.object.ask, {message: "restart"}), /deleted/);
  await assert.rejects(f.invoke(Agent.object.initialize, {ownerUserId: "alice", name: "A"}), /deleted/);
  await f.invoke(Agent.object.deliver, {source: "schedule", message: "late", whenBusy: "queue"});
  assert.equal(f.state.has("pending"), false);
});

test("retirement checks immutable ownership", async () => {
  const f = context("a", {ownership: {ownerUserId: "alice"}});
  await assert.rejects(f.invoke(Agent.object.retire, {ownerUserId: "bob"}), /belong/);
  assert.equal(f.state.has("deleted"), false);
});

test("late turn completion cannot dispatch recovered steering or queued work", async () => {
  const f = context("a", {
    deleted: true,
    turn: {id: "turn-1", interruptReason: "Agent deleted", tools: {}, steeringBatches: [{queued: [], message: "late steering"}]},
    pending: [{role: "user", text: "late queued message", delivery: "queued"}],
  });
  const result = await f.invoke(Agent.object.onTurnEnd, {turnId: "turn-1", status: "completed", consumedSteering: 0});
  assert.equal(result.status, "interrupted");
  assert.equal(f.state.has("turn"), false);
  assert.equal(f.state.has("pending"), false);
  assert.ok(!f.sends.some(s => s.method === "doTurn"));
});

test("idle sandbox retirement cancels its timer and destroys its resources", async () => {
  const destroy = mock.method(sandboxProvider, "destroy", async () => {});
  try {
    const f = context("a", {sandbox: {status: "idle", timerId: "timer-1", ref: {provider: "local", root: "/test-only"}}});
    await f.invoke(Sandbox.object.retire);
    assert.deepEqual(f.cancelled, ["timer-1"]);
    assert.equal(destroy.mock.callCount(), 1);
    assert.equal(f.state.has("sandbox"), false);
    assert.equal(f.state.get("deleted"), true);
  } finally { destroy.mock.restore(); }
});

test("retired scheduler cancels timers and rejects future schedules", async () => {
  const f = context("a", {schedules: [{scheduleId: "s", timerId: "timer-1"}]});
  await f.invoke(AgentScheduler.object.retire);
  assert.deepEqual(f.cancelled, ["timer-1"]);
  assert.equal(f.state.has("schedules"), false);
  assert.equal((await f.invoke(AgentScheduler.object.upsert, {})).accepted, false);
  await f.invoke(AgentScheduler.object.fire, {scheduleId: "s"});
  assert.ok(!f.sends.some(s => s.method === "deliver"));
});

test("borrowed sandbox is destroyed only after its turn releases it", async () => {
  const destroy = mock.method(sandboxProvider, "destroy", async () => {});
  try {
    const f = context("a", {sandbox: {status: "borrowed", turnId: "turn-1", ref: {provider: "local", root: "/test-only"}}});
    await f.invoke(Sandbox.object.retire);
    assert.equal(destroy.mock.callCount(), 0);
    await assert.rejects(f.invoke(Sandbox.object.borrow, {turnId: "turn-2"}), /deleted/);
    await f.invoke(Sandbox.object.release, {turnId: "other"});
    assert.equal(destroy.mock.callCount(), 0);
    await f.invoke(Sandbox.object.release, {turnId: "turn-1"});
    assert.equal(destroy.mock.callCount(), 1);
    assert.equal(f.state.has("sandbox"), false);
    await f.invoke(Sandbox.object.retire);
    assert.equal(destroy.mock.callCount(), 1);
  } finally { destroy.mock.restore(); }
});
