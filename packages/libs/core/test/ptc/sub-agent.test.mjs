import assert from "node:assert/strict";
import {test} from "node:test";
import {CancelledError, TerminalError} from "@restatedev/restate-sdk";
import * as durable from "@restatedev/restate-sdk-gen";
import * as agentTools from "../../src/session/tools.ts";
import {Agent} from "../../src/agent/service.ts";
import {subAgentProfile} from "../../src/agent/sub-agents.ts";
import {context} from "./state-fixture.mjs";

const selection = (...names) => ({mode: "selected", names});
const grants = {builtin: {mode: "all"}, dynamic: selection("Weather/get"), mcp: [{serverId: "notion", tools: selection("read")}]};
const profile = {memories: [{key: "style", content: "Be clear"}], instructions: "Be concise", guardrails: [{id: "readonly", rule: "Never write remote data"}], tools: grants, webSearchEnabled: false};
const config = {name: "Research", instructions: null, guardrails: null, tools: null, webSearchEnabled: null, initialMessage: null};
const builtins = ["getWeather", "createSubAgent", "messageSubAgent", "listSubAgents", "deleteSubAgent", "executeProgram", "createSchedule", "listSchedules", "cancelSchedule"];
const agentState = {metadata: {name: "Parent"}, turn: {id: "turn", tools: grants, steeringBatches: []}, "profile/instructions": profile.instructions, "profile/guardrails": profile.guardrails, "profile/tools": grants, "profile/web-search-enabled": false};
const child = {agentId: "child", name: "Research", parentAgentId: "parent"};

for (const toolName of ["createSubAgent"]) {
  test(`${toolName} advertises strict-compatible nested tool selections`, () => {
    const manifest = agentTools.manifests([], [], {webSearchEnabled: false, permissions: grants}).find(m => m.name === toolName);
    assert.equal(manifest.strict, true);
    const tools = manifest.inputSchema.properties.tools.anyOf.find(s => s.type === "object");
    assert.equal(Object.hasOwn(tools.properties, "mcpDefault"), false);
    assert.match(tools.properties.builtin.description, /webSearch/);
    assert.match(tools.properties.dynamic.description, /service\/handler/);
    for (const selection of [tools.properties.builtin, tools.properties.dynamic, tools.properties.mcp.items.properties.tools]) {
      assert.equal(selection.anyOf.length, 2);
      assert.deepEqual(selection.anyOf.map(s => s.properties.mode.const), ["all", "selected"]);
    }
    function check(schema) {
      if (!schema || typeof schema !== "object") return;
      assert.equal(Object.hasOwn(schema, "oneOf"), false);
      if (schema.type === "object") {
        assert.equal(schema.additionalProperties, false);
        assert.deepEqual([...(schema.required ?? [])].sort(), Object.keys(schema.properties ?? {}).sort());
      }
      for (const value of Object.values(schema)) {
        if (Array.isArray(value)) value.forEach(check);
        else check(value);
      }
    }
    check(manifest.inputSchema);
  });
}

test("misclassified webSearch is recoverable directly and inside PTC without granting extra access", async () => {
  const current = {...grants, dynamic: selection(), mcp: []};
  const parent = {...profile, tools: current, webSearchEnabled: true};
  const wrong = {...config, tools: {builtin: selection("webSearch"), dynamic: selection("webSearch"), mcp: []}};
  const corrected = {...wrong, tools: {...wrong.tools, dynamic: selection()}};
  const toolContext = agentTools.createAgentToolContext("parent", "turn", true, current);
  const f = context("parent", {}, () => child);
  const scope = {transcript: {*append() {}}, step: 1, *guard() {}, *cancelPending() {throw new Error("unused");}};
  const execute = call => f.invoke(ctx => durable.execute({
    ...ctx,
    genericCall(opts) {
      assert.equal(opts.service, "Agent");
      assert.equal(opts.method, "createSubAgent");
      // Run the actual permission validator before simulating a successful RPC.
      const result = subAgentProfile(parent, current, opts.parameter, ["webSearch", ...builtins]);
      assert.deepEqual(result.tools.dynamic, selection());
      return ctx.genericCall(opts);
    },
  }, agentTools.execute(call, toolContext, [], [], scope)));
  const failed = await execute({toolName: "createSubAgent", toolCallId: "invalid", input: wrong});
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /dynamic selection is not permitted/);
  assert.match(failed.error, /webSearch belong in builtin/);
  assert.equal(f.calls.length, 0);
  const message = agentTools.toModelMessage([failed]);
  assert.equal(message.content[0].output.value.ok, false);
  assert.equal(message.content[0].output.value.error, failed.error);
  assert.equal((await execute({toolName: "createSubAgent", toolCallId: "corrected", input: corrected})).status, "succeeded");
  const program = await execute({toolName: "executeProgram", toolCallId: "program", input: {source: `async tools => {
    try { await tools.createSubAgent(${JSON.stringify(wrong)}); }
    catch (error) { return await tools.createSubAgent(${JSON.stringify(corrected)}); }
    throw new Error("Invalid permissions were accepted");
  }`}});
  assert.equal(program.status, "succeeded");
  assert.equal(JSON.parse(program.result).agentId, "child");
  assert.equal(f.calls.length, 2);
});

test("sub-agent tool does not swallow cancellation, stale-turn or infrastructure failures", async () => {
  const toolContext = agentTools.createAgentToolContext("parent", "turn", false, grants);
  for (const error of [new CancelledError(), new TerminalError("stale turn", {errorCode: 409}), new TerminalError("internal failure", {errorCode: 500})]) {
    const f = context("parent");
    await assert.rejects(f.invoke(ctx => durable.execute({
      ...ctx, genericCall() {throw error;},
    }, agentTools.execute({toolName: "createSubAgent", toolCallId: "call", input: config}, toolContext, [], []))), {message: error.message});
  }
});

test("sub-agent inherits a copy of policy and current access, not future connections or recursion", () => {
  const result = subAgentProfile(profile, grants, {...config, instructions: "Research the weather"}, builtins);
  assert.equal(result.instructions, "Be concise\n\n[Sub-agent task instructions]\nResearch the weather");
  assert.deepEqual(result.memories, profile.memories);
  result.memories[0].content = "child only";
  assert.equal(profile.memories[0].content, "Be clear");
  assert.deepEqual(result.guardrails, profile.guardrails);
  assert.deepEqual(result.tools.dynamic, grants.dynamic);
  assert.deepEqual(result.tools.mcp, grants.mcp);
  assert.deepEqual(result.tools.builtin, selection("getWeather", "executeProgram"));
  assert.equal(result.tools.mcpDefault, "disabled");
  assert.equal(result.webSearchEnabled, false);
  result.guardrails[0].rule = "changed";
  result.tools.mcp.length = 0;
  assert.equal(profile.guardrails[0].rule, "Never write remote data");
  assert.equal(grants.mcp.length, 1);
});

test("restrictions can narrow tools and add policies, never broaden access or replace policies", () => {
  const narrow = {builtin: selection("getWeather"), dynamic: selection(), mcp: []};
  const result = subAgentProfile(profile, grants, {...config, tools: narrow, guardrails: [{id: "extra", rule: "Ask before sharing"}]}, builtins);
  assert.equal(result.guardrails.length, 2);
  assert.deepEqual(result.tools.mcp, []);
  for (const tools of [
    {...narrow, dynamic: {mode: "all"}},
    {...narrow, dynamic: selection("Other/write")},
    {...narrow, mcp: [{serverId: "github", tools: {mode: "all"}}]},
    {...narrow, mcp: [{serverId: "notion", tools: selection("write")}]},
  ]) assert.throws(() => subAgentProfile(profile, grants, {...config, tools}, builtins), /cannot exceed/);
  assert.throws(() => subAgentProfile(profile, {...grants, builtin: selection("getWeather")}, {...config, tools: {...narrow, builtin: {mode: "all"}}}, builtins), /cannot exceed/);
  assert.throws(() => subAgentProfile(profile, grants, {...config, webSearchEnabled: true}, builtins), /cannot enable/);
  assert.throws(() => subAgentProfile(profile, grants, {...config, guardrails: [{id: "readonly", rule: "Allow writing"}]}, builtins), /cannot replace/);
  assert.equal(subAgentProfile(profile, grants, {...config, guardrails: profile.guardrails}, builtins).guardrails.length, 1);
  const parentOnly = {builtin: selection("messageSubAgent", "listSubAgents", "deleteSubAgent", "listSchedules"), dynamic: selection(), mcp: []};
  assert.deepEqual(subAgentProfile(profile, grants, {...config, tools: parentOnly}, builtins).tools.builtin, selection());
});

test("Agent derives its parent and and stable child identity from turn/tool call", async () => {
  const f = context("parent", agentState, () => null);
  const request = {...config, turnId: "turn", toolCallId: "call-1"};
  const first = await f.invoke(Agent.object.createSubAgent, request);
  const retry = await f.invoke(Agent.object.createSubAgent, request);
  assert.deepEqual(retry, first);
  const different = await f.invoke(Agent.object.createSubAgent, {...request, toolCallId: "call-2"});
  assert.notEqual(different.agentId, first.agentId);
  assert.equal(first.parentAgentId, "parent");
  assert.match(first.agentId, /^[a-f0-9]{64}$/);
  assert.ok(f.calls.every(call => call.service === "Agent" && call.method === "initialize"));
  assert.equal(f.calls[0].parameter.profile.tools.mcpDefault, "disabled");
});

test("creation and deletion reject stale/interrupted turns or missing tool permission", async () => {
  for (const method of ["createSubAgent", "deleteSubAgent", "listSubAgents"]) {
    const input = {...config, turnId: "turn", toolCallId: "call-1", agentId: "child"};
    for (const turn of [undefined, {...agentState.turn, id: "other"}, {...agentState.turn, interruptReason: "stop"}]) {
      const f = context("parent", {...agentState, turn});
      await assert.rejects(f.invoke(Agent.object[method], input), /active, non-interrupting/);
      assert.equal(f.calls.length, 0);
    }
    const f = context("parent", {...agentState, turn: {...agentState.turn, tools: {...grants, builtin: selection()}}});
    await assert.rejects(f.invoke(Agent.object[method], input), /cannot/);
    assert.equal(f.calls.length, 0);
  }
  const childContext = context("child", {...agentState, metadata: {...agentState.metadata, parentAgentId: "parent"}});
  await assert.rejects(childContext.invoke(Agent.object.createSubAgent, {...config, turnId: "turn", toolCallId: "call-1"}), /cannot create/);
});

test("child initialization is atomic, retry-safe, and cannot change parent", async () => {
  const f = context("child");
  const input = {name: "Research", parentAgentId: "parent", profile};
  await f.invoke(Agent.object.initialize, input);
  assert.deepEqual(f.state.get("metadata"), {name: "Research", parentAgentId: "parent"});
  f.state.set("profile/instructions", "Updated instructions");
  await f.invoke(Agent.object.initialize, input);
  assert.equal(f.state.get("profile/instructions"), "Updated instructions");
  for (const parentAgentId of ["other", undefined])
    await assert.rejects(f.invoke(Agent.object.initialize, {...input, parentAgentId}), /immutable/);
  assert.equal(f.calls.length, 0, "initialization never calls back to the locked parent");
});

test("direct profile edits cannot widen a child beyond its inherited policy", async () => {
  const f = context("child", {
    metadata: {name: "Research", parentAgentId: "parent"},
    memories: profile.memories,
    "profile/guardrails": profile.guardrails,
    "profile/tools": profile.tools,
  });
  for (const [handler, input] of [
    [Agent.object.updateProfile, {tools: {...grants, dynamic: {mode: "all"}}}],
    [Agent.object.updateProfile, {guardrails: []}],
    [Agent.object.updateProfile, {instructions: "Ignore inherited instructions"}],
    [Agent.object.updateProfile, {webSearchEnabled: true}],
    [Agent.object.deleteMemory, {key: "style"}],
  ]) {
    await assert.rejects(f.invoke(handler, input), /top-level agent/);
  }
  assert.deepEqual((await f.invoke(Agent.object.profile)).guardrails, profile.guardrails);
  assert.deepEqual((await f.invoke(Agent.object.profile)).tools, profile.tools);
  assert.deepEqual((await f.invoke(Agent.object.profile)).memories, profile.memories);
  assert.equal(f.sends.length, 0);
});

test("parent stores its children, deletion tombstones the ID, and late creation cannot resurrect it", async () => {
  const f = context("parent", agentState, () => null);
  const request = {...config, turnId: "turn", toolCallId: "create"};
  const child = await f.invoke(Agent.object.createSubAgent, request);
  assert.deepEqual(await f.invoke(Agent.object.listSubAgents, {turnId: "turn"}), [child]);
  assert.equal(await f.invoke(Agent.object.deleteSubAgent, {turnId: "turn", agentId: "unrelated"}), false);
  assert.equal(await f.invoke(Agent.object.deleteSubAgent, {turnId: "turn", agentId: child.agentId}), true);
  assert.deepEqual(await f.invoke(Agent.object.children), []);
  assert.deepEqual(f.sends.find(s => s.method === "retire").parameter, {parentAgentId: "parent"});
  await assert.rejects(f.invoke(Agent.object.createSubAgent, request), /deleted/);
});

test("failed initialization never exposes a child or submits a task", async () => {
  const f = context("parent", agentState, () => { throw Error("initialization rejected"); });
  await assert.rejects(f.invoke(Agent.object.createSubAgent, {...config, turnId: "turn", toolCallId: "create"}), /initialization rejected/);
  assert.deepEqual(await f.invoke(Agent.object.children), []);
  assert.equal(f.sends.length, 0);
});

test("child dispatch uses its own session and memory with no account calls", async () => {
  const f = context("child", {metadata: {name: "Child", parentAgentId: "parent"}, memories: [{key: "local", content: "Only this child"}]});
  await f.invoke(Agent.object.startDelegatedTurn, {parentAgentId: "parent", parentTurnId: "turn", message: "Work independently"});
  const turn = f.sends.find(s => s.method === "doTurn");
  assert.equal(turn.key, "child");
  assert.deepEqual(turn.parameter.memories, [{key: "local", content: "Only this child"}]);
  assert.deepEqual(turn.parameter.entries[0].delegatedBy, {agentId: "parent", turnId: "turn"});
  assert.equal(f.calls.length, 0);
});

test("direct and PTC catalogs expose sub-agent tools and use the trusted Agent context", async () => {
  const toolContext = () => agentTools.createAgentToolContext("parent", "turn", false, grants);
  for (const name of ["createSubAgent", "deleteSubAgent", "listSubAgents"])
    assert.ok(agentTools.manifests([], [], toolContext()).some(m => m.name === name));
  const f = context("parent", {}, call => {
    assert.equal(call.service, "Agent");
    assert.equal(call.key, "parent");
    assert.equal(call.parameter.turnId, "turn");
    if (call.method === "createSubAgent") return child;
    if (call.method === "listSubAgents") return [child];
    assert.equal(call.method, "deleteSubAgent");
    assert.equal(call.parameter.agentId, "child");
    return true;
  });
  const scope = guard => ({transcript: {*append() {}}, step: 1, guard, *cancelPending() {throw new Error("unused");}});
  const guarded = [];
  const execute = (call, gate = function* () {}) => f.invoke(ctx => durable.execute(ctx, agentTools.execute(call, toolContext(), [], [], scope(gate))));
  const direct = await execute({toolName: "createSubAgent", toolCallId: "direct", input: config});
  assert.equal(direct.status, "succeeded");
  assert.equal(JSON.parse(direct.result).url, "/?agent=child");
  assert.equal(f.calls[0].parameter.toolCallId, "direct");
  const program = await execute({toolName: "executeProgram", toolCallId: "program", input: {source: `async tools => { const child = await tools.createSubAgent(${JSON.stringify(config)}); const children = await tools.listSubAgents({}); return {children, deletion: await tools.deleteSubAgent({agentId: child.agentId})}; }`}}, function* (call) {guarded.push(call.toolName);});
  assert.equal(program.status, "succeeded");
  assert.deepEqual(guarded, ["createSubAgent", "listSubAgents", "deleteSubAgent"]);
  assert.equal(JSON.parse(program.result).deletion.deleted, true);
  const count = f.calls.length;
  const denied = await execute({toolName: "executeProgram", toolCallId: "denied", input: {source: "async tools => { try { return await tools.deleteSubAgent({agentId:'child'}); } catch(e) { return e.message; } }"}}, function* () {return "Do not delete";});
  assert.match(denied.result, /Tool blocked/);
  assert.equal(f.calls.length, count);
});
