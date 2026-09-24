import assert from "node:assert/strict";
import {test} from "node:test";
import * as durable from "@restatedev/restate-sdk-gen";
import {createPendingOperations} from "../../src/session/pending.ts";
import {runHandler} from "./harness.mjs";

const call = (toolCallId) => ({toolCallId, toolName: "executeProgram", input: {}});
const pendingOutcome = (id) => ({call: call(id), status: "pending", result: {operationId: id, status: "running"}});

test("a handed-off program cancelling another operation does not fail the parked turn", {timeout: 8000}, async () => {
  const result = await runHandler((ctx) =>
    durable.execute(
      ctx,
      durable.gen(function* () {
        const pending = createPendingOperations();
        const never = durable.channel();
        const go = durable.channel();
        // `a` runs until interrupted; `b` cancels it once both are registered.
        const a = durable.spawn(durable.gen(function* () {
          yield* never.receive;
        }));
        const b = durable.spawn(durable.gen(function* () {
          yield* go.receive;
          const applied = yield* pending.apply(
            [{call: call("cancel"), status: "cancel_requested", operationId: "a", reason: "not needed"}],
            {},
            2,
          );
          return {call: call("b"), status: "succeeded", result: applied.outcomes[0].result};
        }));
        yield* pending.apply([pendingOutcome("a"), pendingOutcome("b")], {}, 1, new Map([["a", a], ["b", b]]));
        durable.spawn(durable.gen(function* () {
          yield* go.send();
        }));
        const next = yield* pending.next(never.receive, never.receive);
        return {next, left: pending.size};
      }),
    ),
  );
  assert.equal(result.output.next.type, "completion");
  assert.equal(result.output.next.event.call.toolCallId, "b");
  assert.match(result.output.next.event.outcome.result, /Cancelled pending executeProgram operation a/);
  assert.equal(result.output.left, 0);
});
