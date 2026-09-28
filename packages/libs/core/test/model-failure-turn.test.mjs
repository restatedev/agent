import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {beforeEach, test} from "node:test";

import * as durable from "@restatedev/restate-sdk-gen";
import {build} from "esbuild";

import {runHandler} from "./harness.mjs";

// Exercise real Turn/finalization control flow with journaled step results.
// Export the private functions only in this test bundle, not the production API.
const stubs = {
  step: `import * as r from ${JSON.stringify(import.meta.resolve("@restatedev/restate-sdk-gen"))};
    export function* agentStep({messages}) {return yield* r.run(() => {
      const f=globalThis.__turnFailureFixture; f.stepCalls++; f.stepMessages.push(messages);
      const result=f.steps.shift(); if(!result)throw Error("Unexpected model step");
      return {...result,approvedActions:[],rejectedGuardrails:[]};
    },{name:"fixture-step"});}
    export function* settleStep(task) {return yield* task;}`,
  dynamic: `export function* discoverAgentTools(){return [];}`,
  mcp: `export function* discoverMcpTools(){return {tools:[],servers:[]};}
    export function* releaseMcpSessions(){} export function releaseMcpSessionsAfterCancellation(){}`,
  model: `import * as r from ${JSON.stringify(import.meta.resolve("@restatedev/restate-sdk-gen"))};
    export function* callModel(request){return yield* r.run(()=>{
      const f=globalThis.__turnFailureFixture; f.finalRequests.push(request);
      if(!f.final)throw Error("Unexpected finalizer"); return f.final;
    },{name:"fixture-final"});}
    export function* callGuardrailModel(){return globalThis.__turnFailureFixture.guardrail;}
    export function* compactConversation(){throw Error("Unexpected compaction");}
    export function* summarizeTurnContext(messages){return yield* r.run(()=>{
      const f=globalThis.__turnFailureFixture; f.turnCompactions.push(messages);
      if(!f.handoff)throw Error("Unexpected turn compaction"); return f.handoff;
    },{name:"fixture-turn-compaction"});}`,
};
const compiled = await build({
  stdin: {
    contents:
      'export {executeTurn, finalizeEarlyExit} from "./src/session/service.ts";',
    resolveDir: process.cwd(),
  },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
  plugins: [
    {
      name: "turn-boundaries",
      setup(b) {
        b.onResolve({filter: /model\/index\.js$/}, () => ({
          path: "model",
          namespace: "fixture",
        }));
        b.onResolve(
          {filter: /^\.\/(step|dynamic-tools|mcp-tools)\.js$/},
          (args) =>
            args.importer.endsWith("/session/service.ts")
              ? {
                  path: {
                    "./step.js": "step",
                    "./dynamic-tools.js": "dynamic",
                    "./mcp-tools.js": "mcp",
                  }[args.path],
                  namespace: "fixture",
                }
              : undefined,
        );
        b.onLoad({filter: /.*/, namespace: "fixture"}, (args) => ({
          contents: stubs[args.path],
        }));
        b.onLoad({filter: /\/session\/service\.ts$/}, async (args) => ({
          contents:
            (await readFile(args.path, "utf8")) +
            "\nexport {executeTurn, finalizeEarlyExit};",
          loader: "ts",
        }));
        b.onResolve({filter: /^[^./]/}, (args) => ({
          path: import.meta.resolve(args.path),
          external: true,
        }));
      },
    },
  ],
});
const session = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`
);
const error = {type: "error", message: "unusable output"};
beforeEach(() => {
  globalThis.__turnFailureFixture = {
    steps: [],
    stepCalls: 0,
    stepMessages: [],
    turnCompactions: [],
    handoff: null,
    finalRequests: [],
    final: null,
    guardrail: {decision: "allow"},
  };
});
async function run({
  finalize = false,
  guardrails = [],
  replay,
  approvedActions = [],
  steering = [],
  measured,
  messages = [{role: "user", content: "Research request"}],
  guardrailInput,
} = {}) {
  return runHandler(
    (ctx) =>
      durable.execute(
        ctx,
        durable.gen(function* () {
          const events = [];
          let stops = 0;
          const state = {
            context: {agentId: "test", turnId: "turn"},
            messages: [...messages],
            pinned: new Set(),
            guardrailInput,
            guardrailEvidenceFrom: 1,
            measured,
            compactionFailed: false,
            guardrails,
            approvedActions,
            rejectedGuardrails: new Set(),
            blockedGuardrails: new Set(),
            transcript: {
              *append(...entries) {
                events.push(...entries);
              },
            },
            interrupt: durable.channel().receive,
            steeringInbox: {drain: () => steering.splice(0)},
            consumedSteering: 0,
            steps: 0,
            pending: {
              size: 0,
              operations: () => [],
              *stop() {
                stops++;
                return [];
              },
            },
            mcpServers: [],
            mcpCredentials: [],
            mcpTools: [],
            discoveredTools: [],
          };
          try {
            const outcome = yield* finalize
              ? session.finalizeEarlyExit(state, {
                  status: "interrupted",
                  reason: "User stopped the turn",
                })
              : session.executeTurn(state);
            return {
              outcome,
              events,
              steps: state.steps,
              stops,
              approvals: state.approvedActions.length,
            };
          } catch (e) {
            return {error: e.message, events, steps: state.steps, stops};
          }
        }),
      ),
    {replay},
  );
}

test("an exhausted model output budget exits the Turn rather than restarting recovery", async () => {
  globalThis.__turnFailureFixture.steps = [
    {...error, code: "output_limit", maxOutputTokens: 64000},
  ];
  const {output} = await run();
  assert.match(output.error, /bounded output recovery/);
  assert.equal(output.steps, 1);
  assert.equal(globalThis.__turnFailureFixture.stepCalls, 1);
  assert.equal(globalThis.__turnFailureFixture.finalRequests.length, 0);
});

test("three consecutive model errors stop instead of burning fifty iterations", async () => {
  globalThis.__turnFailureFixture.steps = [error, error, error];
  const {output} = await run();
  assert.match(output.error, /three times in a row/);
  assert.equal(output.steps, 3);
  assert.equal(output.events.filter((e) => e.phase === "thinking").length, 3);
});

test("a recoverable model error can still produce a normal final answer", async () => {
  globalThis.__turnFailureFixture.steps = [
    error,
    {type: "text", content: "Recovered"},
  ];
  const {output} = await run();
  assert.equal(output.outcome.status, "completed");
  assert.equal(output.outcome.response, "Recovered");
});

test("a valid proposal resets the consecutive-error count", async () => {
  globalThis.__turnFailureFixture.steps = [
    error,
    error,
    {
      type: "guardrail_blocked",
      guardrailId: "g",
      reason: "Choose a safe alternative",
    },
    error,
    error,
    {type: "text", content: "Safe answer"},
  ];
  const {output} = await run();
  assert.equal(output.outcome.status, "completed");
  assert.equal(output.steps, 6);
});

test("replaying the failure cutoff does not ask the model again", async () => {
  globalThis.__turnFailureFixture.steps = [error, error, error];
  const live = await run();
  globalThis.__turnFailureFixture.stepCalls = 0;
  const replay = await run({replay: live.journal});
  assert.deepEqual(replay.output, live.output);
  assert.equal(globalThis.__turnFailureFixture.stepCalls, 0);
});

test("interruption finalization uses no tools and does not loop on output exhaustion", async () => {
  globalThis.__turnFailureFixture.final = {
    ...error,
    code: "output_limit",
    maxOutputTokens: 64000,
  };
  const {output} = await run({finalize: true});
  assert.equal(output.outcome.status, "interrupted");
  assert.match(
    output.outcome.response,
    /final response could not be generated/,
  );
  assert.equal(output.stops, 1);
  assert.equal(globalThis.__turnFailureFixture.finalRequests.length, 1);
  assert.deepEqual(globalThis.__turnFailureFixture.finalRequests[0].tools, []);
});

test("a recovered final summary still passes through guardrails", async () => {
  globalThis.__turnFailureFixture.final = {
    type: "text",
    content: "Sensitive final summary",
  };
  globalThis.__turnFailureFixture.guardrail = {
    decision: "deny",
    guardrailId: "g",
    reason: "No",
  };
  const {output} = await run({
    finalize: true,
    guardrails: [{id: "g", description: "No sensitive summaries"}],
  });
  assert.match(output.outcome.response, /withheld by a guardrail/);
  assert.ok(!output.outcome.response.includes("Sensitive"));
});

test("empty answers count toward the unusable-response limit", async () => {
  const empty = {type: "text", content: "  "};
  globalThis.__turnFailureFixture.steps = [empty, error, empty];

  const {output} = await run();

  assert.match(output.error, /three times in a row/);
  assert.equal(output.steps, 3);
});

test("steering clears guardrail approvals granted for the earlier request", async () => {
  globalThis.__turnFailureFixture.steps = [{type: "text", content: "Done"}];
  const earlierApproval = {
    guardrailId: "g",
    approvalId: "a",
    action: {type: "text", content: "old request"},
  };

  const {output} = await run({
    approvedActions: [earlierApproval],
    steering: [{queued: [], message: "Do something else"}],
  });

  assert.equal(output.outcome.status, "completed");
  assert.equal(output.outcome.consumedSteering, 1);
  assert.equal(output.approvals, 0);
});

// A request, one large tool-heavy exchange and a short recent message.
const longResearch = [
  {role: "user", content: "Research request"},
  {role: "assistant", content: "x".repeat(400_000)},
  {role: "user", content: "[Runtime event] One more source arrived."},
];

test("a turn that outgrows its window compacts before its next model call", async () => {
  const f = globalThis.__turnFailureFixture;
  f.handoff = "Found three sources; the third is still unread.";
  f.steps = [
    {...error, inputTokens: 300_000},
    {type: "text", content: "Done"},
  ];
  const first = await run({
    messages: longResearch,
    guardrailInput: longResearch[0],
  });
  assert.equal(first.output.outcome.response, "Done");
  // The first step is under the threshold; its reported input is not.
  assert.equal(f.turnCompactions.length, 1);
  const [before, after] = f.stepMessages;
  assert.equal(before.length, 3);
  assert.match(after[0].content, /\[Turn context compacted\]/);
  // The request was compacted with the rest, so the note restates it.
  assert.match(after[0].content, /working on, verbatim:\nResearch request/);
  assert.deepEqual(f.turnCompactions[0], longResearch.slice(0, 2));
  // The newest message stays verbatim after the note.
  assert.deepEqual(after.slice(1, 2), longResearch.slice(2));
  assert.match(after[0].content, /the third is still unread/);
  const compacting = first.output.events.filter(
    (e) => e.type === "progress" && /Compacting/.test(e.message),
  );
  assert.equal(compacting.length, 1);

  f.stepCalls = 0;
  f.turnCompactions = [];
  const replay = await run({
    messages: longResearch,
    guardrailInput: longResearch[0],
    replay: first.journal,
  });
  assert.deepEqual(replay.output, first.output);
  assert.equal(f.stepCalls, 0);
  assert.equal(f.turnCompactions.length, 0);
});

test("finalization compacts an oversized context before its tool-free call", async () => {
  const f = globalThis.__turnFailureFixture;
  f.handoff = "Two of five files were migrated.";
  f.final = {type: "text", content: "Stopped after two of five files."};
  const {output} = await run({
    finalize: true,
    messages: longResearch,
    measured: {inputTokens: 300_000, messages: 3},
  });
  assert.equal(output.outcome.response, "Stopped after two of five files.");
  assert.equal(f.turnCompactions.length, 1);
  const [request] = f.finalRequests;
  assert.equal(request.tools.length, 0);
  assert.match(request.messages[0].content, /Two of five files were migrated/);
  // The finalization instruction is the newest message and stays verbatim.
  assert.match(request.messages.at(-1).content, /\[Turn finalization\]/);
});
