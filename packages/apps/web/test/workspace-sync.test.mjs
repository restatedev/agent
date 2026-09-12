import assert from "node:assert/strict";
import {test} from "node:test";
import {WorkspaceSyncRequestSchema} from "@restate-agents/types";
import {syncWorkspace} from "../src/server/workspace-sync.ts";
import {createWorkspaceCache} from "../src/workspace-cache.ts";

const marker = (revision = 0, versions = {}) => ({revision, versions: {history: 0, profile: 0, approvals: 0, mcpAuth: 0, schedules: 0, ...versions}});
const profile = userId => ({identity: {userId}, agents: [{agentId: `${userId}-a`}, {agentId: `${userId}-b`}], connections: [], memories: []});
const cursor = (agents = []) => ({revision: null, profileRevision: null, agents: agents.map(agentId => ({agentId, nextSequence: 1}))});
const signal = () => new AbortController().signal;
function fixture() {
  const calls = [];
  const f = {profile: profile("alice"), notification: {revision: 0, profileRevision: 0, agents: {}}, authCount: 0, onAuth: () => {}, onWatch: () => {}, onHistory: () => {}};
  const user = {
    profile: async () => {calls.push("user-profile"); return structuredClone(f.profile);},
    notifications: async () => {calls.push("notifications"); return structuredClone(f.notification);},
    watchNotifications: async () => {calls.push("watch"); f.onWatch(); return structuredClone(f.notification);},
  };
  f.dependencies = {
    authorize: async (_user, token, force) => {
      if (token && !force) return {agentIds: JSON.parse(token), authorization: token};
      const profile = await user.profile();
      const agentIds = profile.agents.map(a => a.agentId);
      return {agentIds, authorization: JSON.stringify(agentIds), profile};
    },
    authenticate: async () => {f.authCount++; f.onAuth(f.authCount); return {userId: "alice", client: user};},
    agent: id => {
      calls.push(`client:${id}`);
      return {
        lastTurnSequence: async () => {calls.push(`completion:${id}`); return 2;},
        profile: async () => {calls.push(`profile:${id}`); return {guardrails: [], tools: {}};},
        approvals: async () => [], mcpAuthorizations: async () => [], schedules: async () => [],
        history: async from => {calls.push(`history:${id}:${from}`); f.onHistory(); return {entries: [{sequence: from, entry: {role: "assistant", text: id}}], nextSequence: from + 1};},
      };
    },
  };
  f.calls = calls;
  f.sync = request => syncWorkspace(request, f.dependencies, signal());
  return f;
}

test("sync rejects caller-selected identities and malformed cursors, but allows more than 100 agents", () => {
  for (const input of [{...cursor(), userId: "bob"}, {...cursor(), revision: -1}]) {
    assert.equal(WorkspaceSyncRequestSchema.safeParse(input).success, false);
  }
  assert.equal(WorkspaceSyncRequestSchema.safeParse(cursor(Array.from({length: 101}, (_, i) => String(i)))).success, true);
});
test("unauthenticated sync does not read notifications or session data", async () => {
  const f = fixture();
  f.dependencies.authenticate = async () => { throw new Error("Sign in required"); };
  await assert.rejects(f.sync(cursor(["alice-a"])), /Sign in/);
  assert.deepEqual(f.calls, []);
});
test("user A cannot request user B's conversation, even mixed with an owned agent", async () => {
  const f = fixture();
  await assert.rejects(f.sync(cursor(["alice-a", "bob-a"])), error => error.status === 404);
  assert.deepEqual(f.calls, ["user-profile"]);
});
test("duplicate agent cursors are rejected before reads", async () => {
  const f = fixture();
  await assert.rejects(f.sync(cursor(["alice-a", "alice-a"])), error => error.status === 400);
  assert.deepEqual(f.calls, ["user-profile"]);
});
test("feed records cannot expand ownership or expose another user's agent IDs", async () => {
  const f = fixture();
  f.notification.agents["bob-secret-agent"] = marker(4, {history: 4});
  const response = await f.sync(cursor(["alice-a"]));
  assert.ok(!JSON.stringify(response).includes("bob"));
  assert.ok(!f.calls.some(c => c.includes("bob")));
  assert.deepEqual(response.agentIds, ["alice-a", "alice-b"]);
});
test("expiry during long poll is checked before any agent data is read", async () => {
  const f = fixture();
  f.onAuth = n => {if (n === 2) throw new Error("Session revoked");};
  await assert.rejects(f.sync({revision: 0, profileRevision: 0, agents: [{agentId: "alice-a", notification: marker(), nextSequence: 3}]}), /revoked/);
  assert.ok(f.calls.includes("watch"));
  assert.ok(!f.calls.some(c => c.startsWith("client:")));
});
test("a different authenticated user after waiting cannot receive the old user's data", async () => {
  const f = fixture();
  const auth = f.dependencies.authenticate;
  f.dependencies.authenticate = async () => ({...await auth(), userId: f.authCount > 1 ? "bob" : "alice"});
  await assert.rejects(f.sync(cursor(["alice-a"])), error => error.status === 401);
  assert.ok(!f.calls.some(c => c.startsWith("client:")));
});
test("revocation during history loading prevents releasing the response", async () => {
  const f = fixture();
  f.onAuth = n => {if (n === 3) throw new Error("Session revoked");};
  await assert.rejects(f.sync(cursor(["alice-a"])), /revoked/);
  assert.ok(f.calls.includes("history:alice-a:1"));
});
test("deletion while waiting omits cached conversation and unread data", async () => {
  const f = fixture();
  f.onWatch = () => {f.profile.agents = [{agentId: "alice-b"}]; f.notification.profileRevision = 1; f.notification.revision = 1;};
  const response = await f.sync({revision: 0, profileRevision: 0, agents: [{agentId: "alice-a", notification: marker(), nextSequence: 3}]});
  assert.deepEqual(response.agentIds, ["alice-b"]);
  assert.ok(!f.calls.some(c => c.includes(":alice-a")));
});
test("startup captures the watermark before reads and fetches history only for opened agents", async () => {
  const f = fixture();
  f.onHistory = () => {f.notification = {revision: 2, profileRevision: 0, agents: {"alice-a": marker(2, {history: 2})}};};
  const response = await f.sync(cursor(["alice-a"]));
  assert.equal(response.revision, 0);
  assert.equal(response.agents[0].data.notification.revision, 0);
  assert.ok(f.calls.indexOf("notifications") < f.calls.indexOf("history:alice-a:1"));
  assert.ok(!f.calls.includes("history:alice-b:1"));
  assert.equal(response.completions.length, 2);
});
test("incremental sync reads only changed topics and appends from the saved sequence", async () => {
  const f = fixture();
  f.notification = {revision: 5, profileRevision: 0, agents: {"alice-a": marker(5, {history: 5}), "alice-b": marker(4, {history: 4})}};
  const response = await f.sync({revision: 3, profileRevision: 0, agents: [{agentId: "alice-a", notification: marker(3, {history: 3}), nextSequence: 40}]});
  assert.ok(f.calls.includes("history:alice-a:40"));
  assert.ok(!f.calls.some(c => c.startsWith("profile:")));
  assert.ok(!f.calls.some(c => c.startsWith("history:alice-b")));
  assert.equal(response.profile, undefined);
  assert.equal(response.agents[0].reset, false);
});
test("unchanged user watch does not reread any agent data", async () => {
  const f = fixture();
  const response = await f.sync({revision: 0, profileRevision: 0, agents: []});
  assert.ok(f.calls.includes("watch"));
  assert.ok(!f.calls.some(c => c.startsWith("client:")));
  assert.deepEqual(response.agents, []);
});

test("one unavailable agent preserves its retry cursor while other conversations update", async () => {
  const f = fixture();
  const agent = f.dependencies.agent;
  f.dependencies.agent = id => id === "alice-b" ? {...agent(id), lastTurnSequence: async () => {throw new Error("private provider failure");}} : agent(id);
  const update = await f.sync(cursor(["alice-a", "alice-b"]));
  assert.equal(update.revision, null);
  assert.equal(update.agents.length, 1);
  assert.equal(update.agents[0].agentId, "alice-a");
  assert.deepEqual(update.errors, [{agentId: "alice-b", message: "Agent data is temporarily unavailable"}]);
  assert.ok(!JSON.stringify(update).includes("private provider"));
});

const response = (userId = "alice", changes = {}) => ({userId, revision: 1, profileRevision: 0, agentIds: [`${userId}-a`, `${userId}-b`], agents: [], completions: [], ...changes});
const history = (start = 1) => ({entries: [{sequence: start, entry: {role: "assistant", text: "hello"}}], nextSequence: start + 1});
test("switching back retains cached data and cursors without requesting a reload", () => {
  const c = createWorkspaceCache(profile("alice"));
  let wakes = 0; c.onWake(() => wakes++);
  c.ensure("alice-a");
  c.apply(response("alice", {agents: [{agentId: "alice-a", reset: true, data: {notification: marker(1), history: history()}}]}));
  const before = c.getSnapshot().agents["alice-a"];
  c.ensure("alice-b"); c.ensure("alice-a");
  assert.equal(c.getSnapshot().agents["alice-a"], before);
  assert.equal(c.cursor().agents[0].nextSequence, 2);
  assert.equal(c.cursor().agents[0].notification.revision, 1);
  assert.equal(wakes, 2);
});
test("background deltas merge into retained conversations, with no duplicate history", () => {
  const c = createWorkspaceCache(profile("alice")); c.ensure("alice-a");
  c.apply(response("alice", {agents: [{agentId: "alice-a", reset: true, data: {notification: marker(1), history: history()}}]}));
  c.ensure("alice-b");
  const update = response("alice", {revision: 2, agents: [{agentId: "alice-a", reset: false, data: {notification: marker(2), history: history(2)}}]});
  c.apply(update); c.apply(update);
  assert.deepEqual(c.getSnapshot().agents["alice-a"].history.entries.map(e => e.sequence), [1, 2]);
});
test("workspace caches are account-isolated and reject mismatched responses", () => {
  const a = createWorkspaceCache(profile("alice")), b = createWorkspaceCache(profile("bob"));
  a.ensure("alice-a"); b.ensure("alice-a");
  assert.deepEqual(b.cursor().agents, []);
  assert.throws(() => a.apply(response("bob")), /identity/);
  assert.throws(() => a.setProfile(profile("bob")), /identity/);
  assert.equal(a.cursor().revision, null);
});
test("failed sync retains cursors; deletion and session loss evict cached data", () => {
  const c = createWorkspaceCache(profile("alice")); c.ensure("alice-a");
  c.apply(response("alice", {agents: [{agentId: "alice-a", reset: true, data: {notification: marker(1), history: history()}}]}));
  const before = c.cursor(); c.fail("offline"); assert.deepEqual(c.cursor(), before);
  c.apply(response("alice", {revision: 2, agentIds: ["alice-b"]}));
  assert.deepEqual(c.getSnapshot().agents, {});
  c.ensure("alice-b"); c.clear();
  assert.deepEqual(c.getSnapshot().agents, {});
  assert.deepEqual(c.getSnapshot().profile.memories, []);
  assert.deepEqual(c.getSnapshot().profile.connections, []);
});
