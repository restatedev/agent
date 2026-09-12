import assert from "node:assert/strict";
import {test} from "node:test";
import {User} from "../../src/user/service.ts";
import {Agent} from "../../src/agent/service.ts";
import {toolAllowed} from "../../src/session/tool-permissions.ts";
import {context} from "./state-fixture.mjs";

const tools = {builtin: {mode: "all"}, dynamic: {mode: "selected", names: []}, mcp: []};
const connection = (id, ready = true, auth = "oauth") => ({server: {id, revision: 1, auth: {type: auth}}, tools: [], ...(ready && auth !== "none" ? {credential: {serverId: id, encryptedToken: "fixture-ciphertext"}} : {})});
const snapshot = (f, grants = tools, agentId = "a") => f.invoke(User.object.snapshot, {agentId, tools: grants});
test("each turn resolves all currently authorized connections from its owner only", async () => {
  const f = context("alice", {agents: [{agentId: "a"}], connections: [connection("notion"), connection("pending", false), connection("public", false, "none")]});
  const first = await snapshot(f);
  assert.deepEqual(first.servers.map(s => s.id), ["notion", "public"]);
  assert.deepEqual(first.tools.mcp, [{connectionId: "notion", tools: {mode: "all"}}, {connectionId: "public", tools: {mode: "all"}}]);
  assert.deepEqual(first.credentials.map(c => c.serverId), ["notion"]);
  f.state.get("connections").push(connection("github"));
  const next = await snapshot(f);
  assert.ok(next.tools.mcp.some(g => g.connectionId === "github"));
  assert.ok(!first.tools.mcp.some(g => g.connectionId === "github"), "active turn snapshot is unchanged");
  await assert.rejects(snapshot(f, tools, "bob-agent"), /belong/);
  const other = context("bob", {agents: [{agentId: "bob-agent"}]});
  assert.deepEqual((await snapshot(other, tools, "bob-agent")).servers, []);
});
test("per-agent opt-outs persist across turns, new authorizations and reconnects", async () => {
  const f = context("alice", {agents: [{agentId: "a"}, {agentId: "b"}], connections: [connection("notion")]});
  const optOut = {...tools, mcp: [{connectionId: "notion", tools: {mode: "selected", names: []}}]};
  for (let i = 0; i < 2; i++) assert.deepEqual((await snapshot(f, optOut)).servers, []);
  f.state.set("connections", [connection("notion"), connection("github")]);
  assert.deepEqual((await snapshot(f, optOut)).servers.map(s => s.id), ["github"]);
  assert.deepEqual((await snapshot(f, tools, "b")).servers.map(s => s.id), ["notion", "github"]);
});
test("saved tool allowlists still constrain the resolved runtime catalog", async () => {
  const f = context("alice", {agents: [{agentId: "a"}], connections: [connection("notion")]});
  const grants = {...tools, mcp: [{connectionId: "notion", tools: {mode: "selected", names: ["read"]}}]};
  const resolved = await snapshot(f, grants);
  const remote = ["read", "write"].map(name => ({name, target: {server: {id: "notion"}, remoteName: name}}));
  assert.equal(toolAllowed("read", resolved.tools, [], remote, []), true);
  assert.equal(toolAllowed("write", resolved.tools, [], remote, []), false);
});
test("Agent dispatch stores the resolved defaults for tool execution and authorization checks", async () => {
  const resolved = {...tools, mcp: [{connectionId: "notion", tools: {mode: "all"}}]};
  const f = context("a", {ownership: {ownerUserId: "alice", name: "A"}}, () => ({tools: resolved, memories: [], servers: [connection("notion").server], credentials: []}));
  await f.invoke(Agent.object.ask, {message: "Search my notes"});
  assert.deepEqual(f.sends.find(s => s.method === "doTurn").parameter.tools, resolved);
  assert.deepEqual(f.state.get("turn").tools, resolved);
  assert.equal(f.calls[0].key, "alice");
});
