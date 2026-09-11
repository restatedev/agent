import assert from "node:assert/strict";
import {test} from "node:test";
import * as restate from "@restatedev/restate-sdk-gen";
import {createAgentInbox, lastTurnSequence} from "../../../../apps/web/src/agent-inbox.ts";
import * as history from "../../src/session/history.ts";
import {runHandler} from "../ptc/harness.mjs";

function storage() {
  const values = new Map();
  return {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value)};
}
const response = (sequence, status = "completed") => ({
  sequence,
  entry: {role: "assistant", text: "Done", turnId: `turn-${sequence}`, status},
});

test("only terminal responses advance the inbox, including interrupted/failed results", () => {
  const entries = [
    {sequence: 1, entry: {role: "user", text: "Hello", delivery: "turn"}},
    {sequence: 2, entry: {role: "event", type: "progress", turnId: "turn", phase: "thinking"}},
    {sequence: 3, entry: {role: "event", type: "steer", turnId: "turn", queuedMessages: 0}},
  ];
  assert.equal(lastTurnSequence(entries), 0);
  for (const status of ["completed", "interrupted", "stopped", "failed"]) {
    assert.equal(lastTurnSequence([...entries, response(4, status), {...entries[1], sequence: 5}]), 4);
  }
});

test("unread survives refresh; opening one agent acknowledges only the loaded response", () => {
  const saved = storage();
  let inbox = createAgentInbox("user-a", () => saved);
  inbox.observe([{agentId: "one", sequence: 5}, {agentId: "two", sequence: 8}]);
  assert.deepEqual([...inbox.getSnapshot()], ["one", "two"]);
  inbox.markSeen("one", 0); // Still loading its transcript.
  assert.ok(inbox.getSnapshot().has("one"));
  inbox.markSeen("one", 5);
  assert.deepEqual([...inbox.getSnapshot()], ["two"]);
  inbox = createAgentInbox("user-a", () => saved);
  inbox.observe([{agentId: "one", sequence: 5}, {agentId: "two", sequence: 8}]);
  assert.deepEqual([...inbox.getSnapshot()], ["two"]);
  inbox.observe([{agentId: "one", sequence: 12}]);
  inbox.markSeen("one", 5); // A stale/partially loaded page cannot clear a later turn.
  assert.ok(inbox.getSnapshot().has("one"));
  inbox.markSeen("one", 12);
  inbox.observe([{agentId: "one", sequence: 5}]);
  assert.ok(!inbox.getSnapshot().has("one"));
});

test("partial/failed polls preserve badges and active-agent reads can precede polling", () => {
  const saved = storage(), inbox = createAgentInbox("user", () => saved);
  inbox.markSeen("active", 20);
  inbox.observe([{agentId: "active", sequence: 20}, {agentId: "other", sequence: 8}]);
  inbox.observe([]);
  inbox.observe([{agentId: "other", sequence: 0}]);
  assert.deepEqual([...inbox.getSnapshot()], ["other"]);
});

test("another agent finishing is unread while the currently open agent stays read", () => {
  const saved = storage(), inbox = createAgentInbox("user", () => saved);
  inbox.markSeen("research", 6);
  inbox.markSeen("planner", 8);
  inbox.observe([{agentId:"research",sequence:6},{agentId:"planner",sequence:8}]);
  assert.equal(inbox.getSnapshot().size,0);
  // The user is reading Research when Planner's next turn finishes.
  inbox.observe([{agentId:"research",sequence:6},{agentId:"planner",sequence:18}]);
  inbox.markSeen("research",6);
  assert.deepEqual([...inbox.getSnapshot()],["planner"]);
  // Refreshing Research must not acknowledge Planner's response.
  const refreshed=createAgentInbox("user",()=>saved);
  refreshed.markSeen("research",6);
  refreshed.observe([{agentId:"research",sequence:6},{agentId:"planner",sequence:18}]);
  assert.deepEqual([...refreshed.getSnapshot()],["planner"]);
  refreshed.markSeen("planner",18);
  assert.equal(refreshed.getSnapshot().size,0);
});

test("read receipts are user-scoped, synchronize across tabs, and tolerate blocked storage", () => {
  const saved = storage();
  const first = createAgentInbox("a", () => saved), second = createAgentInbox("a", () => saved);
  second.observe([{agentId: "one", sequence: 8}]);
  first.markSeen("one", 8);
  second.sync();
  assert.equal(second.getSnapshot().size, 0);
  const otherUser = createAgentInbox("b", () => saved);
  otherUser.observe([{agentId: "one", sequence: 8}]);
  assert.ok(otherUser.getSnapshot().has("one"));
  const blocked = createAgentInbox("a", () => {throw Error("Storage denied");});
  blocked.observe([{agentId: "one", sequence: 8}]);
  blocked.markSeen("one", 8);
  blocked.markSeen("one", 4);
  blocked.observe([{agentId: "one", sequence: 8}]);
  assert.equal(blocked.getSnapshot().size, 0);
});

test("subscribers see changes only, never duplicate polls or regressing read receipts", () => {
  const saved = storage(), inbox = createAgentInbox("user", () => saved);
  let changes = 0;
  const unsubscribe = inbox.subscribe(() => changes++);
  inbox.observe([{agentId: "one", sequence: 8}]);
  inbox.observe([{agentId: "one", sequence: 8}]);
  assert.equal(changes, 1);
  inbox.markSeen("one", 8);
  inbox.markSeen("one", 4);
  assert.equal(changes, 2);
  unsubscribe();
  inbox.observe([{agentId: "one", sequence: 16}]);
  assert.equal(changes, 2);
});

test("AgentSession durably indexes final responses and completion reads never scan history", async () => {
  const state = new Map(), reads = [];
  async function run(operation) {
    return runHandler(ctx => {
      let index = 0;
      const proxy = new Proxy(ctx, {get(target, key) {
        if (key === "key") return "inbox-test";
        if (key === "get") return name => {reads.push(name); return ctx.run(`get-${index++}`, () => structuredClone(state.get(name) ?? null));};
        if (key === "set") return (name, value) => state.set(name, structuredClone(value));
        if (key === "genericSend") return () => ({invocationId: ctx.run(`send-${index++}`, () => "send-id")});
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      }});
      return restate.execute(proxy, operation);
    });
  }
  assert.equal((await run(history.lastTurnSequence())).output, 0);
  await run(restate.gen(function* () {
    const writer = yield* history.openTurn();
    yield* writer.append({role: "user", text: "Hello", delivery: "turn"});
    assert.equal(yield* history.lastTurnSequence(), 0);
    yield* writer.append(response(2).entry);
    yield* writer.append({role: "event", type: "progress", turnId: "next", phase: "thinking"});
    return true;
  }));
  reads.length = 0;
  assert.equal((await run(history.lastTurnSequence())).output, 2);
  assert.deepEqual(reads, ["history/meta"]);
  await run(restate.gen(function* () {
    const writer = yield* history.openTurn();
    yield* writer.append(response(4, "failed").entry);
    return true;
  }));
  assert.equal((await run(history.lastTurnSequence())).output, 4);
  assert.equal((await run(history.page(1, 100))).output.entries.length, 4);
});
