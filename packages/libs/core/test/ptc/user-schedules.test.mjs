import assert from "node:assert/strict";
import {test} from "node:test";
import {User} from "../../src/user/service.ts";
import {Agent} from "../../src/agent/service.ts";
import {context} from "./state-fixture.mjs";

const tools = {builtin: {mode: "all"}, dynamic: {mode: "selected", names: []}, mcp: []};
const spec = {scheduleId: "news", name: "Daily news", message: "Summarize news", delaySeconds: 60, repeatEverySeconds: 3600, tools: null};
const profile = {guardrails: [], tools, webSearchEnabled: true};
const initial = () => ({identity: {userId: "alice"}, agents: [], "user-schedules": [{schedule: {...spec, nextRunAt: 1, skippedRuns: 0}, profile, invocationId: "inv-test"}]});

test("user schedule uses a delayed Restate self-send; replacing cancels the prior invocation", async () => {
  const f = context("alice", {identity: {userId: "alice"}});
  await f.invoke(User.object.upsertSchedule, spec);
  const sent = f.sends.find(s => s.method === "fireSchedule");
  assert.equal(sent.service, "User"); assert.equal(sent.key, "alice");
  assert.equal(sent.delay, 60000);
  const old = f.state.get("user-schedules")[0].invocationId;
  await f.invoke(User.object.upsertSchedule, {...spec, message: "Updated"});
  assert.ok(f.cancelled.includes(old));
  assert.equal((await f.invoke(User.object.schedules)).length, 1);
  assert.ok(f.sends.some(s => s.service === "UserNotifications" && s.key === "alice"));
});

test("valid occurrence creates an independent owned agent, advances recurrence, and rejects duplicate/stale delivery", async () => {
  const f = context("alice", initial(), call => {
    assert.equal(call.method, "initialize");
    assert.equal(call.parameter.ownerUserId, "alice");
    assert.equal(call.parameter.parentAgentId, undefined);
    assert.equal(call.parameter.scheduledMessage, spec.message);
  });
  await f.invoke(User.object.fireSchedule, {scheduleId: "news"});
  const [agent] = f.state.get("agents");
  assert.equal(agent.scheduleRun.status, "running");
  assert.equal(f.calls.length, 1); // Never awaits an Agent turn under the User lock.
  assert.equal(f.sends.find(s => s.method === "executeSchedule").parameter.agentId, agent.agentId);
  assert.equal(f.sends.find(s => s.method === "fireSchedule").delay, 3600000);
  await f.invoke(User.object.fireSchedule, {scheduleId: "news"});
  assert.equal(f.state.get("agents").length, 1);
  assert.equal(f.calls.length, 1);
  const other = context("bob", {...initial(), identity: {userId: "bob"}}, () => {});
  await other.invoke(User.object.fireSchedule, {scheduleId: "news"});
  assert.notEqual(other.state.get("agents")[0].agentId, agent.agentId);
});

test("overlap is skipped, including replacement, and exact completion releases the next occurrence", async () => {
  const f = context("alice", {...initial(), "schedule-active": {news: "previous"}}, () => {});
  await f.invoke(User.object.fireSchedule, {scheduleId: "news"});
  assert.equal(f.state.get("agents").length, 0);
  assert.equal(f.state.get("user-schedules")[0].schedule.skippedRuns, 1);
  await f.invoke(User.object.upsertSchedule, spec);
  assert.equal(f.state.get("schedule-active").news, "previous");
  await f.invoke(User.object.finishSchedule, {agentId: "unrelated", status: "completed"});
  assert.equal(f.state.get("schedule-active").news, "previous");
  await f.invoke(User.object.finishSchedule, {agentId: "previous", status: "completed"});
  assert.deepEqual(f.state.get("schedule-active"), {});
});

test("one-shot retains its definition, deletion retains runs and stale callbacks cannot recreate work", async () => {
  const state = initial(); state["user-schedules"][0].schedule.repeatEverySeconds = null;
  const f = context("alice", state, () => {});
  await f.invoke(User.object.fireSchedule, {scheduleId: "news"});
  const [agent] = f.state.get("agents");
  assert.equal(f.state.get("user-schedules")[0].schedule.nextRunAt, null);
  await f.invoke(User.object.cancelSchedule, {scheduleId: "news"});
  assert.equal(f.state.get("agents").length, 1);
  await f.invoke(User.object.fireSchedule, {scheduleId: "news"});
  assert.equal(f.state.get("agents").length, 1);
  await f.invoke(User.object.finishSchedule, {agentId: agent.agentId, status: "completed"});
  assert.equal(f.state.get("agents")[0].scheduleRun.status, "completed");
  assert.deepEqual(f.state.get("schedule-active"), {});
});

test("agent-created schedules pin current permissions and reject broader access or another turn", async () => {
  const restricted = {...tools, builtin: {mode: "selected", names: ["createSchedule", "webSearch"]}};
  const f = context("parent", {ownership: {ownerUserId: "alice", name: "Parent"}, turn: {id: "turn", tools: restricted, steeringBatches: []}}, call => {
    assert.equal(call.key, "alice"); assert.equal(call.method, "saveAgentSchedule");
    assert.deepEqual(call.parameter.profile.tools.builtin, restricted.builtin);
    assert.equal(call.parameter.profile.tools.mcpDefault, "disabled");
    return {...spec, tools: restricted, nextRunAt: 1, skippedRuns: 0};
  });
  await f.invoke(Agent.object.createSchedule, {...spec, turnId: "turn"});
  await assert.rejects(f.invoke(Agent.object.createSchedule, {...spec, turnId: "turn", tools}), /cannot exceed/);
  await assert.rejects(f.invoke(Agent.object.createSchedule, {...spec, turnId: "other"}), /active Turn/);
  const u = context("bob", {agents: []});
  await assert.rejects(u.invoke(User.object.saveAgentSchedule, {agentId: "parent", spec, profile}), /does not belong/);
});

test("deleted runs finish cleanup before startup; foreign users cannot start scheduled agents", async () => {
  const f = context("alice", {agents: [], "schedule-active": {news: "deleted"}}, call => {
    assert.equal(call.method, "finishSchedule"); assert.equal(call.key, "alice");
  });
  await f.invoke(User.object.executeSchedule, {agentId: "deleted"});
  assert.equal(f.calls.length, 1);
  const a = context("run", {ownership: {ownerUserId: "alice", name: "Run"}, "scheduled-message": "Task"});
  await assert.rejects(a.invoke(Agent.object.startScheduledTurn, {ownerUserId: "bob"}), /owner mismatch/);
  await assert.rejects(a.invoke(Agent.object.ask, {message: "Race startup"}), /starting/);
});

test("schedule IDs matching object prototype names do not count as active runs", async () => {
  for (const scheduleId of ["constructor", "toString", "__proto__"]) {
    const state = initial(); state["user-schedules"][0].schedule.scheduleId = scheduleId;
    const f = context("alice", state, () => {});
    await f.invoke(User.object.fireSchedule, {scheduleId});
    assert.equal(f.state.get("agents").length, 1);
    assert.equal(f.state.get("user-schedules")[0].schedule.skippedRuns, 0);
  }
});
