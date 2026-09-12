import assert from "node:assert/strict";
import {test} from "node:test";
import {createAgentClient} from "../src/agent-client.ts";
import {createWorkspaceCache} from "../src/workspace-cache.ts";

test("agent client returns opaque proofs unchanged and keeps per-agent proofs instance-local", async t => {
  const seen = [];
  let workspaceToken = "opaque-workspace";
  t.mock.method(globalThis, "fetch", async (_path, options) => {
    seen.push(options.headers);
    return Response.json({name: "Agent"}, {headers: {"x-agent-access": "opaque-agent", "x-agent-user": "alice"}});
  });
  const a = createAgentClient("a", {userId: "alice", authorization: () => workspaceToken});
  await a.profile();
  assert.equal(seen[0]["x-workspace-access"], workspaceToken);
  assert.equal(seen[0]["x-agent-access"], undefined);
  workspaceToken = "renewed-workspace";
  await a.profile();
  assert.equal(seen[1]["x-agent-access"], "opaque-agent");
  assert.equal(seen[1]["x-workspace-access"], workspaceToken);
  await createAgentClient("b").profile();
  assert.equal(seen[2]["x-agent-access"], undefined);
  workspaceToken = "x".repeat(6001);
  await a.profile();
  assert.equal(seen[3]["x-workspace-access"], undefined);
  assert.equal(seen[3]["x-agent-access"], "opaque-agent");
});

test("client rejects another user's response before applying data", async t => {
  t.mock.method(globalThis, "fetch", async () => Response.json({name: "Other"}, {headers: {"x-agent-user": "bob", "x-agent-access": "bob-proof"}}));
  const client = createAgentClient("a", {userId: "alice", authorization: () => undefined});
  await assert.rejects(client.profile(), error => error.status === 401);
});

test("workspace proof follows the account cache and is cleared on session loss", () => {
  const profile = {identity: {userId: "alice"}, agents: [], connections: [], memories: []};
  const cache = createWorkspaceCache(profile);
  assert.equal(cache.cursor().authorization, undefined);
  cache.apply({userId: "alice", revision: 0, profileRevision: 0, agentIds: [], agents: [], completions: [], authorization: "opaque"});
  assert.equal(cache.authorization(), "opaque");
  assert.equal(cache.cursor().authorization, "opaque");
  assert.throws(() => cache.apply({userId: "bob", authorization: "foreign"}), /identity/);
  assert.equal(cache.authorization(), "opaque");
  cache.clear();
  assert.equal(cache.authorization(), undefined);
  assert.equal(cache.cursor().authorization, undefined);
});
