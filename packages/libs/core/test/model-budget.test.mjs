import assert from "node:assert/strict";
import {beforeEach, test} from "node:test";

import * as durable from "@restatedev/restate-sdk-gen";
import {build} from "esbuild";

import {runHandler} from "./harness.mjs";

const aiPath = import.meta.resolve("ai");
const bundled = await build({
  stdin: {
    contents:
      'export * from "./src/model/provider.ts"; export {callModel} from "./src/model/inference.ts";',
    resolveDir: process.cwd(),
  },
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  write: false,
  plugins: [
    {
      name: "offline-model",
      setup(b) {
        b.onResolve({filter: /^ai$/}, () => ({
          path: "ai-fixture",
          namespace: "fixture",
        }));
        b.onResolve({filter: /./}, (args) =>
          args.path === aiPath ? {path: aiPath, external: true} : undefined,
        );
        b.onResolve({filter: /^[^./]/}, (args) => ({
          path: import.meta.resolve(args.path),
          external: true,
        }));
        b.onLoad({filter: /.*/, namespace: "fixture"}, () => ({
          contents: `
      export * from ${JSON.stringify(aiPath)};
      export async function generateText(options) {
        globalThis.__budgetFixture.calls.push(options);
        const result = globalThis.__budgetFixture.results.shift();
        if (!result) throw new Error("Unexpected provider call");
        return result;
      }
    `,
        }));
      },
    },
  ],
});
const model = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
);
const input = {
  messages: [{role: "user", content: "Summarize the completed research"}],
  tools: [],
};
const length = {
  finishReason: "length",
  text: "partial answer",
  toolCalls: [],
  responseMessages: [],
};
const text = {
  finishReason: "stop",
  text: "Research summary",
  toolCalls: [],
  responseMessages: [],
};
const signal = () => new AbortController().signal;
beforeEach((t) => {
  const oldKey = process.env.OPENAI_API_KEY,
    oldBudget = process.env.AGENT_MODEL_MAX_OUTPUT_TOKENS;
  process.env.OPENAI_API_KEY = "fixture-not-a-real-api-key";
  delete process.env.AGENT_MODEL_MAX_OUTPUT_TOKENS;
  globalThis.__budgetFixture = {calls: [], results: []};
  t.after(() => {
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = oldKey;
    if (oldBudget === undefined)
      delete process.env.AGENT_MODEL_MAX_OUTPUT_TOKENS;
    else process.env.AGENT_MODEL_MAX_OUTPUT_TOKENS = oldBudget;
  });
});
const inference = (options = {}) =>
  runHandler(
    (ctx) =>
      durable.execute(
        ctx,
        durable.gen(() => model.callModel(input)),
      ),
    options,
  );

test("model budget defaults to 32000 and validates the operator override", async () => {
  globalThis.__budgetFixture.results = [text, text];
  await model.completeAgent(input, signal());
  assert.equal(globalThis.__budgetFixture.calls[0].maxOutputTokens, 32000);
  process.env.AGENT_MODEL_MAX_OUTPUT_TOKENS = "24000";
  await model.completeAgent(input, signal());
  assert.equal(globalThis.__budgetFixture.calls[1].maxOutputTokens, 24000);
  for (const value of ["", "0", "1023", "64001", "2e4", "2000.5", "nonsense"]) {
    process.env.AGENT_MODEL_MAX_OUTPUT_TOKENS = value;
    await assert.rejects(
      model.completeAgent(input, signal()),
      /must be an integer/,
    );
  }
  assert.equal(globalThis.__budgetFixture.calls.length, 2);
});

test("truncation discards partial text AND apparently valid tool calls", async () => {
  const call = {
    toolCallId: "danger",
    toolName: "executeProgram",
    input: {code: "await tools.write({})"},
  };
  for (const calls of [[], [call], [{...call, invalid: true}]]) {
    globalThis.__budgetFixture.results = [{...length, toolCalls: calls}];
    const result = await model.completeAgent(input, signal());
    assert.equal(result.type, "error");
    assert.equal(result.code, "output_limit");
    assert.equal(result.maxOutputTokens, 32000);
    assert.ok(!JSON.stringify(result).includes("partial answer"));
    assert.ok(!JSON.stringify(result).includes("danger"));
  }
});

test("completed tool calls remain available for the normal guardrail/tool pipeline", async () => {
  const call = {
    toolCallId: "valid",
    toolName: "getWeather",
    input: {city: "Berlin"},
  };
  const message = {role: "assistant", content: [{type: "tool-call", ...call}]};
  globalThis.__budgetFixture.results = [
    {
      finishReason: "tool-calls",
      text: "Checking weather",
      toolCalls: [call],
      responseMessages: [message],
    },
  ];
  const result = await model.completeAgent(input, signal());
  assert.equal(result.type, "tool_calls");
  assert.deepEqual(result.calls, [call]);
});

test("output recovery is a separate journaled attempt and replay makes no provider calls", async () => {
  globalThis.__budgetFixture.results = [length, text];
  const live = await inference();
  assert.deepEqual(live.output, {type: "text", content: "Research summary"});
  assert.deepEqual(
    globalThis.__budgetFixture.calls.map((c) => c.maxOutputTokens),
    [32000, 64000],
  );
  const recovery = globalThis.__budgetFixture.calls[1];
  assert.match(
    recovery.messages.at(-1).content,
    /none of its tool calls executed/,
  );
  assert.ok(!JSON.stringify(recovery.messages).includes("partial answer"));
  assert.ok(
    globalThis.__budgetFixture.calls.every(
      (c) => c.maxRetries === 0 && c.abortSignal,
    ),
  );
  globalThis.__budgetFixture.calls = [];
  process.env.AGENT_MODEL_MAX_OUTPUT_TOKENS = "not-valid-anymore";
  const replay = await inference({replay: live.journal});
  assert.deepEqual(replay.output, live.output);
  assert.deepEqual(globalThis.__budgetFixture.calls, []);
  // Simulate restart after the first attempt, before recovery was journaled.
  globalThis.__budgetFixture.results = [text];
  const resumed = await inference({replay: live.journal.slice(0, 3)});
  assert.deepEqual(resumed.output, live.output);
  assert.deepEqual(
    globalThis.__budgetFixture.calls.map((c) => c.maxOutputTokens),
    [64000],
  );
});

test("persistent truncation stops after exactly one recovery", async () => {
  globalThis.__budgetFixture.results = [length, length];
  const {output} = await inference();
  assert.equal(output.code, "output_limit");
  assert.equal(output.maxOutputTokens, 64000);
  assert.equal(globalThis.__budgetFixture.calls.length, 2);
});

test("budget override doubles only once and never beyond the hard ceiling", async () => {
  process.env.AGENT_MODEL_MAX_OUTPUT_TOKENS = "48000";
  globalThis.__budgetFixture.results = [length, text];
  await inference();
  assert.deepEqual(
    globalThis.__budgetFixture.calls.map((c) => c.maxOutputTokens),
    [48000, 64000],
  );
  process.env.AGENT_MODEL_MAX_OUTPUT_TOKENS = "64000";
  globalThis.__budgetFixture = {calls: [], results: [length]};
  assert.equal((await inference()).output.code, "output_limit");
  assert.equal(globalThis.__budgetFixture.calls.length, 1);
});

test("success and non-token errors do not trigger budget recovery", async () => {
  for (const result of [
    text,
    {...text, text: ""},
    {...text, text: "   "},
    {...text, finishReason: "content-filter"},
  ]) {
    globalThis.__budgetFixture = {calls: [], results: [result]};
    await inference();
    assert.equal(globalThis.__budgetFixture.calls.length, 1);
  }
});
