// Human approval shared by the humanApproval tool and guardrail gates. The
// Agent registers the request; the turn waits for the decision signal.

import type {ApprovalDecision} from "@restate-agents/types";
import * as restate from "@restatedev/restate-sdk-gen";
import {z} from "zod";

import {Agent} from "../../agent/index.js";
import {approvalSignalName} from "../../internal-types.js";
import {type AgentToolContext, defineAgentTool, failed} from "./define.js";

/**
 * Waits for the decision on a registered approval. If the wait is
 * interrupted, the request is withdrawn so it no longer shows as pending.
 */
export function* awaitApproval(
  context: Pick<AgentToolContext, "agentId" | "turnId">,
  approvalId: string,
): restate.Operation<ApprovalDecision> {
  try {
    return yield* restate.signal<ApprovalDecision>(
      approvalSignalName(approvalId),
    );
  } catch (error) {
    yield* restate
      .sendClient(Agent, context.agentId)
      .cancelApproval({approvalId, turnId: context.turnId});
    throw error;
  }
}

export const humanApprovalTool = defineAgentTool({
  name: "humanApproval",
  description:
    "Request human approval for a proposed action. The request remains pending across later agent steps. Call it by itself and do not perform dependent actions until a runtime update reports approval.",
  inputSchema: z.object({
    question: z
      .string()
      .min(1)
      .describe("The specific action or decision the human should approve."),
  }),
  *run({question}, context) {
    const request = {
      approvalId: context.toolCallId,
      turnId: context.turnId,
      question,
    };
    const registered = yield* restate
      .client(Agent, context.agentId)
      .requestApproval(request);
    if (!registered)
      return failed(
        "human approval could not be registered because the turn is no longer active",
      );
    return {
      status: "pending",
      result: {
        operationId: context.toolCallId,
        approvalId: context.toolCallId,
        status: "pending",
        question,
      },
      transcript: [{role: "event", type: "approval_request", ...request}],
    };
  },
  *complete({question}, context) {
    const decision = yield* awaitApproval(context, context.toolCallId);
    const reason = decision.reason ? ` Reason: ${decision.reason}` : "";
    return {
      status: "succeeded",
      result:
        decision.decision === "approved"
          ? `Human approved the request.${reason}`
          : `Human rejected the request.${reason}`,
      transcript: [
        {
          role: "event",
          type: "approval",
          approvalId: context.toolCallId,
          turnId: context.turnId,
          question,
          ...decision,
        },
      ],
    };
  },
});
