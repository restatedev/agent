import assert from "node:assert/strict";
import {test} from "node:test";
import * as durable from "@restatedev/restate-sdk-gen";
import * as history from "../src/session/history.ts";
import {context} from "./state-fixture.mjs";

const user = (text) => ({role: "user", text, delivery: "turn"});
const event = {role: "event", type: "progress", turnId: "t", phase: "thinking", message: "Thinking..."};

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
  assert.deepEqual(page.entries.map((e) => e.sequence), [30, 31, 32, 33, 34]);
  assert.equal(page.nextSequence, 35);
  const tail = await run(f, function* () {
    return yield* history.page(40, 100);
  });
  assert.deepEqual(tail.entries.map((e) => e.entry.text ?? e.entry.type), ["m40", "m41", "progress"]);
  assert.equal(tail.nextSequence, 43);
  assert.equal(f.sends.filter((s) => s.method === "publish").length, 41);
});

test("a compaction reservation that never finished is replaced a threshold later", async () => {
  const f = context("demo");
  const reserve = (count) =>
    run(f, function* () {
      const turn = yield* history.openTurn();
      for (let i = 0; i < count; i++) yield* turn.append(user(`m${i}`));
      return (yield* turn.beginCompaction()) ?? null;
    });
  const first = await reserve(32);
  assert.deepEqual(first, {baseThrough: 0, through: 32});
  // The compact call is lost: no applyCompaction ever arrives.
  assert.equal(await reserve(10), null, "an in-flight reservation blocks another");
  const replaced = await reserve(22);
  assert.deepEqual(replaced, {baseThrough: 0, through: 64});
  const stale = await run(f, function* () {
    return yield* history.finishCompaction({...first, status: "completed", summary: "late"});
  });
  assert.equal(stale, false, "a late result for the replaced plan is ignored");
  const applied = await run(f, function* () {
    return yield* history.finishCompaction({...replaced, status: "completed", summary: "fresh"});
  });
  assert.equal(applied, true);
  const context_ = await run(f, function* () {
    return (yield* history.openTurn()).context();
  });
  assert.equal(context_.summary, "fresh");
  assert.equal(context_.entries.length, 0);
});
