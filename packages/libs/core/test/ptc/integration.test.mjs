import assert from "node:assert/strict";
import {mock, test} from "node:test";
import * as durable from "@restatedev/restate-sdk-gen";
import {agentStep, settleStep} from "../../src/session/step.ts";
import * as agentTools from "../../src/session/tools.ts";
import {createPendingOperations} from "../../src/session/pending.ts";
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
      endpoint: "https://ptc.example/mcp",
      protocol: "stateless",
      auth: "bearer",
      turnId: "turn",
      timeoutMs: 1000,
      credential: {serverId: "test", accessToken: "old-test-token"},
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

function toolContext() {
  return {
    agentId: "test",
    turnId: "turn",
    sandbox: {
      *client() {
        throw new Error("sandbox not used");
      },
    },
    mcpAuthorization: {
      *authorize() {
        throw new Error("unexpected authorization");
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

test("PTC dispatches static, dynamic and MCP tools with auth retry and compact output", {
  timeout: 8000,
}, async () => {
  const entries = [],
    calls = [],
    guarded = [],
    requests = [];
  let auths = 0;
  const fetch = mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(String(url), "https://ptc.example/mcp");
    const body = JSON.parse(init.body);
    const headers = new Headers(init.headers);
    requests.push({body, key: headers.get("Idempotency-Key")});
    if (headers.get("Authorization") === "Bearer old-test-token")
      return new Response("unauthorized", {status: 401});
    assert.equal(headers.get("Authorization"), "Bearer new-test-token");
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
          context.mcpAuthorization = {
            *authorize(serverId) {
              auths++;
              return {
                credential: {serverId, accessToken: "new-test-token"},
                challenge: {status: "authorization_required"},
              };
            },
          };
          return yield* agentTools.execute(
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
    assert.deepEqual(JSON.parse(result.output.result), {
      weather: "22°C, sunny in Berlin",
      ids: [1, 2],
      count: 7,
    });
    assert.equal(auths, 1);
    assert.equal(calls.length, 1);
    assert.deepEqual(
      guarded.map((call) => call.toolName),
      ["getWeather", "lookupItems", "mcp__test__lookup"],
    );
    assert.equal(new Set(guarded.map((call) => call.toolCallId)).size, 3);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].key, "turn:outer:call-2");
    assert.equal(requests[1].key, requests[0].key);
    assert.ok(!JSON.stringify(entries).includes("large intermediate result"));
    assert.ok(!result.output.result.includes("raw"));
  } finally {
    fetch.mock.restore();
  }
});

test("only concrete subtools are policy checked, with normal human approval and pending completion", {
  timeout: 8000,
}, async () => {
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
    const result = await runHandler(
      (ctx) =>
        durable.execute(
          contextWithFixtures(ctx, (opts) => {
            effects.push(opts.method);
            if (opts.method === "complete") return action;
            if (opts.method === "evaluateGuardrails") {
              const calls = opts.parameter.action.calls;
              policies.push(...calls);
              assert.ok(
                calls.every((call) => call.toolName !== "executeProgram"),
              );
              return calls.some((call) => call.input.city === "Paris")
                ? {
                    decision: "deny",
                    guardrailId: "cities",
                    reason: "Paris is blocked",
                  }
                : {decision: "allow"};
            }
            if (opts.method === "requestApproval") {
              approvals.push(opts.parameter);
              return true;
            }
            throw new Error(`Unexpected RPC ${opts.service}/${opts.method}`);
          }),
          agentStep({
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
  assert.deepEqual(JSON.parse(live.output.outcomes[0].result), [
    "22°C, sunny in Berlin",
    "Tool blocked: Paris is blocked",
  ]);
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
});

test("program failures are model repair results and do not invoke subtools", async () => {
  const result = await runHandler((ctx) =>
    durable.execute(
      ctx,
      durable.gen(function* () {
        return yield* agentTools.execute(
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
        return yield* agentTools.execute(
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

test("turn interruption cancels a nested approval even between registration and its wait", {
  timeout: 8000,
}, async () => {
  const entries = [],
    cancellations = [];
  const source = "async tools => tools.humanApproval({question: 'Continue?'})";
  const call = {
    toolCallId: "program",
    toolName: "executeProgram",
    input: {source},
  };
  const result = await runHandler((ctx) =>
    durable.execute(
      contextWithFixtures(ctx, (opts) => {
        if (opts.method === "complete")
          return {
            type: "tool_calls",
            calls: [call],
            message: {
              role: "assistant",
              content: [{type: "tool-call", ...call}],
            },
          };
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
});
