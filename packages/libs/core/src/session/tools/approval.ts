// Human approval for the humanApproval tool and for guardrails. The Agent
// registers the request so the UI lists it; the turn waits for the decision
// the Agent delivers as a signal.

import type {ApprovalDecision} from "@restate-agents/types";
import * as restate from "@restatedev/restate-sdk-gen";

import {Agent} from "../../agent/index.js";
import {approvalSignalName} from "../../internal-types.js";
import type {TurnContext} from "../turn-context.js";

type ApprovalRequest = {
  approvalId: string;
  question: string;
  guardrailId?: string;
};

/**
 * Asks a human and waits for the decision, recording each lifecycle event in
 * the transcript. Returns undefined when the turn is no longer active. If the
 * wait is interrupted, the request is withdrawn so it no longer shows.
 */
export function* askHuman(
  {
    agentId,
    turnId,
    transcript,
  }: Pick<TurnContext, "agentId" | "turnId" | "transcript">,
  request: ApprovalRequest,
): restate.Operation<ApprovalDecision | undefined> {
  const approval = {...request, turnId};
  if (!(yield* restate.client(Agent, agentId).requestApproval(approval)))
    return undefined;
  yield* transcript.append({
    role: "event",
    type: "approval_request",
    ...approval,
  });
  if (request.guardrailId)
    yield* transcript.append({
      role: "event",
      type: "progress",
      turnId,
      phase: "waiting",
      message: `Guardrail ${request.guardrailId} requires human approval`,
    });
  let decision: ApprovalDecision;
  try {
    decision = yield* restate.signal<ApprovalDecision>(
      approvalSignalName(request.approvalId),
    );
  } catch (error) {
    yield* restate
      .sendClient(Agent, agentId)
      .cancelApproval({approvalId: request.approvalId, turnId});
    yield* transcript.append({
      role: "event",
      type: "approval_cancelled",
      approvalId: request.approvalId,
      turnId,
    });
    throw error;
  }
  yield* transcript.append({
    role: "event",
    type: "approval",
    ...approval,
    ...decision,
  });
  return decision;
}
