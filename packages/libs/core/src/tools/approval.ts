// Lets the model ask a human to approve an action. The request stays pending
// across later steps; the decision arrives as a runtime update.

import {AgentDefinition} from "@restate-agents/types/services";
import * as restate from "@restatedev/restate-sdk-gen";
import {z} from "zod";

import {awaitApproval, HUMAN_APPROVAL_TOOL} from "../session/approvals.js";
import {defineAgentTool, failed} from "../tools-api.js";

export const humanApprovalTool = defineAgentTool({
  name: HUMAN_APPROVAL_TOOL,
  description:
    "Request human approval for a proposed action. The request remains pending across later agent steps. Call it by itself and do not perform dependent actions until a runtime update reports approval.",
  instructions:
    "For direct calls, call humanApproval by itself and do not perform dependent actions while its result is pending.",
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
      .client(AgentDefinition, context.agentId)
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
