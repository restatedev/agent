import assert from "node:assert/strict";
import {mock, test} from "node:test";
import {Agent} from "../../src/agent/service.ts";
import {Sandbox} from "../../src/sandbox/service.ts";
import {sandboxProvider} from "../../src/sandbox/provider.ts";
import {context} from "./state-fixture.mjs";

test("retirement interrupts the turn, drops queued work, and asynchronously retires resources", async () => {
  const f = context("a", {
    metadata: {name: "A"},
    turn: {id: "turn-1", steeringBatches: [], tools: {}},
    pending: [{role: "user", text: "queued"}],
    approvals: [{turnId: "turn-1", approvalId: "approval"}],
    memories: [{key: "secret", content: "private"}],
    "profile/instructions": "Be terse",
    "sub-agent-tasks": [],
  });
  await f.invoke(Agent.object.retire, {});
  const sendsAfterRetire = f.sends.length;
  await f.invoke(Agent.object.retire, {});
  assert.equal(f.sends.length, sendsAfterRetire);
  assert.equal(f.state.get("deleted"), true);
  assert.equal(f.state.has("pending"), false);
  assert.equal(f.state.has("approvals"), false);
  assert.ok(f.sends.some(s => s.service === "AgentNotifications" && s.parameter === "approvals"));
  for (const key of ["memories", "profile/instructions", "sub-agent-tasks"]) assert.equal(f.state.has(key), false, key);
  assert.deepEqual((await f.invoke(Agent.object.profile)).memories, []);
  assert.equal((await f.invoke(Agent.object.profile)).instructions, undefined);
  assert.equal(f.state.get("turn").interruptReason, "Agent deleted");
  assert.equal(f.signals[0].id, "turn-1");
  assert.ok(f.sends.some(s => s.service === "Sandbox" && s.method === "retire"));
  await assert.rejects(f.invoke(Agent.object.ask, {message: "restart"}), /deleted/);
  await assert.rejects(f.invoke(Agent.object.initialize, {name: "A"}), /deleted/);
  await f.invoke(Agent.object.deliver, {source: "schedule", message: "late", whenBusy: "queue"});
  assert.equal(f.state.has("pending"), false);
});

test("only the parent can retire a child", async () => {
  const f = context("child", {metadata: {name: "Child", parentAgentId: "parent"}});
  await assert.rejects(f.invoke(Agent.object.retire, {}), /Only the parent/);
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
