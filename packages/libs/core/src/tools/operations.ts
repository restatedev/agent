// Operations that outlive the model step that started them: a durable timer,
// and cancelling any pending operation (a timer or an approval request).

import * as restate from "@restatedev/restate-sdk-gen";
import {z} from "zod";

import {defineAgentTool, succeeded} from "../tools-api.js";

export const sleepTool = defineAgentTool({
  name: "sleep",
  description:
    "Start a durable timer. The timer remains active across later agent steps, and the turn cannot finish until it completes.",
  inputSchema: z.object({
    durationSeconds: z
      .number()
      .int()
      .min(1)
      .max(300)
      .describe("How long to sleep, from 1 to 300 seconds."),
  }),
  *run({durationSeconds}, context) {
    return {
      status: "pending",
      result: {
        operationId: context.toolCallId,
        status: "running",
        durationSeconds,
      },
    };
  },
  *complete({durationSeconds}, context) {
    yield* restate.sleep(
      durationSeconds * 1_000,
      `sleep-${context.toolCallId}`,
    );
    return succeeded(`Slept for ${durationSeconds} seconds`);
  },
});

export const cancelOperationTool = defineAgentTool({
  name: "cancelOperation",
  description:
    "Cancel one pending operation, such as a running sleep or human approval request, using the operationId from its pending result. This does not cancel completed or foreground tools.",
  instructions:
    "When the user asks to stop pending work, call cancelOperation with its operationId and wait for the cancellation result before claiming it stopped.",
  inputSchema: z.object({
    operationId: z
      .string()
      .min(1)
      .describe("The operationId returned by a pending tool."),
    reason: z
      .string()
      .min(1)
      .nullable()
      .describe(
        "Why the pending operation should be cancelled, or null when no reason was given.",
      ),
  }),
  *run({operationId, reason}) {
    return {
      status: "cancel_requested",
      operationId,
      reason: reason ?? "Cancelled by the agent",
    };
  },
});
