import assert from "node:assert/strict";
import {test} from "node:test";

import {mergeAgentSnapshot} from "../src/agent-snapshot.ts";
import {loadAgentSnapshot, syncAgentSnapshot} from "../src/server/agent-snapshot.ts";

function notification(revision = 1, versions = {}) {
  return {
    revision,
    versions: {
      history: 0,
      profile: 0,
      approvals: 0,
      schedules: 0,
      ...versions,
    },
  };
}

function entry(sequence) {
  return {
    sequence,
    entry: {
      role: "assistant",
      text: "hello",
      turnId: "test",
      status: "completed",
    },
  };
}

/** A full history page of `count` entries starting at `fromSequence`. */
function historyPage(fromSequence, count) {
  const entries = Array.from({length: count}, (_, offset) => {
    return entry(fromSequence + offset);
  });
  return {entries, nextSequence: fromSequence + count};
}

function options() {
  return {
    signal: new AbortController().signal,
    idempotencyKey: "watch-test",
  };
}

/**
 * A fake agent client that records every call. `overrides` replaces
 * individual methods; the defaults describe an empty, unchanged agent.
 */
function fixture(overrides = {}) {
  const calls = [];
  const implementations = {
    notifications: async () => notification(),
    watch: async () => notification(),
    profile: async () => ({guardrails: [], tools: {}, webSearchEnabled: true}),
    approvals: async () => [],
    schedules: async () => [],
    metadata: async () => ({name: "demo"}),
    children: async () => [],
    history: async (fromSequence) => ({entries: [], nextSequence: fromSequence}),
    ...overrides,
  };
  const client = {};
  for (const [name, implementation] of Object.entries(implementations)) {
    client[name] = (...args) => {
      calls.push({name, args});
      return implementation(...args);
    };
  }
  return {client, calls};
}

function callNames(calls) {
  return calls.map((call) => call.name);
}

function argsOf(calls, name) {
  return calls.filter((call) => call.name === name).map((call) => call.args);
}

test("startup captures the watermark before fetching all data in parallel", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const {client, calls} = fixture({
    profile: async () => {
      await gate;
      return {guardrails: []};
    },
  });

  const pending = loadAgentSnapshot(client, options().signal);
  await new Promise((resolve) => setImmediate(resolve));

  // Every read has started while profile is still blocked on the gate.
  assert.deepEqual(callNames(calls), [
    "notifications",
    "profile",
    "approvals",
    "schedules",
    "metadata",
    "children",
    "history",
  ]);

  release();
  const result = await pending;
  assert.equal(result.notification.revision, 1);
  assert.deepEqual(result.history, {entries: [], nextSequence: 1});
  assert.deepEqual(result.approvals, []);
});

test("startup paginates on the UI proxy and stops at a short page", async () => {
  const {client, calls} = fixture({
    history: async (fromSequence) => {
      const count = fromSequence === 1 ? 100 : 2;
      return historyPage(fromSequence, count);
    },
  });

  const result = await loadAgentSnapshot(client, options().signal);

  assert.equal(result.history.entries.length, 102);
  assert.equal(result.history.nextSequence, 103);
  assert.deepEqual(argsOf(calls, "history"), [
    [1, 100],
    [101, 100],
  ]);
});

test("unchanged notification returns no cached data and performs no data reads", async () => {
  const {client, calls} = fixture();
  const opts = options();

  const result = await syncAgentSnapshot(client, notification(), 42, opts);

  assert.deepEqual(result, {notification: notification()});
  assert.deepEqual(calls, [{name: "watch", args: [1, 25, opts]}]);
});

test("sync fetches only changed topics, including empty arrays that clear UI state", async () => {
  const next = notification(3, {approvals: 1, schedules: 1});
  const {client, calls} = fixture({watch: async () => next});

  const result = await syncAgentSnapshot(client, notification(), 42, options());

  assert.deepEqual(result, {notification: next, approvals: [], schedules: []});
  assert.deepEqual(callNames(calls), ["watch", "approvals", "schedules"]);
});

test("history sync resumes at the browser cursor instead of reloading history", async () => {
  const {client, calls} = fixture({
    watch: async () => notification(2, {history: 1}),
    history: async () => ({entries: [entry(42)], nextSequence: 43}),
  });

  const result = await syncAgentSnapshot(client, notification(), 42, options());

  assert.equal(result.history.nextSequence, 43);
  assert.deepEqual(argsOf(calls, "history"), [[42, 100]]);
});

test("changes during initial reads remain visible to the first watch", async () => {
  let current = notification();
  const {client} = fixture({
    notifications: async () => current,
    // The profile changes while the initial snapshot is being read.
    profile: async () => {
      current = notification(2, {profile: 1});
      return {guardrails: []};
    },
    watch: async (revision) => {
      assert.equal(revision, 1);
      return current;
    },
  });

  const initial = await loadAgentSnapshot(client, options().signal);
  const update = await syncAgentSnapshot(
    client,
    initial.notification,
    initial.history.nextSequence,
    options(),
  );

  assert.equal(update.notification.revision, 2);
  assert.ok(update.profile);
  assert.deepEqual(update.metadata, {name: "demo"});
  assert.deepEqual(update.children, []);
});

test("failed sync can retry the same cursor and window key without losing changes", async () => {
  let fail = true;
  const {client, calls} = fixture({
    watch: async () => notification(2, {profile: 1}),
    profile: async () => {
      if (fail) {
        throw new Error("temporary");
      }
      return {guardrails: []};
    },
  });
  const since = notification();
  const opts = options();

  await assert.rejects(syncAgentSnapshot(client, since, 1, opts), /temporary/);
  fail = false;
  const retried = await syncAgentSnapshot(client, since, 1, opts);

  assert.ok(retried.profile);
  assert.deepEqual(argsOf(calls, "watch"), [
    [1, 25, opts],
    [1, 25, opts],
  ]);
  assert.equal(since.revision, 1);
});

test("aborting during a history page prevents further paging and returning stale state", async () => {
  const abort = new AbortController();
  const {client, calls} = fixture({
    history: async () => {
      abort.abort();
      return historyPage(1, 100);
    },
  });

  await assert.rejects(loadAgentSnapshot(client, abort.signal), {
    name: "AbortError",
  });
  assert.equal(argsOf(calls, "history").length, 1);
});

test("malformed non-advancing history fails rather than looping forever", async () => {
  const {client} = fixture({
    history: async () => ({entries: [entry(1)], nextSequence: 1}),
  });

  await assert.rejects(
    loadAgentSnapshot(client, options().signal),
    /cursor did not advance/,
  );
});

test("retried history merges do not duplicate entries or move the cursor backward", () => {
  const current = {
    notification: notification(2),
    history: {entries: [entry(1), entry(2)], nextSequence: 3},
    profile: {memories: []},
    metadata: {name: "demo"},
    children: [],
    approvals: [],
    schedules: [],
  };
  const update = {
    notification: notification(3),
    history: {entries: [entry(2), entry(3)], nextSequence: 4},
  };

  const merged = mergeAgentSnapshot(current, update);

  assert.deepEqual(
    merged.history.entries.map((item) => item.sequence),
    [1, 2, 3],
  );
  assert.equal(merged.history.nextSequence, 4);

  // An update older than the current revision is ignored.
  const stale = {...update, notification: notification(1)};
  assert.deepEqual(mergeAgentSnapshot(merged, stale), merged);
});
