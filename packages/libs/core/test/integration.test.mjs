import assert from "node:assert/strict";
import {mock, test} from "node:test";

import * as durable from "@restatedev/restate-sdk-gen";

import {modelProvider} from "../src/model/provider.ts";
import {createPendingOperations} from "../src/session/pending.ts";
import {agentStep, executeCall, settleStep} from "../src/session/step.ts";
import * as agentTools from "../src/session/tools.ts";
import {runHandler} from "./harness.mjs";

const dynamic = {
  name: "lookupItems",
  description: "Lookup test items",
  inputSchema: {type: "object"},
  target: {
    service: "Catalog",
    handler: "lookup",
    keyed: true,
    acceptsInput: true,
  },
};
const mcp = {
  name: "mcp__test__lookup",
  description: "MCP lookup",
  inputSchema: {type: "object"},
  target: {
    server: {
      id: "test",
      url: "https://ptc.example/mcp",
      type: "http",
      tokenEnv: "TEST_MCP_TOKEN",
      protocol: "stateless",
      turnId: "turn",
      agentId: "test",
      timeoutMs: 1000,
    },
    remoteName: "lookup",
    definition: {name: "lookup", inputSchema: {type: "object"}},
    prior: {
      kind: "modern",
      discover: {
        supportedVersions: ["2026-07-28"],
        serverInfo: {name: "test", version: "1"},
        capabilities: {tools: {}},
      },
    },
  },
};
process.env.MCP_SERVERS_JSON = JSON.stringify([
  {
    id: "test",
    type: "http",
    url: "https://ptc.example/mcp",
    protocol: "stateless",
    tokenEnv: "TEST_MCP_TOKEN",
  },
]);
process.env.TEST_MCP_TOKEN = "test-env-token";

// Actual gen scheduler and core; outbound RPCs are journaled test fixtures.
// This keeps the tests offline while exercising the production tool dispatcher.
function contextWithFixtures(
  ctx,
  rpc,
  signals = () => ({decision: "approved"}),
) {
  let sequence = 0;
  return new Proxy(ctx, {
    get(target, key) {
      if (key === "genericCall" || key === "genericSend")
        return (opts) => {
          const name = `rpc-${sequence++}-${opts.service}-${opts.method}`;
          const invocationId = ctx.run(`${name}-id`, () => `inv_${name}`);
          if (key === "genericSend") {
            rpc(opts);
            return {invocationId};
          }
          return Object.assign(
            ctx.run(name, () => rpc(opts)),
            {invocationId},
          );
        };
      if (key === "signal")
        return (name) => ctx.run(`signal-${name}`, () => signals(name));
      if (key === "sleep")
        return (_duration, name) => ctx.run(name, () => null);
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

// Model calls are journaled runs inside the turn; replace the provider so the
// run records a fixture result instead of calling OpenAI.
function stubModel(t, {complete, guardrails = () => ({decision: "allow"})}) {
  t.mock.method(modelProvider, "completeAgent", async (request) =>
    complete(request),
  );
  t.mock.method(modelProvider, "evaluateGuardrails", async (request) =>
    guardrails(request),
  );
  t.mock.method(modelProvider, "confirmGuardrailDecision", async () => true);
}

function toolContext() {
  return {
    agentId: "test",
    permissions: {
      builtin: {mode: "all"},
      dynamic: {mode: "all"},
      mcp: [{serverId: "test", tools: {mode: "all"}}],
    },
    turnId: "turn",
    webSearchEnabled: true,
    sandbox: {
      *client() {
        throw new Error("sandbox not used");
      },
    },
  };
}

function history(entries) {
  return {
    context() {
      return {entries: []};
    },
    *append(...next) {
      entries.push(...next);
    },
  };
}

test("Agent grants constrain both direct execution and the PTC guest catalog", async () => {
  let externalCalls = 0;
  const result = await runHandler((ctx) =>
    durable.execute(
      contextWithFixtures(ctx, () => {
        externalCalls++;
        throw Error("unauthorized dispatch");
      }),
      durable.gen(function* () {
        const context = toolContext();
        context.permissions = {
          builtin: {mode: "selected", names: ["executeProgram", "getWeather"]},
          dynamic: {mode: "selected", names: []},
          mcp: [],
        };
        const catalog = agentTools
          .manifests([dynamic], [mcp], context)
          .map((t) => t.name);
        const direct = yield* agentTools.execute(
          {toolCallId: "denied", toolName: "lookupItems", input: {}},
          context,
          [dynamic],
          [mcp],
        );
        const program = yield* executeCall(
          {
            toolCallId: "outer",
            toolName: "executeProgram",
            input: {
              source:
                "async tools => ({dynamic:typeof tools.lookupItems, mcp:typeof tools.mcp__test__lookup, shell:typeof tools.executeCommand, weather:typeof tools.getWeather})",
            },
          },
          context,
          [dynamic],
          [mcp],
          {
            step: 1,
            transcript: history([]),
            *guard() {},
            *cancelPending() {
              throw Error("unused");
            },
          },
        );
        return {catalog, direct, program};
      }),
    ),
  );
  assert.deepEqual(result.output.catalog.sort(), [
    "executeProgram",
    "getWeather",
  ]);
  assert.equal(result.output.direct.status, "failed");
  assert.equal(result.output.program.status, "succeeded");
  assert.deepEqual(JSON.parse(result.output.program.result), {
    dynamic: "undefined",
    mcp: "undefined",
    shell: "undefined",
    weather: "function",
  });
  assert.equal(externalCalls, 0);
});

test("a removed operator connection prevents another MCP HTTP call", async (t) => {
  const previous = process.env.MCP_SERVERS_JSON;
  process.env.MCP_SERVERS_JSON = "[]";
  t.after(() => {
    process.env.MCP_SERVERS_JSON = previous;
  });
  const fetch = t.mock.method(globalThis, "fetch", () => {
    throw Error("must not contact removed connection");
  });
  const result = await runHandler((ctx) =>
    durable.execute(
      ctx,
      agentTools.execute(
        {toolCallId: "removed", toolName: mcp.name, input: {}},
        toolContext(),
        [],
        [structuredClone(mcp)],
      ),
    ),
  );
  assert.equal(result.output.status, "failed");
  assert.equal(fetch.mock.callCount(), 0);
});

test(
  "PTC dispatches static, dynamic and MCP tools with environment credentials and compact output",
  {
    timeout: 8000,
  },
  async () => {
    const entries = [],
      calls = [],
      guarded = [],
      requests = [];
    const fetch = mock.method(globalThis, "fetch", async (url, init) => {
      assert.equal(String(url), "https://ptc.example/mcp");
      const body = JSON.parse(init.body);
      const headers = new Headers(init.headers);
      requests.push({body, key: headers.get("Idempotency-Key")});
      assert.equal(headers.get("Authorization"), "Bearer test-env-token");
      assert.equal(body.method, "tools/call");
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          resultType: "complete",
          content: [{type: "text", text: "large intermediate result"}],
          structuredContent: {count: 7},
        },
      });
    });
    try {
      const result = await runHandler((ctx) =>
        durable.execute(
          contextWithFixtures(ctx, (opts) => {
            calls.push(opts);
            assert.equal(opts.service, "Catalog");
            assert.equal(opts.method, "lookup");
            assert.equal(opts.key, "tenant");
            assert.deepEqual(opts.parameter, {q: "test"});
            return {
              items: [{id: 1}, {id: 2}],
              raw: "do not put this in model context",
            };
          }),
          durable.gen(function* () {
            const context = toolContext();
            return yield* executeCall(
              {
                toolCallId: "outer",
                toolName: "executeProgram",
                input: {
                  source: `async tools => {
        const [weather, items, remote] = await Promise.all([
          tools.getWeather({city: 'Berlin'}),
          tools.lookupItems({key: 'tenant', input: {q: 'test'}}),
          tools.mcp__test__lookup({query: 'test'})
        ]);
        return {weather, ids: items.items.map(x => x.id), count: remote.structuredContent.count};
      }`,
                },
              },
              context,
              [dynamic],
              [structuredClone(mcp)],
              {
                transcript: history(entries),
                step: 1,
                *guard(call) {
                  guarded.push(call);
                },
                *cancelPending() {
                  throw new Error("unused");
                },
              },
            );
          }),
        ),
      );
      assert.equal(result.output.status, "succeeded", result.output.error);
      const {weather, ...summary} = JSON.parse(result.output.result);
      assert.match(weather, /^(?:[1-3]\d|40)°C, sunny in Berlin$/);
      assert.deepEqual(summary, {
        ids: [1, 2],
        count: 7,
      });
      assert.equal(calls.length, 1);
      assert.deepEqual(
        guarded.map((call) => call.toolName),
        ["getWeather", "lookupItems", "mcp__test__lookup"],
      );
      assert.equal(new Set(guarded.map((call) => call.toolCallId)).size, 3);
      assert.equal(requests.length, 1);
      assert.equal(requests[0].key, "turn:outer:call-2");
      assert.ok(
        !result.journal
          .map((frame) => frame.toString("utf8"))
          .join("")
          .includes("test-env-token"),
      );
      assert.ok(!JSON.stringify(entries).includes("large intermediate result"));
      assert.ok(!result.output.result.includes("raw"));
    } finally {
      fetch.mock.restore();
    }
  },
);

test(
  "only concrete subtools are policy checked, with normal human approval and pending completion",
  {
    timeout: 8000,
  },
  async (t) => {
    const source = `async tools => {
    const decision = await tools.humanApproval({question: 'May I continue?'});
    if (!decision.startsWith('Human approved')) return {decision};
    await tools.sleep({durationSeconds: 1});
    const values = await Promise.allSettled([
      tools.getWeather({city: 'Berlin'}), tools.getWeather({city: 'Paris'})
    ]);
    return values.map(x => x.status === 'fulfilled' ? x.value : x.reason.message);
  }`;
    async function attempt(replay = []) {
      const policies = [],
        approvals = [],
        entries = [],
        effects = [];
      const action = {
        type: "tool_calls",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "program",
              toolName: "executeProgram",
              input: {source},
            },
          ],
        },
        calls: [
          {toolCallId: "program", toolName: "executeProgram", input: {source}},
        ],
      };
      stubModel(t, {
        complete() {
          effects.push("complete");
          return action;
        },
        guardrails(request) {
          effects.push("evaluateGuardrails");
          const calls = request.action.calls;
          policies.push(...calls);
          assert.ok(calls.every((call) => call.toolName !== "executeProgram"));
          return calls.some((call) => call.input.city === "Paris")
            ? {
                decision: "deny",
                guardrailId: "cities",
                reason: "Paris is blocked",
              }
            : {decision: "allow"};
        },
      });
      const result = await runHandler(
        (ctx) =>
          durable.execute(
            contextWithFixtures(ctx, (opts) => {
              effects.push(opts.method);
              if (opts.method === "requestApproval") {
                approvals.push(opts.parameter);
                return true;
              }
              throw new Error(`Unexpected RPC ${opts.service}/${opts.method}`);
            }),
            durable.gen(function* () {
              return yield* agentStep({
                context: toolContext(),
                transcript: history(entries),
                messages: [],
                guardrailMessages: [],
                guardrails: [{id: "cities", rule: "Deny Paris"}],
                approvedActions: [],
                rejectedGuardrails: [],
                stepNumber: 1,
                discoveredTools: [],
                mcpTools: [],
                pending: createPendingOperations(),
                steering: durable.channel().receive,
              });
            }),
          ),
        {replay},
      );
      return {...result, policies, approvals, entries, effects};
    }
    const live = await attempt();
    assert.equal(live.output.type, "tools");
    assert.equal(
      live.output.outcomes[0].status,
      "succeeded",
      live.output.outcomes[0].error,
    );
    const results = JSON.parse(live.output.outcomes[0].result);
    assert.match(results[0], /^(?:[1-3]\d|40)°C, sunny in Berlin$/);
    assert.deepEqual(results.slice(1), ["Tool blocked: Paris is blocked"]);
    assert.deepEqual(
      live.policies.map((call) => call.toolName),
      ["humanApproval", "sleep", "getWeather", "getWeather"],
    );
    assert.equal(live.approvals.length, 1);
    assert.ok(live.entries.some((entry) => entry.type === "approval_request"));
    assert.ok(live.entries.some((entry) => entry.type === "approval"));
    const replay = await attempt(live.journal);
    assert.deepEqual(replay.output, live.output);
    assert.deepEqual(replay.entries, live.entries);
    assert.deepEqual(replay.effects, []);
  },
);

test("program failures are model repair results and do not invoke subtools", async () => {
  const result = await runHandler((ctx) =>
    durable.execute(
      ctx,
      durable.gen(function* () {
        return yield* executeCall(
          {
            toolCallId: "bad",
            toolName: "executeProgram",
            input: {source: "async tools => 1n"},
          },
          toolContext(),
          [],
          [],
          {
            transcript: history([]),
            step: 1,
            *guard() {
              throw new Error("no policy call for PTC itself");
            },
            *cancelPending() {
              throw new Error("unused");
            },
          },
        );
      }),
    ),
  );
  assert.equal(result.output.status, "failed");
  assert.match(result.output.error, /Program failed/);
});

test("PTC routes cancelOperation to the existing turn operation supervisor", async () => {
  const result = await runHandler((ctx) =>
    durable.execute(
      ctx,
      durable.gen(function* () {
        const call = {
          toolCallId: "old-timer",
          toolName: "sleep",
          input: {durationSeconds: 300},
        };
        return yield* executeCall(
          {
            toolCallId: "cancel",
            toolName: "executeProgram",
            input: {
              source:
                "async tools => tools.cancelOperation({operationId: 'old-timer', reason: 'stop'})",
            },
          },
          toolContext(),
          [],
          [],
          {
            transcript: history([]),
            step: 2,
            *guard() {},
            *cancelPending(outcome) {
              assert.equal(outcome.operationId, call.toolCallId);
              return {
                call: outcome.call,
                status: "succeeded",
                result: "Cancelled pending sleep operation old-timer",
              };
            },
          },
        );
      }),
    ),
  );
  assert.equal(result.output.status, "succeeded");
  assert.match(result.output.result, /Cancelled pending sleep/);
});

test(
  "turn interruption cancels a nested approval even between registration and its wait",
  {
    timeout: 8000,
  },
  async (t) => {
    const entries = [],
      cancellations = [];
    const source =
      "async tools => tools.humanApproval({question: 'Continue?'})";
    const call = {
      toolCallId: "program",
      toolName: "executeProgram",
      input: {source},
    };
    stubModel(t, {
      complete: () => ({
        type: "tool_calls",
        calls: [call],
        message: {role: "assistant", content: [{type: "tool-call", ...call}]},
      }),
    });
    const result = await runHandler((ctx) =>
      durable.execute(
        contextWithFixtures(ctx, (opts) => {
          if (opts.method === "requestApproval") return true;
          if (opts.method === "cancelApproval") {
            cancellations.push(opts.parameter);
            return null;
          }
          throw new Error(`Unexpected RPC: ${opts.method}`);
        }),
        durable.gen(function* () {
          const interrupt = durable.channel();
          const never = durable.channel();
          const transcript = {
            context() {
              return {entries: []};
            },
            *append(...next) {
              entries.push(...next);
              if (next.some((entry) => entry.type === "approval_request")) {
                yield* interrupt.send("User stopped the turn");
                yield* never.receive;
              }
            },
          };
          const task = durable.spawn(
            agentStep({
              context: toolContext(),
              transcript,
              messages: [],
              guardrailMessages: [],
              guardrails: [],
              approvedActions: [],
              rejectedGuardrails: [],
              stepNumber: 1,
              discoveredTools: [],
              mcpTools: [],
              pending: createPendingOperations(),
              steering: durable.channel().receive,
            }),
          );
          return yield* settleStep(task, interrupt.receive);
        }),
      ),
    );
    assert.equal(result.output.type, "interrupted");
    assert.deepEqual(cancellations, [
      {approvalId: "program:call-0", turnId: "turn"},
    ]);
    assert.ok(entries.some((entry) => entry.type === "approval_cancelled"));
    assert.ok(
      entries.some(
        (entry) =>
          entry.type === "tools" &&
          entry.calls.some((call) => call.status === "cancelled"),
      ),
    );
  },
);

test(
  "steering hands a still-running program to the turn instead of waiting for it",
  {
    timeout: 8000,
  },
  async (t) => {
    const program = {
      toolCallId: "program",
      toolName: "executeProgram",
      input: {
        source:
          "async tools => { await tools.sleep({durationSeconds: 60}); return 'program done'; }",
      },
    };
    const weather = {
      toolCallId: "weather",
      toolName: "getWeather",
      input: {city: "Berlin"},
    };
    stubModel(t, {
      complete: () => ({
        type: "tool_calls",
        calls: [program, weather],
        message: {
          role: "assistant",
          content: [program, weather].map((call) => ({
            type: "tool-call",
            ...call,
          })),
        },
      }),
    });
    const result = await runHandler((ctx) =>
      durable.execute(
        contextWithFixtures(ctx, () => {
          throw new Error("Unexpected RPC");
        }),
        durable.gen(function* () {
          const steering = durable.channel();
          const release = durable.channel();
          const never = durable.channel();
          let blocked = false;
          const transcript = {
            context() {
              return {entries: []};
            },
            // The program's nested sleep starts: steer, and hold the program
            // until the step has handed it off.
            *append(...next) {
              const sleeping = next.some(
                (entry) =>
                  entry.type === "tools" &&
                  entry.phase === "started" &&
                  entry.calls[0]?.name === "sleep",
              );
              if (sleeping && !blocked) {
                blocked = true;
                yield* steering.send();
                yield* release.receive;
              }
            },
          };
          const pending = createPendingOperations();
          const step = yield* agentStep({
            context: toolContext(),
            transcript,
            messages: [],
            guardrailMessages: [],
            guardrails: [],
            approvedActions: [],
            rejectedGuardrails: [],
            stepNumber: 1,
            discoveredTools: [],
            mcpTools: [],
            pending,
            steering: steering.receive,
          });
          const applied = yield* pending.apply(
            step.outcomes,
            toolContext(),
            step.step,
            step.handoffs,
          );
          yield* release.send();
          const completion = yield* pending.next(never.receive, never.receive);
          return {
            outcomes: step.outcomes.map(({call, status, result}) => ({
              id: call.toolCallId,
              status,
              running: result?.status === "running",
            })),
            handedOff: [...step.handoffs.keys()],
            registered: pending.size,
            applied: applied.outcomes.length,
            completion,
          };
        }),
      ),
    );
    assert.deepEqual(result.output.outcomes, [
      {id: "program", status: "pending", running: true},
      {id: "weather", status: "succeeded", running: false},
    ]);
    assert.deepEqual(result.output.handedOff, ["program"]);
    assert.equal(result.output.completion.type, "completion");
    assert.equal(result.output.completion.event.call.toolCallId, "program");
    assert.deepEqual(result.output.completion.event.outcome, {
      status: "succeeded",
      result: JSON.stringify("program done"),
    });
  },
);
