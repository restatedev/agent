import assert from "node:assert/strict";
import {test} from "node:test";
import {loadAgentSnapshot, syncAgentSnapshot} from "../src/server/agent-snapshot.ts";

const notification = (revision = 1, versions = {}) => ({
  revision,
  versions: {history: 0, profile: 0, approvals: 0, mcpAuth: 0, schedules: 0, ...versions},
});
const entry = (sequence) => ({
  sequence,
  entry: {role: "assistant", text: "hello", turnId: "test", status: "completed"},
});
const options = () => ({signal: new AbortController().signal, idempotencyKey: "watch-test"});

function fixture(overrides = {}) {
  const calls = [];
  const implementations = {
    notifications: async () => notification(),
    watchNotifications: async () => notification(),
    profile: async () => ({memories: [], guardrails: [], tools: {}, webSearchEnabled: true}),
    approvals: async () => [],
    mcpAuthorizations: async () => [],
    schedules: async () => [],
    history: async (fromSequence) => ({entries: [], nextSequence: fromSequence}),
    ...overrides,
  };
  const client = Object.fromEntries(Object.entries(implementations).map(([name, fn]) => [
    name, (...args) => { calls.push({name, args}); return fn(...args); },
  ]));
  return {client, calls};
}

test("startup captures the watermark before fetching all data in parallel", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const {client, calls} = fixture({profile: async () => { await gate; return {memories: []}; }});
  const pending = loadAgentSnapshot(client, options().signal);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls.map(c => c.name), [
    "notifications", "profile", "approvals", "mcpAuthorizations", "schedules", "history",
  ]);
  release();
  const result = await pending;
  assert.equal(result.notification.revision, 1);
  assert.deepEqual(result.history, {entries: [], nextSequence: 1});
  assert.deepEqual(result.approvals, []);
});

test("startup paginates on the BFF and stops at a short page", async () => {
  const {client, calls} = fixture({history: async (fromSequence) => {
    const count = fromSequence === 1 ? 100 : 2;
    return {entries: Array.from({length: count}, (_, i) => entry(fromSequence + i)), nextSequence: fromSequence + count};
  }});
  const result = await loadAgentSnapshot(client, options().signal);
  assert.equal(result.history.entries.length, 102);
  assert.equal(result.history.nextSequence, 103);
  assert.deepEqual(calls.filter(c => c.name === "history").map(c => c.args), [[1, 100], [101, 100]]);
});

test("unchanged notification returns no cached data and performs no data reads", async () => {
  const {client, calls} = fixture();
  const opts = options();
  assert.deepEqual(await syncAgentSnapshot(client, notification(), 42, opts), {notification: notification()});
  assert.deepEqual(calls, [{name: "watchNotifications", args: [1, 25, opts]}]);
});

test("sync fetches only changed topics, including empty arrays that clear UI state", async () => {
  const next = notification(3, {approvals: 1, mcpAuth: 1});
  const {client, calls} = fixture({watchNotifications: async () => next});
  const result = await syncAgentSnapshot(client, notification(), 42, options());
  assert.deepEqual(result, {notification: next, approvals: [], mcpAuthorizations: []});
  assert.deepEqual(calls.map(c => c.name), ["watchNotifications", "approvals", "mcpAuthorizations"]);
});

test("history sync resumes at the browser cursor instead of reloading history", async () => {
  const {client, calls} = fixture({
    watchNotifications: async () => notification(2, {history: 1}),
    history: async () => ({entries: [entry(42)], nextSequence: 43}),
  });
  const result = await syncAgentSnapshot(client, notification(), 42, options());
  assert.equal(result.history.nextSequence, 43);
  assert.deepEqual(calls[1], {name: "history", args: [42, 100]});
});

test("changes during initial reads remain visible to the first watch", async () => {
  let current = notification();
  const {client} = fixture({
    notifications: async () => current,
    profile: async () => { current = notification(2, {profile: 1}); return {memories: []}; },
    watchNotifications: async (revision) => { assert.equal(revision, 1); return current; },
  });
  const initial = await loadAgentSnapshot(client, options().signal);
  const update = await syncAgentSnapshot(client, initial.notification, initial.history.nextSequence, options());
  assert.equal(update.notification.revision, 2);
  assert.ok(update.profile);
});

test("failed sync can retry the same cursor and window key without losing changes", async () => {
  let fail = true;
  const {client, calls} = fixture({
    watchNotifications: async () => notification(2, {profile: 1}),
    profile: async () => { if (fail) throw new Error("temporary"); return {memories: []}; },
  });
  const since = notification();
  const opts = options();
  await assert.rejects(syncAgentSnapshot(client, since, 1, opts), /temporary/);
  fail = false;
  assert.ok((await syncAgentSnapshot(client, since, 1, opts)).profile);
  assert.deepEqual(calls.filter(c => c.name === "watchNotifications").map(c => c.args), [[1, 25, opts], [1, 25, opts]]);
  assert.equal(since.revision, 1);
});

test("aborting during a history page prevents further paging and returning stale state", async () => {
  const abort = new AbortController();
  const {client, calls} = fixture({history: async () => {
    abort.abort();
    return {entries: Array.from({length: 100}, (_, i) => entry(i + 1)), nextSequence: 101};
  }});
  await assert.rejects(loadAgentSnapshot(client, abort.signal), {name: "AbortError"});
  assert.equal(calls.filter(c => c.name === "history").length, 1);
});

test("malformed non-advancing history fails rather than looping forever", async () => {
  const {client} = fixture({history: async () => ({entries: [entry(1)], nextSequence: 1})});
  await assert.rejects(loadAgentSnapshot(client, options().signal), /cursor did not advance/);
});
