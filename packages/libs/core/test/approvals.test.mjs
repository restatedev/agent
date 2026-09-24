import assert from "node:assert/strict";
import {test} from "node:test";
import {Agent} from "../src/agent/service.ts";
import {context} from "./state-fixture.mjs";

const tools = {builtin: {mode: "all"}, dynamic: {mode: "all"}, mcp: []};

function activeTurn(turnId, extra = {}) {
  return {turn: {id: turnId, tools, steeringBatches: [], ...extra}};
}

function approval(approvalId, turnId = "turn") {
  return {approvalId, turnId, question: "Send the email?"};
}

test("an approval is registered once and resolved into a signal to its turn", async () => {
  const f = context("demo", activeTurn("turn"));

  assert.equal(await f.invoke(Agent.object.requestApproval, approval("a1")), true);
  // Registering the identical request again is idempotent.
  assert.equal(await f.invoke(Agent.object.requestApproval, approval("a1")), true);
  assert.deepEqual(await f.invoke(Agent.object.approvals), [approval("a1")]);

  const resolved = await f.invoke(Agent.object.resolveApproval, {
    approvalId: "a1",
    decision: "approved",
    reason: "looks fine",
  });

  assert.equal(resolved, true);
  assert.deepEqual(await f.invoke(Agent.object.approvals), []);
  const [signal] = f.signals;
  assert.equal(signal.id, "turn");
  assert.deepEqual(signal.value, {decision: "approved", reason: "looks fine"});
});

test("a conflicting request reusing an approval ID is rejected", async () => {
  const f = context("demo", activeTurn("turn"));
  await f.invoke(Agent.object.requestApproval, approval("a1"));

  const conflicting = {...approval("a1"), question: "Delete everything?"};

  assert.equal(await f.invoke(Agent.object.requestApproval, conflicting), false);
  assert.deepEqual(await f.invoke(Agent.object.approvals), [approval("a1")]);
});

test("only the active, non-interrupting turn can register or receive approvals", async () => {
  const otherTurn = context("demo", activeTurn("turn"));
  assert.equal(
    await otherTurn.invoke(Agent.object.requestApproval, approval("a1", "old-turn")),
    false,
  );

  const interrupting = context("demo", {
    ...activeTurn("turn", {interruptReason: "stop"}),
    approvals: [approval("a1")],
  });
  const resolved = await interrupting.invoke(Agent.object.resolveApproval, {
    approvalId: "a1",
    decision: "approved",
  });
  assert.equal(resolved, false);
  assert.equal(interrupting.signals.length, 0);
});

test("resolving an unknown approval, or cancelling another turn's, changes nothing", async () => {
  const f = context("demo", {...activeTurn("turn"), approvals: [approval("a1")]});

  const resolved = await f.invoke(Agent.object.resolveApproval, {
    approvalId: "missing",
    decision: "rejected",
  });
  await f.invoke(Agent.object.cancelApproval, {approvalId: "a1", turnId: "other"});

  assert.equal(resolved, false);
  assert.deepEqual(await f.invoke(Agent.object.approvals), [approval("a1")]);

  await f.invoke(Agent.object.cancelApproval, {approvalId: "a1", turnId: "turn"});
  assert.deepEqual(await f.invoke(Agent.object.approvals), []);
});
