// Lets the model hand out a URL and wait for something outside the agent to
// call it: a long job in another system, a remote coding agent, a webhook.
// It is humanApproval made generic. Whoever holds the URL completes the
// operation, and whatever they POST becomes its result.
//
// The URL is a Restate awakeable. `run` creates one in the turn and returns
// its ingress URLs; Restate itself accepts the POST and completes the
// awakeable, so no handler of ours sits on the callback path:
//
//   POST {CALLBACK_BASE_URL}/restate/awakeables/{callbackId}/resolve  body = result
//   POST {CALLBACK_BASE_URL}/restate/awakeables/{callbackId}/reject   body = reason
//
// `complete` races the awakeable against a durable timeout. A callback that
// arrives after the timeout, after cancelOperation or after the turn ended
// finds nobody waiting and is dropped.

import * as restate from "@restatedev/restate-sdk-gen";
import {z} from "zod";

import {errorMessage, isCancellation} from "../errors.js";
import {raceBranches} from "../tasks.js";
import {defineAgentTool, failed, succeeded} from "../tools-api.js";

/**
 * Restate's ingress as the caller reaches it. The default suits a local
 * Restate; a remote job needs a URL it can reach.
 */
const CALLBACK_BASE_URL = (
  process.env.CALLBACK_BASE_URL?.trim() || "http://localhost:8080"
).replace(/\/+$/, "");

/** One day: a callback holds its turn open until it arrives or times out. */
const MAX_TIMEOUT_SECONDS = 86_400;

export const createCallbackTool = defineAgentTool({
  name: "createCallback",
  description:
    "Create a callback URL and wait for it to be called. Hand the URL to another agent, a remote job or a tool, which POSTs its result to it when done. The callback remains pending across later agent steps until the URL is called, or the timeout passes.",
  summary: "Waited for a callback",
  instructions:
    "Use createCallback when work happens outside this agent and can report back over HTTP. Create the callback with a direct call before starting the work, then pass its resolveUrl to the worker with an instruction such as: when done, POST your result to <resolveUrl> (and on failure, POST the reason to <rejectUrl>). Do not poll; a runtime update delivers the body that was posted, or reports the timeout.",
  inputSchema: z.object({
    purpose: z
      .string()
      .min(1)
      .describe("What the callback is waiting for, e.g. 'remote build done'."),
    timeoutSeconds: z
      .number()
      .int()
      .min(1)
      .max(MAX_TIMEOUT_SECONDS)
      .describe(
        `How long to wait for the callback, from 1 to ${MAX_TIMEOUT_SECONDS} seconds (e.g. 3600 for one hour).`,
      ),
  }),
  *run({purpose, timeoutSeconds}, context) {
    // `complete` receives only the input and the call ID, not values from
    // `run`, so the awakeable's future is left for it in the turn's context.
    // That is replay-safe: both phases run in the same doTurn invocation, and
    // replaying it runs `run` (recreating the same awakeable) before
    // `complete` asks for it.
    const {id, promise} = restate.awakeable(restate.serde.binary);
    context.callbacks.set(context.toolCallId, promise);
    const awakeableUrl = `${CALLBACK_BASE_URL}/restate/awakeables/${id}`;
    return {
      status: "pending",
      result: {
        operationId: context.toolCallId,
        status: "waiting",
        purpose,
        callbackId: id,
        resolveUrl: `${awakeableUrl}/resolve`,
        rejectUrl: `${awakeableUrl}/reject`,
        timeoutSeconds,
      },
    };
  },
  *complete({purpose, timeoutSeconds}, context) {
    const callback = context.callbacks.get(context.toolCallId);
    if (!callback) {
      return failed(`the callback for ${purpose} is no longer available`);
    }
    try {
      const selected = yield* raceBranches({
        callback,
        timeout: restate.sleep(
          timeoutSeconds * 1_000,
          `callback-timeout-${context.toolCallId}`,
        ),
      });
      if (selected.tag === "timeout") {
        return failed(
          `No callback for ${purpose} arrived within ${timeoutSeconds} seconds`,
        );
      }
      return succeeded(callbackBody(selected.value));
    } catch (error) {
      if (isCancellation(error)) {
        throw error;
      }
      // A POST to the reject URL rejects the awakeable with its body.
      return failed(
        `The callback for ${purpose} reported a failure: ${errorMessage(error)}`,
      );
    } finally {
      context.callbacks.delete(context.toolCallId);
    }
  },
});

/**
 * The posted body as the model sees it. Callers send arbitrary bytes, so the
 * awakeable is binary rather than JSON and the body is decoded as text.
 */
function callbackBody(body: Uint8Array): string {
  if (body.length === 0) {
    return "The callback was called with an empty body.";
  }
  return new TextDecoder().decode(body);
}
