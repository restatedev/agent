// Shared policy gate for model proposals and concrete tool calls emitted by PTC.
//
// Every guardrail the proposal still has to satisfy is checked by the
// guardrail model. A guardrail that requires approval asks a human and, once
// approved, is dropped from the remaining set; the loop then re-checks the
// rest until all allow, one denies, or a human rejects.

import type {Guardrail} from "@restate-agents/types";
import {AgentDefinition} from "@restate-agents/types/services";
import {client, type Operation} from "@restatedev/restate-sdk-gen";
import type {ModelMessage} from "ai";

import {
  callGuardrailModel,
  type GuardrailApproval,
  type ProposedAction,
} from "../model/index.js";
import type {AgentToolContext} from "../tools-api.js";
import {approvalCancelled, awaitApproval} from "./approvals.js";
import type {TurnHistory} from "./history.js";

export type GuardrailDecisions = {
  approvedActions: GuardrailApproval[];
  rejectedGuardrails: string[];
};

type GuardResult = GuardrailDecisions &
  (
    | {decision: "allow"}
    | {decision: "blocked"; guardrailId: string; reason: string}
  );

export function* guardAction({
  context,
  transcript,
  instructions,
  guardrailMessages,
  guardrails,
  approvedActions,
  rejectedGuardrails,
  approvalPrefix,
  proposed,
}: {
  context: AgentToolContext;
  transcript: TurnHistory;
  instructions?: string;
  guardrailMessages: ModelMessage[];
  guardrails: Guardrail[];
  approvedActions: GuardrailApproval[];
  rejectedGuardrails: string[];
  approvalPrefix: string;
  proposed: ProposedAction;
}): Operation<GuardResult> {
  const newlyApproved: GuardrailApproval[] = [];
  const allow = (): GuardResult => ({
    decision: "allow",
    approvedActions: newlyApproved,
    rejectedGuardrails: [],
  });
  const block = (
    guardrailId: string,
    reason: string,
    rejected: string[] = [],
  ): GuardResult => ({
    decision: "blocked",
    guardrailId,
    reason,
    approvedActions: newlyApproved,
    rejectedGuardrails: rejected,
  });

  let remaining = guardrails;
  for (let approvalNumber = 1; remaining.length > 0; approvalNumber++) {
    const decision = yield* callGuardrailModel({
      instructions,
      guardrails: remaining,
      approvedActions: [...approvedActions, ...newlyApproved],
      rejectedGuardrailIds: rejectedGuardrails,
      messages: guardrailMessages,
      action: proposed,
    });
    if (decision.decision === "allow") return allow();
    if (decision.decision === "deny")
      return block(decision.guardrailId, decision.reason);

    const request = {
      approvalId: `${approvalPrefix}-${approvalNumber}`,
      turnId: context.turnId,
      question: decision.question,
      guardrailId: decision.guardrailId,
    };
    if (
      !(yield* client(AgentDefinition, context.agentId).requestApproval(
        request,
      ))
    )
      return block(
        decision.guardrailId,
        "human approval could not be registered",
      );
    yield* transcript.append(
      {role: "event", type: "approval_request", ...request},
      {
        role: "event",
        type: "progress",
        turnId: context.turnId,
        phase: "waiting",
        message: `Guardrail ${decision.guardrailId} requires human approval`,
      },
    );
    let resolution;
    try {
      resolution = yield* awaitApproval(context, request.approvalId);
    } catch (error) {
      yield* transcript.append(
        approvalCancelled(request.approvalId, context.turnId),
      );
      throw error;
    }
    yield* transcript.append({
      role: "event",
      type: "approval",
      ...request,
      ...resolution,
    });
    if (resolution.decision === "rejected")
      return block(
        decision.guardrailId,
        resolution.reason
          ? `Human rejected the request: ${resolution.reason}`
          : "Human rejected the request",
        [decision.guardrailId],
      );

    newlyApproved.push({
      guardrailId: decision.guardrailId,
      question: decision.question,
      action: proposed,
    });
    remaining = remaining.filter(({id}) => id !== decision.guardrailId);
  }
  return allow();
}
