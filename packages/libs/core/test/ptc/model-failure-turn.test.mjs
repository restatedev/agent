import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {beforeEach, test} from "node:test";
import {build} from "esbuild";
import * as durable from "@restatedev/restate-sdk-gen";
import {runHandler} from "./harness.mjs";

// Exercise real Turn/finalization control flow with journaled step results.
// Export the private functions only in this test bundle, not the production API.
const stubs = {
  step: `import * as r from ${JSON.stringify(import.meta.resolve("@restatedev/restate-sdk-gen"))};
    export function* agentStep() {return yield* r.run(() => {
      const f=globalThis.__turnFailureFixture; f.stepCalls++;
      const result=f.steps.shift(); if(!result)throw Error("Unexpected model step");
      return {...result,approvedActions:[],rejectedGuardrails:[]};
    },{name:"fixture-step"});}
    export function* settleStep(task) {return yield* task;}`,
  dynamic: `export function* discoverAgentTools(){return [];}`,
  mcp: `export function* discoverMcpTools(){return {tools:[],servers:[]};}
    export function* releaseMcpSessions(){} export function releaseMcpSessionsAfterCancellation(){}`,
  gateway: `import * as r from ${JSON.stringify(import.meta.resolve("@restatedev/restate-sdk-gen"))};
    export function* callModel(request){return yield* r.run(()=>{
      const f=globalThis.__turnFailureFixture; f.finalRequests.push(request);
      if(!f.final)throw Error("Unexpected finalizer"); return f.final;
    },{name:"fixture-final"});}
    export function* callGuardrailModel(){return globalThis.__turnFailureFixture.guardrail;}
    export function* compactConversation(){throw Error("Unexpected compaction");}`,
};
const compiled = await build({
  stdin: {contents: 'export {executeTurn, finalizeEarlyExit} from "./src/session/service.ts";', resolveDir: process.cwd()},
  bundle: true, platform: "node", format: "esm", write: false,
  plugins: [{name: "turn-boundaries", setup(b) {
    b.onResolve({filter: /gateway\/index\.js$/}, () => ({path: "gateway", namespace: "fixture"}));
    b.onResolve({filter: /^\.\/(step|dynamic-tools|mcp-tools)\.js$/}, args => args.importer.endsWith("/session/service.ts") ? {path: {"./step.js":"step","./dynamic-tools.js":"dynamic","./mcp-tools.js":"mcp"}[args.path], namespace: "fixture"} : undefined);
    b.onLoad({filter: /.*/, namespace: "fixture"}, args => ({contents: stubs[args.path]}));
    b.onLoad({filter: /\/session\/service\.ts$/}, async args => ({contents: (await readFile(args.path,"utf8"))+"\nexport {executeTurn, finalizeEarlyExit};", loader: "ts"}));
    b.onResolve({filter: /^[^./]/}, args => ({path: import.meta.resolve(args.path), external: true}));
  }}],
});
const session = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`);
const error = {type: "error", message: "unusable output"};
beforeEach(() => {globalThis.__turnFailureFixture={steps:[],stepCalls:0,finalRequests:[],final:null,guardrail:{decision:"allow"}};});
async function run({finalize=false, guardrails=[], replay}={}) {
  return runHandler(ctx => durable.execute(ctx,durable.gen(function*(){
    const events=[];
    let stops=0;
    const state={
      context:{agentId:"test",turnId:"turn"},
      messages:[{role:"user",content:"Research request"}],
      guardrails,approvedActions:[],rejectedGuardrails:new Set(),blockedGuardrails:new Set(),
      transcript:{*append(...entries){events.push(...entries);}},
      interrupt:durable.channel().receive,
      steeringInbox:{drain:()=>[]}, consumedSteering:0,steps:0,
      pending:{size:0,*stop(){stops++;return [];}},
      mcpServers:[],mcpCredentials:[],mcpTools:[],discoveredTools:[],
    };
    try{
      const outcome=yield* (finalize
        ? session.finalizeEarlyExit(state,{status:"interrupted",reason:"User stopped the turn"})
        : session.executeTurn(state));
      return {outcome,events,steps:state.steps,stops};
    }catch(e){return {error:e.message,events,steps:state.steps,stops};}
  })),{replay});
}

test("an exhausted gateway budget exits the Turn rather than restarting recovery", async () => {
  globalThis.__turnFailureFixture.steps=[{...error,code:"output_limit",maxOutputTokens:64000}];
  const {output}=await run();
  assert.match(output.error,/bounded output recovery/);
  assert.equal(output.steps,1);
  assert.equal(globalThis.__turnFailureFixture.stepCalls,1);
  assert.equal(globalThis.__turnFailureFixture.finalRequests.length,0);
});

test("three consecutive model errors stop instead of burning fifty iterations", async () => {
  globalThis.__turnFailureFixture.steps=[error,error,error];
  const {output}=await run();
  assert.match(output.error,/three times in a row/);
  assert.equal(output.steps,3);
  assert.equal(output.events.filter(e=>e.phase==="thinking").length,3);
});

test("a recoverable model error can still produce a normal final answer", async () => {
  globalThis.__turnFailureFixture.steps=[error,{type:"text",content:"Recovered"}];
  const {output}=await run();
  assert.equal(output.outcome.status,"completed");
  assert.equal(output.outcome.response,"Recovered");
});

test("a valid proposal resets the consecutive-error count", async () => {
  globalThis.__turnFailureFixture.steps=[error,error,{type:"guardrail_blocked",guardrailId:"g",reason:"Choose a safe alternative"},error,error,{type:"text",content:"Safe answer"}];
  const {output}=await run();
  assert.equal(output.outcome.status,"completed");
  assert.equal(output.steps,6);
});

test("replaying the failure cutoff does not ask the model again", async () => {
  globalThis.__turnFailureFixture.steps=[error,error,error];
  const live=await run();
  globalThis.__turnFailureFixture.stepCalls=0;
  const replay=await run({replay:live.journal});
  assert.deepEqual(replay.output,live.output);
  assert.equal(globalThis.__turnFailureFixture.stepCalls,0);
});

test("interruption finalization uses no tools and does not loop on output exhaustion", async () => {
  globalThis.__turnFailureFixture.final={...error,code:"output_limit",maxOutputTokens:64000};
  const {output}=await run({finalize:true});
  assert.equal(output.outcome.status,"interrupted");
  assert.match(output.outcome.response,/final response could not be generated/);
  assert.equal(output.stops,1);
  assert.equal(globalThis.__turnFailureFixture.finalRequests.length,1);
  assert.deepEqual(globalThis.__turnFailureFixture.finalRequests[0].tools,[]);
});

test("a recovered final summary still passes through guardrails", async () => {
  globalThis.__turnFailureFixture.final={type:"text",content:"Sensitive final summary"};
  globalThis.__turnFailureFixture.guardrail={decision:"deny",guardrailId:"g",reason:"No"};
  const {output}=await run({finalize:true,guardrails:[{id:"g",description:"No sensitive summaries"}]});
  assert.match(output.outcome.response,/withheld by a guardrail/);
  assert.ok(!output.outcome.response.includes("Sensitive"));
});
