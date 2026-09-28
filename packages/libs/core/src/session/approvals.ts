// Waiting for a human decision. Guardrail gates, the humanApproval tool and
// PTC's nested approvals all use this flow: the Agent registers the request
// and the turn waits for the decision signal.

import type {ApprovalDecision, ConversationEntry} from "@restate-agents/types";
import {AgentDefinition} from "@restate-agents/types/services";
import * as restate from "@restatedev/restate-sdk-gen";

import {approvalSignalName} from "../internal-types.js";
import type {AgentToolContext} from "../tool-api/index.js";

/**
 * The tool that asks a human for approval. Its pending calls are approval
 * requests, so the runtime records their cancellation like a guardrail's.
 */
export const HUMAN_APPROVAL_TOOL = "humanApproval";

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
    yield* withdrawApproval(context, approvalId);
    throw error;
  }
}

/** Removes a request nobody is waiting for any more. One-way and idempotent. */
export function* withdrawApproval(
  context: Pick<AgentToolContext, "agentId" | "turnId">,
  approvalId: string,
): restate.Operation<void> {
  yield* restate
    .sendClient(AgentDefinition, context.agentId)
    .cancelApproval({approvalId, turnId: context.turnId});
}

export function approvalCancelled(
  approvalId: string,
  turnId: string,
): ConversationEntry {
  return {role: "event", type: "approval_cancelled", approvalId, turnId};
}
