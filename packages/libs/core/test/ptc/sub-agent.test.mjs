import assert from "node:assert/strict";
import {test} from "node:test";
import {CancelledError, TerminalError} from "@restatedev/restate-sdk";
import * as durable from "@restatedev/restate-sdk-gen";
import * as agentTools from "../../src/session/tools.ts";
import {Agent} from "../../src/agent/service.ts";
import {subAgentProfile} from "../../src/agent/sub-agent.ts";
import {User} from "../../src/user/service.ts";
import {context} from "./state-fixture.mjs";

const selection = (...names) => ({mode: "selected", names});
const grants = {builtin: {mode: "all"}, dynamic: selection("Weather/get"), mcp: [{connectionId: "notion", tools: selection("read")}]};
const profile = {instructions: "Be concise", guardrails: [{id: "readonly", rule: "Never write remote data"}], tools: grants, webSearchEnabled: false};
const config = {name: "Research", instructions: null, guardrails: null, tools: null, webSearchEnabled: null, initialMessage: null};
const builtins = ["getWeather", "createSubAgent", "deleteSubAgent", "executeProgram"];
const agentState = {ownership: {ownerUserId: "alice", name: "Parent"}, turn: {id: "turn", tools: grants, steeringBatches: []}, "profile/instructions": profile.instructions, "profile/guardrails": profile.guardrails, "profile/tools": grants, "profile/web-search-enabled": false};
const child = {agentId: "child", name: "Research", parentAgentId: "parent"};
const directory = [{agentId: "parent", name: "Parent"}, child, {agentId: "grandchild", name: "Grandchild", parentAgentId: "child"}, {agentId: "other", name: "Other"}];

test("createSubAgent advertises strict-compatible nested tool selections", () => {
  const manifest = agentTools.manifests([], [], {webSearchEnabled: false, permissions: grants}).find(m => m.name === "createSubAgent");
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
  assert.equal(agentTools.summarize({toolName: "createSubAgent", input: config}), "Create sub-agent: Research");
});

test("misclassified webSearch is recoverable directly and inside PTC without granting extra access", async () => {
  const current = {...grants, dynamic: selection(), mcp: []};
  const parent = {...profile, tools: current, webSearchEnabled: true};
  const wrong = {...config, tools: {builtin: selection("webSearch"), dynamic: selection("webSearch"), mcp: []}};
  const corrected = {...wrong, tools: {...wrong.tools, dynamic: selection()}};
  const toolContext = agentTools.createAgentToolContext("parent", "turn", true, current, "alice");
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
  const toolContext = agentTools.createAgentToolContext("parent", "turn", false, grants, "alice");
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
  assert.deepEqual(result.guardrails, profile.guardrails);
  assert.deepEqual(result.tools.dynamic, grants.dynamic);
  assert.deepEqual(result.tools.mcp, grants.mcp);
  assert.deepEqual(result.tools.builtin, selection("getWeather", "deleteSubAgent", "executeProgram"));
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
    {...narrow, mcp: [{connectionId: "github", tools: {mode: "all"}}]},
    {...narrow, mcp: [{connectionId: "notion", tools: selection("write")}]},
  ]) assert.throws(() => subAgentProfile(profile, grants, {...config, tools}, builtins), /cannot exceed/);
  assert.throws(() => subAgentProfile(profile, {...grants, builtin: selection("getWeather")}, {...config, tools: {...narrow, builtin: {mode: "all"}}}, builtins), /cannot exceed/);
  assert.throws(() => subAgentProfile(profile, grants, {...config, webSearchEnabled: true}, builtins), /cannot enable/);
  assert.throws(() => subAgentProfile(profile, grants, {...config, guardrails: [{id: "readonly", rule: "Allow writing"}]}, builtins), /cannot replace/);
  assert.equal(subAgentProfile(profile, grants, {...config, guardrails: profile.guardrails}, builtins).guardrails.length, 1);
});

test("Agent derives owner and parent, and stable child identity from turn/tool call", async () => {
  const f = context("parent", agentState, call => call.parameter.agent);
  const request = {...config, turnId: "turn", toolCallId: "call-1"};
  const first = await f.invoke(Agent.object.createSubAgent, request);
  const retry = await f.invoke(Agent.object.createSubAgent, request);
  assert.deepEqual(retry, first);
  const different = await f.invoke(Agent.object.createSubAgent, {...request, toolCallId: "call-2"});
  assert.notEqual(different.agentId, first.agentId);
  assert.equal(first.parentAgentId, "parent");
  assert.match(first.agentId, /^[a-f0-9]{64}$/);
  assert.ok(f.calls.every(call => call.service === "User" && call.key === "alice" && call.method === "createSubAgent"));
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
  const childContext = context("child", {...agentState, ownership: {...agentState.ownership, parentAgentId: "parent"}});
  await assert.rejects(childContext.invoke(Agent.object.createSubAgent, {...config, turnId: "turn", toolCallId: "call-1"}), /cannot create/);
});

test("child initializes before registration; task dispatch is left to the parent session", async () => {
  const f = context("alice", {agents: [directory[0]]}, call => {
    assert.equal(call.service, "Agent");
    assert.equal(call.key, "child");
    assert.equal(call.method, "initialize");
    assert.deepEqual(call.parameter, {ownerUserId: "alice", name: child.name, parentAgentId: "parent", profile});
    assert.equal(f.state.get("agents").length, 1);
  });
  const request = {agent: child, profile, initialMessage: "Research tomorrow's weather"};
  assert.deepEqual(await f.invoke(User.object.createSubAgent, request), child);
  assert.deepEqual(await f.invoke(User.object.createSubAgent, request), child);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.sends.map(s => [s.service, s.key, s.method]), [["UserNotifications", "alice", "publish"]]);
});

test("initial profile and ownership are atomic and immutable on initialization retries", async () => {
  const f = context("child");
  const input = {ownerUserId: "alice", name: "Research", parentAgentId: "parent", profile};
  await f.invoke(Agent.object.initialize, input);
  assert.deepEqual(f.state.get("ownership"), {ownerUserId: "alice", name: "Research", parentAgentId: "parent"});
  assert.equal(f.state.get("profile/instructions"), profile.instructions);
  f.state.set("profile/instructions", "User edited");
  await f.invoke(Agent.object.initialize, input);
  assert.equal(f.state.get("profile/instructions"), "User edited");
  for (const change of [{ownerUserId: "bob"}, {parentAgentId: "other"}, {parentAgentId: undefined}])
    await assert.rejects(f.invoke(Agent.object.initialize, {...input, ...change}), /immutable/);
  assert.equal(f.calls.length, 0, "initialize must not call back to User while User holds its lock");
});

test("User rejects foreign parents, grandchildren, conflicting parents and resurrection", async () => {
  const request = {agent: child, profile, initialMessage: null};
  for (const [state, input, error] of [
    [{agents: []}, request, /belong/],
    [{agents: directory}, {...request, agent: {...child, agentId: "new", parentAgentId: "child"}}, /Nested/],
    [{agents: directory}, {...request, agent: {...child, parentAgentId: "other"}}, /reassigned/],
    [{agents: [directory[0]], "deleted-agent:child": true}, request, /deleted/],
    [{agents: [directory[0], ...Array.from({length: 99}, (_, i) => ({agentId: `a${i}`, name: "A"}))]}, request, /100 agents/],
  ]) {
    const f = context("alice", state);
    await assert.rejects(f.invoke(User.object.createSubAgent, input), error);
    assert.equal(f.calls.length, 0);
    assert.equal(f.sends.length, 0);
  }
});

test("cascade tombstones descendants, retires each and preserves unrelated agents, credentials and memories", async () => {
  const f = context("alice", {
    agents: directory, connections: [{server: {id: "notion"}, credential: "ciphertext"}], memories: [{key: "project", content: "Durable agents"}],
    authorizations: [{manual: false, waiters: [{agentId: "parent"}, {agentId: "child"}, {agentId: "grandchild"}]}, {manual: false, waiters: [{agentId: "child"}, {agentId: "other"}]}, {manual: true, waiters: [{agentId: "grandchild"}]}],
  });
  assert.equal(await f.invoke(User.object.deleteAgent, {agentId: "parent"}), true);
  assert.deepEqual(f.state.get("agents"), [directory[3]]);
  for (const id of ["parent", "child", "grandchild"]) assert.equal(f.state.get(`deleted-agent:${id}`), true);
  assert.deepEqual(f.sends.filter(s => s.method === "retire").map(s => s.key), ["parent", "child", "grandchild"]);
  assert.ok(f.sends.filter(s => s.method === "retire").every(s => s.parameter.ownerUserId === "alice"));
  assert.equal(f.sends.filter(s => s.service === "UserNotifications").length, 1);
  assert.deepEqual(f.state.get("authorizations"), [{manual: false, waiters: [{agentId: "other"}]}, {manual: true, waiters: []}]);
  assert.equal(f.state.get("connections")[0].credential, "ciphertext");
  assert.equal(f.state.get("memories")[0].key, "project");
  assert.equal(await f.invoke(User.object.deleteAgent, {agentId: "parent"}), false);
  await assert.rejects(f.invoke(User.object.createSubAgent, {agent: {...child, agentId: "new"}, profile, initialMessage: null}), /belong/);
});

test("parent tool can delete only its direct child's subtree, never self, unrelated or foreign agents", async () => {
  const f = context("alice", {agents: directory});
  for (const id of ["parent", "other", "grandchild"])
    await assert.rejects(f.invoke(User.object.deleteSubAgent, {parentAgentId: "parent", agentId: id}), /not a direct child/);
  await assert.rejects(f.invoke(User.object.deleteSubAgent, {parentAgentId: "bob-parent", agentId: "child"}), /belong/);
  assert.equal(await f.invoke(User.object.deleteSubAgent, {parentAgentId: "parent", agentId: "bob-agent"}), false);
  assert.equal(f.sends.length, 0);
  const parent = context("parent", agentState, call => {
    assert.equal(call.key, "alice");
    assert.deepEqual(call.parameter, {parentAgentId: "parent", agentId: "child"});
    return f.invoke(User.object.deleteSubAgent, call.parameter);
  });
  assert.equal(await parent.invoke(Agent.object.deleteSubAgent, {turnId: "turn", agentId: "child"}), true);
  assert.deepEqual(f.state.get("agents"), [directory[0], directory[3]]);
  assert.deepEqual(f.sends.filter(s => s.method === "retire").map(s => s.key), ["child", "grandchild"]);
});

test("child's pinned MCP snapshot excludes new connections and still honors revocation", async () => {
  const connection = id => ({server: {id, revision: 1, auth: {type: "oauth"}}, credential: {serverId: id, encryptedToken: "ciphertext"}});
  const f = context("alice", {agents: directory, connections: [connection("notion"), connection("github")], memories: [{key: "shared", content: "shared memory"}]});
  const tools = subAgentProfile(profile, grants, config, builtins).tools;
  const result = await f.invoke(User.object.snapshot, {agentId: "child", tools});
  assert.deepEqual(result.servers.map(s => s.id), ["notion"]);
  assert.deepEqual(result.credentials.map(c => c.serverId), ["notion"]);
  assert.equal(result.memories[0].key, "shared");
  delete f.state.get("connections")[0].credential;
  assert.deepEqual((await f.invoke(User.object.snapshot, {agentId: "child", tools})).servers, []);
});

test("child dispatch has a separate AgentSession key and keeps user-level credentials", async () => {
  const f = context("child", {ownership: {ownerUserId: "alice", name: "Child", parentAgentId: "parent"}}, call => {
    assert.equal(call.key, "alice");
    assert.equal(call.parameter.agentId, "child");
    return {tools: grants, servers: [], credentials: [], memories: []};
  });
  await f.invoke(Agent.object.startDelegatedTurn, {ownerUserId: "alice", parentAgentId: "parent", parentTurnId: "turn", message: "Work independently"});
  assert.equal(f.sends.find(s => s.method === "doTurn").key, "child");
  assert.deepEqual(f.sends.find(s => s.method === "doTurn").parameter.entries[0].delegatedBy, {agentId: "parent", turnId: "turn"});
  await f.invoke(Agent.object.retire, {ownerUserId: "alice"});
  assert.equal(f.sends.find(s => s.service === "Sandbox").key, "child");
});

test("listing only returns direct children of an owned parent", async () => {
  const f = context("alice", {agents: directory});
  assert.deepEqual(await f.invoke(User.object.listSubAgents, {parentAgentId: "parent"}), [child]);
  assert.deepEqual(await f.invoke(User.object.listSubAgents, {parentAgentId: "other"}), []);
  await assert.rejects(f.invoke(User.object.listSubAgents, {parentAgentId: "bob-agent"}), /belong/);
  const parent = context("parent", agentState, call => {
    assert.equal(call.key, "alice");
    assert.deepEqual(call.parameter, {parentAgentId: "parent"});
    return [child];
  });
  assert.deepEqual(await parent.invoke(Agent.object.listSubAgents, {turnId: "turn"}), [child]);
});

test("failed child initialization never exposes a child or submits its task", async () => {
  const f = context("alice", {agents: [directory[0]]}, () => { throw new Error("initialization rejected"); });
  await assert.rejects(f.invoke(User.object.createSubAgent, {agent: child, profile, initialMessage: "work"}), /initialization rejected/);
  assert.deepEqual(f.state.get("agents"), [directory[0]]);
  assert.equal(f.sends.length, 0);
});

test("direct and PTC catalogs expose sub-agent tools and use the trusted Agent context", async () => {
  const toolContext = () => agentTools.createAgentToolContext("parent", "turn", false, grants, "alice");
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
