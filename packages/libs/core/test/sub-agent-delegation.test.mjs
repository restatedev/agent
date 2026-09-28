import assert from "node:assert/strict";
import {test} from "node:test";

import {TerminalError} from "@restatedev/restate-sdk";
import * as durable from "@restatedev/restate-sdk-gen";

import {Agent} from "../src/agent/service.ts";
import {executeCall} from "../src/session/step.ts";
import * as tools from "../src/session/tools.ts";
import {runHandler} from "./harness.mjs";
import {context} from "./state-fixture.mjs";

const grants = {
  builtin: {mode: "all"},
  dynamic: {mode: "selected", names: []},
  mcp: [],
};
const owner = {name: "Parent"};
const active = {id: "parent-turn", tools: grants, steeringBatches: []};
const request = {
  turnId: "parent-turn",
  toolCallId: "call-1",
  agentId: "child",
  message: "Research",
  source: "messageSubAgent",
};
const task = {...request, childTurnId: "child-turn"};
const child = {agentId: "child", name: "Research", parentAgentId: "parent"};

test("parent starts only a direct child and registers the exact turn for cleanup", async () => {
  const f = context(
    "parent",
    {metadata: owner, turn: active, children: [child]},
    (call) => {
      assert.equal(call.method, "startDelegatedTurn");
      assert.equal(call.key, "child");
      assert.deepEqual(call.parameter, {
        parentAgentId: "parent",
        parentTurnId: "parent-turn",
        message: "Research",
      });
      return {turnId: "child-turn"};
    },
  );
  assert.deepEqual(await f.invoke(Agent.object.startSubAgentTask, request), {
    turnId: "child-turn",
  });
  assert.deepEqual(await f.invoke(Agent.object.startSubAgentTask, request), {
    turnId: "child-turn",
  });
  assert.equal(
    f.calls.filter((call) => call.method === "startDelegatedTurn").length,
    1,
  );
  assert.equal(f.state.get("sub-agent-tasks")[0].childTurnId, "child-turn");
  for (const agentId of ["parent", "unrelated", "bob-child"])
    await assert.rejects(
      f.invoke(Agent.object.startSubAgentTask, {...request, agentId}),
      /direct child/,
    );
  await assert.rejects(
    f.invoke(Agent.object.startSubAgentTask, {
      ...request,
      source: "createSubAgent",
    }),
    /newly created/,
  );
  f.state.set("turn", {...active, interruptReason: "Stop"});
  await assert.rejects(
    f.invoke(Agent.object.startSubAgentTask, request),
    /non-interrupting/,
  );
});

test("child rejects foreign parents, direct user messages, and overlapping tasks", async () => {
  const f = context("child", {
    metadata: {...owner, parentAgentId: "parent"},
    turn: {id: "child-turn", tools: grants, steeringBatches: []},
  });
  const input = {
    parentAgentId: "parent",
    parentTurnId: "turn",
    message: "Follow up",
  };
  for (const wrong of [{parentAgentId: "other"}])
    await assert.rejects(
      f.invoke(Agent.object.startDelegatedTurn, {...input, ...wrong}),
      /owning parent/,
    );
  await assert.rejects(
    f.invoke(Agent.object.startDelegatedTurn, input),
    /busy/,
  );
  await assert.rejects(
    f.invoke(Agent.object.ask, {message: "Bypass parent"}),
    /top-level agent/,
  );
  await assert.rejects(
    f.invoke(Agent.object.steer, {message: "Bypass parent"}),
    /top-level agent/,
  );
  await assert.rejects(
    f.invoke(Agent.object.interrupt, {reason: "stop", message: "Replacement"}),
    /read-only/,
  );
  await assert.rejects(
    f.invoke(Agent.object.deliver, {
      message: "Bypass",
      whenBusy: "queue",
      source: "schedule",
    }),
    /top-level agent/,
  );
  assert.equal(
    await f.invoke(Agent.object.interrupt, {
      reason: "User injected instruction",
    }),
    true,
  );
  assert.equal(f.state.get("turn").interruptReason, "Interrupted by the user");
  assert.equal(f.calls.length, 0);
});

test("interrupt, turn end, retirement, and abandoned waits send idempotent exact-turn cleanup", async () => {
  for (const [handler, input] of [
    [Agent.object.interrupt, {reason: "Stop"}],
    [
      Agent.object.onTurnEnd,
      {
        turnId: "parent-turn",
        status: "completed",
        response: "Done",
        consumedSteering: 0,
      },
    ],
    [Agent.object.retire, {}],
    [
      Agent.object.finishSubAgentTask,
      {turnId: "parent-turn", toolCallId: "call-1"},
    ],
  ]) {
    const f = context("parent", {
      metadata: owner,
      turn: active,
      "sub-agent-tasks": [task],
    });
    await f.invoke(handler, input);
    const cleanup = f.sends.filter(
      (call) => call.method === "interruptDelegatedTurn",
    );
    assert.equal(cleanup.length, 1);
    assert.equal(cleanup[0].key, "child");
    assert.equal(cleanup[0].parameter.turnId, "child-turn");
    assert.equal(cleanup[0].parameter.parentAgentId, "parent");
    assert.deepEqual(f.state.get("sub-agent-tasks") ?? [], []);
    await f.invoke(Agent.object.finishSubAgentTask, {
      turnId: "parent-turn",
      toolCallId: "call-1",
    });
    assert.equal(
      f.sends.filter((call) => call.method === "interruptDelegatedTurn").length,
      1,
    );
  }
  const c = context("child", {
    metadata: {...owner, parentAgentId: "parent"},
    turn: {id: "new-turn", tools: grants, steeringBatches: []},
  });
  await c.invoke(Agent.object.interruptDelegatedTurn, {
    parentAgentId: "parent",
    turnId: "child-turn",
    reason: "Late cleanup",
  });
  assert.equal(c.signals.length, 0);
  assert.equal(c.state.get("turn").interruptReason, undefined);
  await assert.rejects(
    c.invoke(Agent.object.interruptDelegatedTurn, {
      parentAgentId: "other",
      turnId: "new-turn",
      reason: "Stop",
    }),
    /direct child/,
  );
  await c.invoke(Agent.object.interruptDelegatedTurn, {
    parentAgentId: "parent",
    turnId: "new-turn",
    reason: "Stop",
  });
  assert.equal(c.state.get("turn").interruptReason, "Stop");
});

// Real generator execution and recorded results, with transport replaced at
// the context boundary. Replay must neither start nor run a child again.
async function runDelegation({
  outcome,
  replay,
  ptc = false,
  create = false,
  interrupted = false,
  childFailure,
  calls = [],
}) {
  return runHandler(
    (ctx) =>
      durable.execute(
        {
          ...ctx,
          request: () => ctx.request(),
          run: (...args) => ctx.run(...args),
          genericCall(opts) {
            return Object.assign(
              ctx.run(`rpc-${opts.method}`, () => {
                calls.push(opts);
                assert.equal(opts.key, "parent");
                if (opts.method === "createSubAgent") return child;
                assert.equal(opts.method, "startSubAgentTask");
                return {turnId: "child-turn"};
              }),
              {invocationId: ctx.run(`id-${opts.method}`, () => "rpc-id")},
            );
          },
          attach(id) {
            assert.equal(id, "child-turn");
            if (interrupted) throw new durable.InterruptedError();
            return ctx.run("child-result", () => {
              calls.push({method: "child-result"});
              if (childFailure) throw childFailure;
              return outcome;
            });
          },
          genericSend(opts) {
            assert.equal(opts.method, "finishSubAgentTask");
            assert.equal(opts.parameter.turnId, "parent-turn");
            return {
              invocationId: ctx.run("cleanup", () => {
                calls.push(opts);
                return "cleanup-id";
              }),
            };
          },
        },
        durable.gen(function* () {
          const toolContext = tools.createAgentToolContext(
            "parent",
            "parent-turn",
            true,
            grants,
            "alice",
          );
          const toolName = create ? "createSubAgent" : "messageSubAgent";
          const input = create
            ? {
                name: "Research",
                instructions: null,
                guardrails: null,
                tools: null,
                webSearchEnabled: null,
                initialMessage: "Research",
              }
            : {agentId: "child", message: "Follow up"};
          const call = ptc
            ? {
                toolName: "executeProgram",
                toolCallId: "ptc",
                input: {
                  source: `async tools => await tools.${toolName}(${JSON.stringify(input)})`,
                },
              }
            : {toolName, toolCallId: "call-1", input};
          const scope = {
            transcript: {*append() {}},
            step: 1,
            *guard() {},
            *cancelPending() {},
          };
          try {
            return yield* executeCall(call, toolContext, [], [], scope);
          } catch (error) {
            return {interrupted: error instanceof durable.InterruptedError};
          }
        }),
      ),
    {replay},
  );
}

test("creation and follow-ups return child answers, including PTC, and replay without rerunning children", async () => {
  const outcome = {
    turnId: "child-turn",
    status: "completed",
    response: "Research findings",
    consumedSteering: 0,
  };
  for (const create of [false, true])
    for (const ptc of [false, true]) {
      const calls = [];
      const live = await runDelegation({outcome, create, ptc, calls});
      assert.equal(live.output.status, "succeeded");
      assert.equal(
        JSON.parse(live.output.result).response,
        "Research findings",
      );
      assert.ok(calls.find((call) => call.method === "child-result"));
      assert.ok(calls.find((call) => call.method === "finishSubAgentTask"));
      const replayCalls = [];
      const replay = await runDelegation({
        outcome,
        create,
        ptc,
        calls: replayCalls,
        replay: live.journal,
      });
      assert.deepEqual(replay.output, live.output);
      assert.deepEqual(replayCalls, []);
    }
});

test("child failure/interruption becomes a recoverable tool result; parent interruption still escapes with cleanup", async () => {
  for (const outcome of [
    {
      turnId: "child-turn",
      status: "failed",
      error: "Research failed",
      consumedSteering: 0,
    },
    {
      turnId: "child-turn",
      status: "interrupted",
      reason: "User stopped child",
      consumedSteering: 0,
    },
  ]) {
    const {output} = await runDelegation({outcome});
    assert.equal(output.status, "failed");
    assert.match(output.error, /Research failed|User stopped child/);
  }
  const calls = [];
  const {output} = await runDelegation({interrupted: true, calls});
  assert.equal(output.interrupted, true);
  assert.ok(calls.some((call) => call.method === "finishSubAgentTask"));
});

test("a child cancelled from outside is a failed tool result, not the parent's cancellation", async () => {
  for (const ptc of [false, true]) {
    const cancelled = new TerminalError("Cancelled", {errorCode: 409});
    const {output} = await runDelegation({childFailure: cancelled, ptc});

    assert.equal(output.status, "failed");
    if (ptc) {
      assert.match(output.error, /Program failed/);
    } else {
      assert.deepEqual(JSON.parse(output.error), {
        agentId: "child",
        status: "cancelled",
        error: "Cancelled",
      });
    }
  }
});
