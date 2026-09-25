import assert from "node:assert/strict";
import {test} from "node:test";

import * as durable from "@restatedev/restate-sdk-gen";

import {
  configuredMcpServers,
  readMcpConfiguration,
  resolveMcpGrants,
  resolveMcpToken,
} from "../src/session/mcp-config.ts";
import {turnTools} from "../src/session/turn-tools.ts";
import {runHandler} from "./harness.mjs";
import {runToolCall} from "./tool-harness.mjs";

const server = {
  id: "fixture",
  type: "http",
  url: "https://fixture.example/mcp",
  protocol: "stateless",
  tokenEnv: "FIXTURE_MCP_TOKEN",
};
const secret = "synthetic-private-token";
function environment(t, servers = [server]) {
  for (const [key, value] of Object.entries({
    MCP_SERVERS_JSON: JSON.stringify(servers),
    FIXTURE_MCP_TOKEN: secret,
  })) {
    const before = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (before === undefined) delete process.env[key];
      else process.env[key] = before;
    });
  }
}
const text = (journal) =>
  journal.map((frame) => frame.toString("utf8")).join("");

test("configuration snapshots only credential references and replays without reading changed environment", async (t) => {
  environment(t);
  const live = await runHandler((ctx) =>
    durable.execute(ctx, configuredMcpServers()),
  );
  assert.deepEqual(live.output, [server]);
  assert.ok(!text(live.journal).includes(secret));
  process.env.MCP_SERVERS_JSON = "invalid";
  const replay = await runHandler(
    (ctx) => durable.execute(ctx, configuredMcpServers()),
    {replay: live.journal},
  );
  assert.deepEqual(replay.output, live.output);
});

test("configuration rejects inline tokens, duplicate IDs, and unsafe endpoints without echoing supplied data", () => {
  for (const value of [
    [{...server, token: secret}],
    [server, server],
    [{...server, url: "file:///tmp/private"}],
    [{...server, url: `https://name:${secret}@example.com`}],
    [{...server, tokenEnv: "OPENAI_API_KEY"}],
    [{...server, tokenEnv: "_MCP_TOKEN"}],
    secret,
  ]) {
    assert.throws(
      () => readMcpConfiguration({MCP_SERVERS_JSON: JSON.stringify(value)}),
      (error) =>
        !error.message.includes(secret) &&
        /Invalid MCP_SERVERS_JSON/.test(error.message),
    );
  }
  assert.throws(
    () =>
      resolveMcpToken(server, {
        MCP_SERVERS_JSON: "[]",
        FIXTURE_MCP_TOKEN: secret,
      }),
    /configuration changed/,
  );
  assert.throws(
    () => resolveMcpToken(server, {MCP_SERVERS_JSON: JSON.stringify([server])}),
    /missing/,
  );
});

test("operator defaults, explicit opt-outs, and pinned child grants resolve consistently", () => {
  const tools = {
    builtin: {mode: "all"},
    dynamic: {mode: "selected", names: []},
    mcp: [],
  };
  assert.equal(resolveMcpGrants(tools, [server]).mcp[0].tools.mode, "all");
  assert.deepEqual(
    resolveMcpGrants({...tools, mcpDefault: "disabled"}, [server]).mcp,
    [],
  );
  const disabled = {
    ...tools,
    mcp: [{serverId: server.id, tools: {mode: "selected", names: []}}],
  };
  assert.deepEqual(resolveMcpGrants(disabled, [server]).mcp, disabled.mcp);
  assert.deepEqual(resolveMcpGrants(disabled, []).mcp, []);
});

// A stateless MCP server: discovery, one `lookup` tool, then `onCall`.
function mcpServer(t, onCall) {
  return t.mock.method(globalThis, "fetch", async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.id === undefined) return new Response(null, {status: 202});
    const reply = (result) =>
      Response.json({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          ...result,
          resultType: "complete",
          ttlMs: 60000,
          cacheScope: "private",
        },
      });
    if (body.method === "server/discover")
      return reply({
        supportedVersions: ["2026-07-28"],
        capabilities: {tools: {}},
      });
    if (body.method === "tools/list")
      return reply({
        tools: [
          {
            name: "lookup",
            description: "Find",
            inputSchema: {type: "object", properties: {}},
          },
        ],
      });
    return onCall(body, init, reply);
  });
}

const grants = {
  builtin: {mode: "selected", names: []},
  dynamic: {mode: "selected", names: []},
  mcp: [{serverId: "fixture", tools: {mode: "all"}}],
};
const request = {tools: grants, webSearchEnabled: false, mcpServers: [server]};

/** Discovers the turn's catalog and calls the fixture's lookup tool once. */
function* lookup() {
  const catalog = yield* turnTools(request);
  return yield* runToolCall(
    {id: "call", name: "fixture_lookup", input: {}},
    {tools: catalog.tools},
  );
}

test("MCP success keeps credentials out of journals and replay performs no HTTP", async (t) => {
  environment(t);
  const fetch = mcpServer(t, (_body, init, reply) => {
    assert.equal(
      new Headers(init.headers).get("Authorization"),
      `Bearer ${secret}`,
    );
    return reply({content: [{type: "text", text: "found"}]});
  });
  const execute = (ctx) => durable.execute(ctx, lookup());
  const live = await runHandler(execute);
  assert.equal(live.output.status, "success");
  assert.ok(!text(live.journal).includes(secret));
  const requests = fetch.mock.callCount();
  const replay = await runHandler(execute, {replay: live.journal});
  assert.deepEqual(replay.output, live.output);
  assert.equal(fetch.mock.callCount(), requests);
});

test("provider failures are sanitized before journaling", async (t) => {
  environment(t);
  mcpServer(t, () => {
    throw Error(`Provider echoed ${secret}`);
  });
  const live = await runHandler((ctx) => durable.execute(ctx, lookup()));
  assert.equal(live.output.status, "error");
  assert.ok(!text(live.journal).includes(secret));
  assert.ok(!live.output.message.includes(secret));
});

test("a JSON-RPC tool error reaches the model with its code and message, never the token", async (t) => {
  environment(t);
  mcpServer(t, (body) =>
    Response.json({
      jsonrpc: "2.0",
      id: body.id,
      error: {
        code: -32602,
        message: `Invalid arguments: city is required (auth ${secret})`,
      },
    }),
  );
  const live = await runHandler((ctx) => durable.execute(ctx, lookup()));
  assert.equal(live.output.status, "error");
  assert.match(live.output.message, /Invalid arguments: city is required/);
  assert.ok(!live.output.message.includes(secret));
  assert.ok(!text(live.journal).includes(secret));
});

test("discovery fails safely with a missing credential and does not send an anonymous request", async (t) => {
  environment(t);
  delete process.env.FIXTURE_MCP_TOKEN;
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    throw Error("must not send");
  });
  const live = await runHandler((ctx) =>
    durable.execute(
      ctx,
      (function* () {
        const {tools, notes} = yield* turnTools(request);
        return {tools: Object.keys(tools), notes};
      })(),
    ),
  );
  assert.deepEqual(live.output.tools, []);
  assert.match(
    live.output.notes[0].content,
    /configured but unavailable \(MCP credential environment variable is missing\)/,
  );
  assert.equal(fetch.mock.callCount(), 0);
});
