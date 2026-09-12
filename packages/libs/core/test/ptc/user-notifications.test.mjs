import assert from "node:assert/strict";
import {test} from "node:test";
import {UserNotifications} from "../../src/notifications/user.ts";
import {AgentNotifications} from "../../src/notifications/service.ts";
import {User} from "../../src/user/service.ts";
import {context} from "./state-fixture.mjs";

test("user feed coalesces changes across agents and shared user state", async () => {
  const f = context("alice");
  await f.invoke(UserNotifications.object.publish, {kind: "agent", agentId: "a", topic: "history"});
  await f.invoke(UserNotifications.object.publish, {kind: "agent", agentId: "b", topic: "approvals"});
  await f.invoke(UserNotifications.object.publish, {kind: "profile"});
  const snapshot = await f.invoke(UserNotifications.object.snapshot);
  assert.equal(snapshot.revision, 3);
  assert.equal(snapshot.profileRevision, 3);
  assert.equal(snapshot.agents.a.versions.history, 1);
  assert.equal(snapshot.agents.b.versions.approvals, 2);
  assert.equal(snapshot.agents.b.versions.history, 0);
  const other = context("bob");
  assert.deepEqual(await other.invoke(UserNotifications.object.snapshot), {revision: 0, profileRevision: 0, agents: {}});
});
test("subscribe catches changes before registration and publish wakes existing watchers", async () => {
  const f = context("alice");
  assert.equal(await f.invoke(UserNotifications.object.subscribe, {afterRevision: 0, awakeableId: "watch-a"}), null);
  await f.invoke(UserNotifications.object.publish, {kind: "profile"});
  assert.equal(f.signals[0].id, "watch-a");
  assert.equal(f.signals[0].value.revision, 1);
  assert.equal(f.state.has("subscriptions"), false);
  assert.equal((await f.invoke(UserNotifications.object.subscribe, {afterRevision: 0, awakeableId: "watch-b"})).revision, 1);
  assert.equal((await f.invoke(UserNotifications.object.subscribe, {afterRevision: 99, awakeableId: "watch-reset"})).revision, 1);
});
test("unsubscribe cleans up only the matching watch", async () => {
  const f = context("alice");
  for (const id of ["one", "two", "one"]) await f.invoke(UserNotifications.object.subscribe, {afterRevision: 0, awakeableId: id});
  await f.invoke(UserNotifications.object.unsubscribe, {awakeableId: "one"});
  assert.deepEqual(f.state.get("subscriptions"), [{afterRevision: 0, awakeableId: "two"}]);
  await f.invoke(UserNotifications.object.unsubscribe, {awakeableId: "two"});
  assert.equal(f.state.has("subscriptions"), false);
});
test("agent relay derives its user key from immutable ownership, and caches that binding", async () => {
  const f = context("agent-a", {}, () => ({ownerUserId: "alice"}));
  await f.invoke(AgentNotifications.object.publish, "history");
  await f.invoke(AgentNotifications.object.publish, "approvals");
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].service, "Agent");
  assert.equal(f.calls[0].key, "agent-a");
  assert.equal(f.calls[0].method, "ownership");
  assert.deepEqual(f.sends.map(({service, key, parameter}) => ({service, key, parameter})), [
    {service: "UserNotifications", key: "alice", parameter: {kind: "agent", agentId: "agent-a", topic: "history"}},
    {service: "UserNotifications", key: "alice", parameter: {kind: "agent", agentId: "agent-a", topic: "approvals"}},
  ]);
});
test("unowned agents cannot publish into any user feed", async () => {
  const f = context("unowned", {}, () => null);
  await f.invoke(AgentNotifications.object.publish, "history");
  assert.deepEqual(f.sends, []);
});
test("shared memory mutations notify only the owning user's feed", async () => {
  const f = context("alice", {agents: [{agentId: "a"}]});
  await f.invoke(User.object.updateMemory, {agentId: "a", changes: [{operation: "set", key: "work", content: "Runtime"}]});
  assert.deepEqual(f.sends.map(({service, key, parameter}) => ({service, key, parameter})), [
    {service: "UserNotifications", key: "alice", parameter: {kind: "profile"}},
  ]);
});
