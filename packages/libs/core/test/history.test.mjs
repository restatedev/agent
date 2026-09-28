import assert from "node:assert/strict";
import {test} from "node:test";

import * as durable from "@restatedev/restate-sdk-gen";

import * as history from "../src/session/history.ts";
import {context} from "./state-fixture.mjs";

const user = (text) => ({role: "user", text, delivery: "turn"});
const event = {
  role: "event",
  type: "progress",
  turnId: "t",
  phase: "thinking",
  message: "Thinking...",
};

// Runs a history operation against the fixture's state map.
function run(f, body) {
  return f.invoke((ctx) => durable.execute(ctx, durable.gen(body)));
}

test("history pages across chunk boundaries and reopened turns append after the tail", async () => {
  const f = context("demo");
  await run(f, function* () {
    const turn = yield* history.openTurn();
    for (let i = 1; i <= 40; i++) yield* turn.append(user(`m${i}`));
  });
  await run(f, function* () {
    const turn = yield* history.openTurn();
    assert.equal(turn.context().entries.length, 40);
    yield* turn.append(user("m41"), event);
  });
  const page = await run(f, function* () {
    return yield* history.page(30, 5);
  });
  assert.deepEqual(
    page.entries.map((e) => e.sequence),
    [30, 31, 32, 33, 34],
  );
  assert.equal(page.nextSequence, 35);
  const tail = await run(f, function* () {
    return yield* history.page(40, 100);
  });
  assert.deepEqual(
    tail.entries.map((e) => e.entry.text ?? e.entry.type),
    ["m40", "m41", "progress"],
  );
  assert.equal(tail.nextSequence, 43);
  assert.equal(f.sends.filter((s) => s.method === "publish").length, 41);
});

const assistant = (text) => ({
  role: "assistant",
  text,
  turnId: "t",
  status: "completed",
});

// One turn that appends `entries` and returns the reservation it made, if any.
function reserve(f, entries) {
  return run(f, function* () {
    const turn = yield* history.openTurn();
    for (const entry of entries) yield* turn.append(entry);
    return (yield* turn.beginCompaction()) ?? null;
  });
}

function finish(f, plan, result) {
  return run(f, function* () {
    return yield* history.finishCompaction({...plan, ...result});
  });
}

function openContext(f) {
  return run(f, function* () {
    return (yield* history.openTurn()).context();
  });
}

// `count` exchanges: a user message and the assistant reply to it.
function exchanges(from, count) {
  const entries = [];
  for (let i = from; i < from + count; i++) {
    entries.push(user(`q${i}`), assistant(`a${i}`), event);
  }
  return entries;
}

test("compaction summarizes the older prefix and keeps recent exchanges verbatim", async () => {
  const f = context("demo");
  assert.equal(await reserve(f, exchanges(0, 15)), null, "30 messages");

  // Exchange 15 reaches 32 messages. Each exchange is three entries, so
  // exchange i starts at sequence 3i + 1; the last four exchanges (eight
  // messages) stay out of the plan.
  const plan = await reserve(f, exchanges(15, 1));
  assert.deepEqual(plan, {baseThrough: 0, through: 36});

  // The next turn appends while the summary is being made.
  await reserve(f, exchanges(16, 1));
  assert.equal(
    await finish(f, plan, {status: "completed", summary: "s1"}),
    true,
  );

  const after = await openContext(f);
  assert.equal(after.summary, "s1");
  assert.equal(
    after.entries[0].text,
    "q12",
    "the tail starts at a user message",
  );
  assert.deepEqual(
    after.entries.filter((e) => e.role !== "event").map((e) => e.text),
    ["q12", "a12", "q13", "a13", "q14", "a14", "q15", "a15", "q16", "a16"],
  );

  // The next summary builds on this one, starting after its range.
  const next = await reserve(f, exchanges(17, 11));
  assert.deepEqual(next, {baseThrough: 36, through: 72});
});

test("the verbatim tail never starts at an assistant reply", async () => {
  const f = context("demo");
  // One question answered by many assistant messages: the tail reaches back
  // to the question, so there is nothing left to summarize before it.
  const replies = [];
  for (let i = 0; i < 40; i++) replies.push(assistant(`a${i}`));
  assert.equal(await reserve(f, [user("q"), ...replies]), null);
});

test("a failed summary clears the reservation so the next turn reserves again", async () => {
  const f = context("demo");
  const plan = await reserve(f, exchanges(0, 16));
  assert.equal(
    await finish(f, plan, {status: "failed", error: "model unavailable"}),
    false,
  );
  assert.equal((await openContext(f)).summary, undefined);
  assert.deepEqual(await reserve(f, exchanges(16, 1)), {
    baseThrough: 0,
    through: 39,
  });
});

test("a compaction reservation that never finished is replaced a threshold later", async () => {
  const f = context("demo");
  const users = (from, count) =>
    Array.from({length: count}, (_, i) => user(`m${from + i}`));
  const first = await reserve(f, users(0, 32));
  assert.deepEqual(first, {baseThrough: 0, through: 24});
  // The compact call is lost: no applyCompaction ever arrives.
  assert.equal(
    await reserve(f, users(32, 31)),
    null,
    "an in-flight reservation blocks another",
  );
  const replaced = await reserve(f, users(63, 1));
  assert.deepEqual(replaced, {baseThrough: 0, through: 56});
  const stale = await finish(f, first, {status: "completed", summary: "late"});
  assert.equal(stale, false, "a late result for the replaced plan is ignored");
  const applied = await finish(f, replaced, {
    status: "completed",
    summary: "fresh",
  });
  assert.equal(applied, true);
  const after = await openContext(f);
  assert.equal(after.summary, "fresh");
  assert.equal(after.entries.length, 8);
});
