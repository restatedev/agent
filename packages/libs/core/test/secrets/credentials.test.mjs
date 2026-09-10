import assert from "node:assert/strict";
import {test} from "node:test";
import * as durable from "@restatedev/restate-sdk-gen";
import {sealMcpToken} from "@restate-agents/secrets";
import {discoverMcpTools,executeMcpTool,releaseMcpSessions} from "../../src/session/mcp-tools.ts";
import {runHandler} from "../ptc/harness.mjs";
process.env.APP_SECRET_KEY="test-key-only-32-bytes-not-a-real-secret";
test("MCP decrypts only for HTTP headers; discovery and tool runs replay without HTTP", async (t) => {
  const headers = [],
    methods = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const request = new Request(url, init);
    headers.push(request.headers.get("authorization"));
    const message = await request.json();
    methods.push(message.method);
    if (message.method === "notifications/initialized")
      return new Response(null, {status: 202});
    const result =
      message.method === "initialize"
        ? {
            protocolVersion: "2025-03-26",
            capabilities: {tools: {}},
            serverInfo: {name: "test", version: "1"},
          }
        : message.method === "tools/list"
          ? {
              tools: [
                {
                  name: "read",
                  description: "Read fixture",
                  inputSchema: {type: "object", properties: {}},
                },
              ],
            }
          : {content: [{type: "text", text: "safe result"}]};
    return Response.json({jsonrpc: "2.0", id: message.id, result});
  });
  const server = {
    id: "header-test",
    type: "http",
    url: "https://mcp.example.test",
    protocol: "stateful",
    auth: {type: "bearer"},
  };
  const credential = sealMcpToken(
    "demo",
    server.id,
    'Authorization: Bearer "test-header-token"',
  );
  const run = (replay) =>
    runHandler(
      (ctx) =>
        durable.execute(
          new Proxy(ctx,{get(target,key){
            if(key==="genericCall")return opts=>{assert.equal(opts.method,"validateConnection");return Object.assign(ctx.run("validate-user-connection",()=>true),{invocationId:ctx.run("validate-id",()=>"validate")});};
            const value=Reflect.get(target,key);return typeof value==="function"?value.bind(target):value;
          }}),
          durable.gen(function* () {
            const catalog = yield* discoverMcpTools(
              [server],
              [credential],
              {agentId: "demo", ownerUserId:"demo", turnId: "turn-header"},
              [],
            );
            assert.equal(catalog.tools.length, 1);
            const result = yield* executeMcpTool(
              {},
              {
                turnId: "turn-header",
                toolCallId: "call",
                *authorize() {
                  throw new Error("unexpected auth");
                },
              },
              catalog.tools[0],
            );
            yield* releaseMcpSessions("turn-header");
            return {catalog, result};
          }),
        ),
      {replay},
    );
  const first = await run([]),
    count = methods.length;
  assert.ok(count >= 4);
  assert.ok(headers.every((header) => header === "Bearer test-header-token"));
  assert.equal(first.output.result.status, "succeeded");
  const replay = await run(first.journal);
  assert.deepEqual(replay.output, first.output);
  assert.equal(methods.length, count);
  assert.ok(!JSON.stringify(first.output).includes("test-header-token"));
  assert.ok(
    !Buffer.concat(first.journal).toString().includes("test-header-token"),
  );
});
