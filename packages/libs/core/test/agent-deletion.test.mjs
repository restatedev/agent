import assert from "node:assert/strict";
import {mock, test} from "node:test";

import * as durable from "@restatedev/restate-sdk-gen";

import {Agent} from "../src/agent/service.ts";
import {sandboxProvider} from "../src/sandbox/provider.ts";
import {openTurnSandbox} from "../src/sandbox/turn.ts";
import {AgentSession} from "../src/session/service.ts";
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
  assert.ok(f.state.get("notifications").versions.approvals > 0);
  for (const key of ["memories", "profile/instructions", "sub-agent-tasks"])
    assert.equal(f.state.has(key), false, key);
  assert.deepEqual((await f.invoke(Agent.object.profile)).memories, []);
  assert.equal((await f.invoke(Agent.object.profile)).instructions, undefined);
  assert.equal(f.state.get("turn").interruptReason, "Agent deleted");
  assert.equal(f.signals[0].id, "turn-1");
  assert.ok(
    f.sends.some((s) => s.service === "AgentSession" && s.method === "retire"),
  );
  await assert.rejects(
    f.invoke(Agent.object.ask, {message: "restart"}),
    /deleted/,
  );
  await assert.rejects(
    f.invoke(Agent.object.initialize, {name: "A"}),
    /deleted/,
  );
  await f.invoke(Agent.object.deliver, {
    source: "schedule",
    message: "late",
    whenBusy: "queue",
  });
  assert.equal(f.state.has("pending"), false);
});

test("only the parent can retire a child", async () => {
  const f = context("child", {
    metadata: {name: "Child", parentAgentId: "parent"},
  });
  await assert.rejects(f.invoke(Agent.object.retire, {}), /Only the parent/);
  assert.equal(f.state.has("deleted"), false);
});

test("late turn completion cannot dispatch recovered steering or queued work", async () => {
  const f = context("a", {
    deleted: true,
    turn: {
      id: "turn-1",
      interruptReason: "Agent deleted",
      tools: {},
      steeringBatches: [{queued: [], message: "late steering"}],
    },
    pending: [{role: "user", text: "late queued message", delivery: "queued"}],
  });
  const result = await f.invoke(Agent.object.onTurnEnd, {
    turnId: "turn-1",
    status: "completed",
    consumedSteering: 0,
  });
  assert.equal(result.status, "interrupted");
  assert.equal(f.state.has("turn"), false);
  assert.equal(f.state.has("pending"), false);
  assert.ok(!f.sends.some((s) => s.method === "doTurn"));
});

test("AgentSession retirement destroys the stored sandbox once", async () => {
  const destroy = mock.method(sandboxProvider, "destroy", async () => {});
  try {
    const f = context("a", {sandbox: {provider: "local", root: "/test-only"}});
    await f.invoke(AgentSession.object.retire);
    assert.equal(destroy.mock.callCount(), 1);
    assert.equal(f.state.has("sandbox"), false);
    await f.invoke(AgentSession.object.retire);
    assert.equal(destroy.mock.callCount(), 1);
  } finally {
    destroy.mock.restore();
  }
});

// Runs one turn's sandbox usage inside a real exclusive handler.
const TurnProbe = durable.object({
  name: "TurnProbe",
  handlers: {
    *run(uses) {
      const sandbox = openTurnSandbox("a");
      yield* durable.all(
        Array.from({length: uses}, () => durable.spawn(sandbox.client())),
      );
      yield* sandbox.release();
      yield* sandbox.release();
    },
  },
});

function mockLifecycle() {
  const mocks = {
    provision: mock.method(sandboxProvider, "provision", async () => ({
      provider: "local",
      root: "/provisioned",
    })),
    resume: mock.method(sandboxProvider, "resume", async (ref) => ({
      ...ref,
      resumed: true,
    })),
    suspend: mock.method(
      sandboxProvider,
      "suspend",
      async ({resumed: _resumed, ...ref}) => ({...ref, suspended: true}),
    ),
    connect: mock.method(sandboxProvider, "connect", () => ({})),
  };
  return {
    ...mocks,
    restore: () => Object.values(mocks).forEach((m) => m.mock.restore()),
  };
}

test("a turn provisions its sandbox once for parallel tools and suspends it at the end", async () => {
  const m = mockLifecycle();
  try {
    const f = context("a");
    await f.invoke(TurnProbe.object.run, 3);
    assert.equal(m.provision.mock.callCount(), 1);
    assert.equal(m.suspend.mock.callCount(), 1);
    assert.deepEqual(f.state.get("sandbox"), {
      provider: "local",
      root: "/provisioned",
      suspended: true,
    });
  } finally {
    m.restore();
  }
});

test("a later turn resumes the stored sandbox instead of provisioning", async () => {
  const m = mockLifecycle();
  try {
    const f = context("a", {sandbox: {provider: "local", root: "/kept"}});
    await f.invoke(TurnProbe.object.run, 1);
    assert.equal(m.provision.mock.callCount(), 0);
    assert.equal(m.resume.mock.callCount(), 1);
    assert.deepEqual(f.state.get("sandbox"), {
      provider: "local",
      root: "/kept",
      suspended: true,
    });
  } finally {
    m.restore();
  }
});

test("a turn that never uses the sandbox does not touch it", async () => {
  const m = mockLifecycle();
  try {
    const f = context("a", {sandbox: {provider: "local", root: "/kept"}});
    await f.invoke(TurnProbe.object.run, 0);
    assert.equal(m.resume.mock.callCount() + m.suspend.mock.callCount(), 0);
  } finally {
    m.restore();
  }
});

// Regression: the acquisition used to be a task spawned by the first tool, so
// interrupting that tool (a PTC race loser) cascaded into it and every other
// sandbox tool of the turn inherited the rejection.
let provisionStarted;
const InterruptProbe = durable.object({
  name: "InterruptProbe",
  handlers: {
    *run() {
      const sandbox = openTurnSandbox("a");
      const first = durable.spawn(sandbox.client());
      const second = durable.spawn(sandbox.client());
      yield* durable.run(() => provisionStarted, {name: "wait-provision"});
      first.interrupt();
      const [interrupted] = yield* durable.allSettled([first]);
      const [waiter] = yield* durable.allSettled([second]);
      const [later] = yield* durable.allSettled([
        durable.spawn(sandbox.client()),
      ]);
      yield* sandbox.release();
      return {
        interrupted: interrupted.status,
        waiter: waiter.status,
        later: later.status,
      };
    },
  },
});

test("interrupting the tool that started acquisition does not fail the turn's other sandbox tools", async () => {
  let started;
  provisionStarted = new Promise((resolve) => {
    started = resolve;
  });
  const m = mockLifecycle();
  m.provision.mock.mockImplementation(({signal}) => {
    if (m.provision.mock.callCount() > 0)
      return Promise.resolve({provider: "local", root: "/provisioned"});
    started();
    return new Promise((_, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason)),
    );
  });
  try {
    const f = context("a");
    const result = await f.invoke(InterruptProbe.object.run);
    assert.deepEqual(result, {
      interrupted: "rejected",
      waiter: "fulfilled",
      later: "fulfilled",
    });
    assert.equal(m.suspend.mock.callCount(), 1);
    assert.deepEqual(f.state.get("sandbox"), {
      provider: "local",
      root: "/provisioned",
      suspended: true,
    });
  } finally {
    m.restore();
  }
});
