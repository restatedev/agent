import assert from "node:assert/strict";
import {test} from "node:test";

import * as durable from "@restatedev/restate-sdk-gen";

import {buildModelContext} from "../src/session/context.ts";
import * as agentTools from "../src/session/tools.ts";
import {context} from "./state-fixture.mjs";

const permissions = {
  builtin: {mode: "all"},
  dynamic: {mode: "selected", names: []},
  mcp: [],
};

const scope = {
  transcript: {*append() {}},
  step: 1,
  *guard() {},
  *cancelPending() {
    throw new Error("unused");
  },
};

// Runs one memory tool call in a turn whose Agent answers with `reply`.
async function runTool(toolName, input, reply) {
  const f = context("agent", {}, reply);
  const toolContext = agentTools.createAgentToolContext(
    "agent",
    "turn",
    false,
    permissions,
  );
  const outcome = await f.invoke((ctx) =>
    durable.execute(
      ctx,
      agentTools.execute(
        {toolName, toolCallId: "call", input},
        toolContext,
        [],
        [],
        scope,
      ),
    ),
  );
  return {outcome, calls: f.calls};
}

test("manageMemory sends wire changes for the turn and records the applied IDs", async () => {
  const {outcome, calls} = await runTool(
    "manageMemory",
    {
      changes: [
        {
          operation: "create",
          id: null,
          description: "units",
          content: "Celsius",
        },
        {operation: "delete", id: "mem3", description: null, content: null},
      ],
    },
    () => ({applied: true, ids: ["mem4", "mem3"]}),
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "updateMemory");
  assert.deepEqual(calls[0].parameter, {
    turnId: "turn",
    changes: [
      {operation: "create", description: "units", content: "Celsius"},
      {operation: "delete", id: "mem3"},
    ],
  });
  assert.equal(outcome.status, "succeeded");
  const applied = [
    {operation: "create", id: "mem4"},
    {operation: "delete", id: "mem3"},
  ];
  assert.deepEqual(JSON.parse(outcome.result), {applied});
  assert.deepEqual(outcome.transcript, [
    {role: "event", type: "memory", turnId: "turn", changes: applied},
  ]);
});

test("manageMemory rejects a change without the fields its operation needs", async () => {
  const cases = [
    [{operation: "delete", id: null, description: null, content: null}, /id/],
    [
      {operation: "create", id: null, description: "units", content: null},
      /description and content/,
    ],
    [{operation: "update", id: null, description: "units", content: "C"}, /id/],
  ];
  for (const [change, error] of cases) {
    const {outcome, calls} = await runTool(
      "manageMemory",
      {changes: [change]},
      () => {
        throw new Error("no Agent call expected");
      },
    );
    assert.equal(outcome.status, "failed");
    assert.match(outcome.error, error);
    assert.equal(calls.length, 0);
  }
});

test("readMemories returns the found memories and names the missing IDs", async () => {
  const {outcome, calls} = await runTool(
    "readMemories",
    {ids: ["mem0", "mem9"]},
    () => [{id: "mem0", description: "units", content: "Celsius"}],
  );
  assert.equal(calls[0].method, "readMemories");
  assert.deepEqual(calls[0].parameter, {ids: ["mem0", "mem9"]});
  assert.deepEqual(JSON.parse(outcome.result), {
    memories: [{id: "mem0", description: "units", content: "Celsius"}],
    missing: ["mem9"],
  });
});

test("model context carries the whole memory index but no memory content", () => {
  const {messages} = buildModelContext([], undefined, [
    {id: "mem0", description: "units"},
    {id: "mem2", description: "editor preference"},
  ]);
  const index = messages[0].content;
  assert.match(index, /^\[Agent memory index/);
  assert.match(index, /readMemories/);
  assert.match(index, /mem0: "units"/);
  assert.match(index, /mem2: "editor preference"/);

  const empty = buildModelContext([], undefined, []);
  assert.equal(empty.messages.length, 0);
});
