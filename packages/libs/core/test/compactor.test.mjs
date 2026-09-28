import assert from "node:assert/strict";
import {test} from "node:test";

import {TerminalError} from "@restatedev/restate-sdk";
import * as durable from "@restatedev/restate-sdk-gen";

import {compactConversation} from "../src/model/compactor.ts";
import {modelProvider} from "../src/model/provider.ts";
import {context} from "./state-fixture.mjs";

const plan = {baseThrough: 4, through: 9};

function compact(entries) {
  const f = context("demo");
  return f.invoke((ctx) =>
    durable.execute(
      ctx,
      compactConversation({...plan, previousSummary: "before", entries}),
    ),
  );
}

test("the compactor sees messages and lifecycle boundaries, not status events", async (t) => {
  const seen = [];
  t.mock.method(modelProvider, "summarizeConversation", async (input) => {
    seen.push(input);
    return "after";
  });
  const result = await compact([
    {role: "user", text: "q", delivery: "turn"},
    {
      role: "event",
      type: "progress",
      turnId: "t",
      phase: "thinking",
      message: "Thinking...",
    },
    {role: "assistant", text: "a", turnId: "t", status: "interrupted"},
  ]);

  assert.deepEqual(result, {...plan, status: "completed", summary: "after"});
  assert.deepEqual(seen, [
    {
      previousSummary: "before",
      conversation: [
        {role: "user", text: "q", delivery: "turn"},
        {role: "assistant", text: "a", turnId: "t", status: "interrupted"},
      ],
    },
  ]);
});

test("a compactor failure is reported with a non-empty error", async (t) => {
  // A run that exhausts its attempts fails terminally with the last error.
  t.mock.method(modelProvider, "summarizeConversation", async () => {
    throw new TerminalError("");
  });
  const result = await compact([]);
  assert.deepEqual(result, {
    ...plan,
    status: "failed",
    error: "conversation compaction failed",
  });
});
