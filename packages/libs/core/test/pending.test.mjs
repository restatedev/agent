import assert from "node:assert/strict";
import {test} from "node:test";

import * as durable from "@restatedev/restate-sdk-gen";

import {createPendingOperations} from "../src/session/pending.ts";
import {runHandler} from "./harness.mjs";

function programCall(toolCallId) {
  return {toolCallId, toolName: "executeProgram", input: {}};
}

// The immediate result of a program handed off while still running.
function runningOutcome(toolCallId) {
  return {
    call: programCall(toolCallId),
    status: "pending",
    result: {operationId: toolCallId, status: "running"},
  };
}

function cancelRequest(operationId) {
  return {
    call: programCall("cancel"),
    status: "cancel_requested",
    operationId,
    reason: "not needed",
  };
}

test(
  "a handed-off program cancelling another operation does not fail the parked turn",
  {
    timeout: 8000,
  },
  async () => {
    const result = await runHandler((ctx) =>
      durable.execute(
        ctx,
        durable.gen(function* () {
          const pending = createPendingOperations();
          const never = durable.channel();
          const bothRegistered = durable.channel();

          // Program `a` runs until something interrupts it.
          const a = durable.spawn(
            durable.gen(function* () {
              yield* never.receive;
            }),
          );
          // Program `b` cancels `a` once both are registered, then finishes.
          const b = durable.spawn(
            durable.gen(function* () {
              yield* bothRegistered.receive;
              const applied = yield* pending.apply([cancelRequest("a")], {}, 2);
              return {
                call: programCall("b"),
                status: "succeeded",
                result: applied.outcomes[0].result,
              };
            }),
          );

          const handoffs = new Map([
            ["a", a],
            ["b", b],
          ]);
          yield* pending.apply(
            [runningOutcome("a"), runningOutcome("b")],
            {},
            1,
            handoffs,
          );
          durable.spawn(
            durable.gen(function* () {
              yield* bothRegistered.send();
            }),
          );

          // The turn parks here while `b` cancels `a`.
          const next = yield* pending.next(never.receive, never.receive);
          return {next, remaining: pending.size};
        }),
      ),
    );

    const {next, remaining} = result.output;
    assert.equal(next.type, "completion");
    assert.equal(next.event.call.toolCallId, "b");
    assert.match(
      next.event.outcome.result,
      /Cancelled pending executeProgram operation a/,
    );
    assert.equal(remaining, 0);
  },
);
