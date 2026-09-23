import assert from "node:assert/strict";
import {test} from "node:test";
import * as durable from "@restatedev/restate-sdk-gen";
import {configuredMcpServers, readMcpConfiguration, resolveMcpGrants, resolveMcpToken} from "../../src/session/mcp-config.ts";
import {discoverMcpTools, executeMcpTool} from "../../src/session/mcp-tools.ts";
import {runHandler} from "./harness.mjs";

const server = {id: "fixture", type: "http", url: "https://fixture.example/mcp", protocol: "stateless", tokenEnv: "FIXTURE_MCP_TOKEN"};
const secret = "synthetic-private-token";
function environment(t, servers = [server]) {
  for (const [key, value] of Object.entries({MCP_SERVERS_JSON: JSON.stringify(servers), FIXTURE_MCP_TOKEN: secret})) {
    const before = process.env[key]; process.env[key] = value;
    t.after(() => { if (before === undefined) delete process.env[key]; else process.env[key] = before; });
  }
}
const text = journal => journal.map(frame => frame.toString("utf8")).join("");
const tool = {name: "mcp__fixture__lookup", description: "Fixture", inputSchema: {type: "object"}, target: {
  server: {...server, turnId: "turn", timeoutMs: 1000}, remoteName: "lookup", definition: {name: "lookup", inputSchema: {type: "object"}},
  prior: {kind: "modern", discover: {supportedVersions: ["2026-07-28"], serverInfo: {name: "fixture", version: "1"}, capabilities: {tools: {}}}},
}};

test("configuration snapshots only credential references and replays without reading changed environment", async t => {
  environment(t);
  const live = await runHandler(ctx => durable.execute(ctx, configuredMcpServers()));
  assert.deepEqual(live.output, [server]);
  assert.ok(!text(live.journal).includes(secret));
  process.env.MCP_SERVERS_JSON = "invalid";
  const replay = await runHandler(ctx => durable.execute(ctx, configuredMcpServers()), {replay: live.journal});
  assert.deepEqual(replay.output, live.output);
});

test("configuration rejects inline tokens, duplicate IDs, and unsafe endpoints without echoing supplied data", () => {
  for (const value of [[{...server, token: secret}], [server, server], [{...server, url: 'file:///tmp/private'}], [{...server, url: `https://name:${secret}@example.com`}], [{...server, tokenEnv: "OPENAI_API_KEY"}], [{...server, tokenEnv: "_MCP_TOKEN"}], secret]) {
    assert.throws(() => readMcpConfiguration({MCP_SERVERS_JSON: JSON.stringify(value)}), error => !error.message.includes(secret) && /Invalid MCP_SERVERS_JSON/.test(error.message));
  }
  assert.throws(() => resolveMcpToken(server, {MCP_SERVERS_JSON: '[]', FIXTURE_MCP_TOKEN: secret}), /configuration changed/);
  assert.throws(() => resolveMcpToken(server, {MCP_SERVERS_JSON: JSON.stringify([server])}), /missing/);
});

test("operator defaults, explicit opt-outs, and pinned child grants resolve consistently", () => {
  const tools = {builtin: {mode: "all"}, dynamic: {mode: "selected", names: []}, mcp: []};
  assert.equal(resolveMcpGrants(tools, [server]).mcp[0].tools.mode, "all");
  assert.deepEqual(resolveMcpGrants({...tools, mcpDefault: "disabled"}, [server]).mcp, []);
  const disabled = {...tools, mcp: [{connectionId: server.id, tools: {mode: "selected", names: []}}]};
  assert.deepEqual(resolveMcpGrants(disabled, [server]).mcp, disabled.mcp);
  assert.deepEqual(resolveMcpGrants(disabled, []).mcp, []);
});

test("MCP success keeps credentials out of journals and replay performs no HTTP", async t => {
  environment(t);
  const fetch = t.mock.method(globalThis, "fetch", async (_url, init) => {
    assert.equal(new Headers(init.headers).get("Authorization"), `Bearer ${secret}`);
    const body = JSON.parse(init.body);
    return Response.json({jsonrpc: "2.0", id: body.id, result: {resultType: "complete", content: [{type: "text", text: "found"}]}});
  });
  const execute = ctx => durable.execute(ctx, executeMcpTool({}, {turnId: "turn", toolCallId: "call"}, tool));
  const live = await runHandler(execute);
  assert.equal(live.output.status, "succeeded");
  assert.ok(!text(live.journal).includes(secret));
  assert.equal(fetch.mock.callCount(), 1);
  const replay = await runHandler(execute, {replay: live.journal});
  assert.deepEqual(replay.output, live.output);
  assert.equal(fetch.mock.callCount(), 1);
});

test("provider failures are sanitized before journaling, without interactive auth or retry loops", async t => {
  environment(t);
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw Error(`Provider echoed ${secret}`); });
  const live = await runHandler(ctx => durable.execute(ctx, executeMcpTool({}, {turnId: "turn", toolCallId: "call"}, tool)));
  assert.equal(live.output.status, "failed");
  assert.ok(!text(live.journal).includes(secret));
  assert.ok(!live.output.error.includes(secret));
  assert.equal(fetch.mock.callCount(), 1);
});

test("discovery fails safely with a missing credential and does not send an anonymous request", async t => {
  environment(t); delete process.env.FIXTURE_MCP_TOKEN;
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw Error("must not send"); });
  const live = await runHandler(ctx => durable.execute(ctx, discoverMcpTools([server], {agentId: "demo", turnId: "turn"}, [])));
  assert.deepEqual(live.output.tools, []);
  assert.equal(live.output.servers[0].status, "unavailable");
  assert.match(live.output.servers[0].warnings[0], /missing/);
  assert.equal(fetch.mock.callCount(), 0);
});

test("discovery retries transient failures inside one effect and journals only sanitized warnings", async t => {
  environment(t);
  let calls = 0;
  const fetch = t.mock.method(globalThis, "fetch", async () => { calls++; throw Error(`Provider echoed ${secret}`); });
  const live = await runHandler(ctx => durable.execute(ctx, discoverMcpTools([server], {agentId: "demo", turnId: "turn"}, [])));
  assert.equal(calls, 3, "a transient failure is retried before giving up");
  assert.equal(live.output.servers[0].status, "unavailable");
  assert.ok(!text(live.journal).includes(secret));
  assert.ok(!JSON.stringify(live.output).includes(secret));
  const replay = await runHandler(ctx => durable.execute(ctx, discoverMcpTools([server], {agentId: "demo", turnId: "turn"}, [])), {replay: live.journal});
  assert.deepEqual(replay.output, live.output);
  assert.equal(fetch.mock.callCount(), 3, "replay performs no HTTP");
});
