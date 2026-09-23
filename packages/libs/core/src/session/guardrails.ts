// Shared policy gate for model proposals and concrete tool calls emitted by PTC.
import type {ApprovalDecision, Guardrail} from "@restate-agents/types";
import {
  client,
  type Operation,
  sendClient,
  signal,
} from "@restatedev/restate-sdk-gen";
import type {ModelMessage} from "ai";

import {Agent} from "../agent/index.js";
import {approvalSignalName} from "../internal-types.js";
import {
  callGuardrailModel,
  type GuardrailApproval,
  type ProposedAction,
} from "../model/index.js";
import type {TurnHistory} from "./history.js";
import type {AgentToolContext} from "./tools.js";

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
  const approvedForAction = new Set<string>();
  const newlyApproved: GuardrailApproval[] = [];
  let approvalNumber = 1;
  let guarded:
    | ({decision: "allow"} & GuardrailDecisions)
    | ({
        decision: "blocked";
        guardrailId: string;
        reason: string;
      } & GuardrailDecisions);

  while (true) {
    const remaining = guardrails.filter(({id}) => !approvedForAction.has(id));
    if (remaining.length === 0) {
      guarded = {
        decision: "allow",
        approvedActions: newlyApproved,
        rejectedGuardrails: [],
      };
      break;
    }

    const decision = yield* callGuardrailModel({
      instructions,
      guardrails: remaining,
      approvedActions: [...approvedActions, ...newlyApproved],
      rejectedGuardrailIds: rejectedGuardrails,
      messages: guardrailMessages,
      action: proposed,
    });
    if (decision.decision === "allow") {
      guarded = {
        decision: "allow",
        approvedActions: newlyApproved,
        rejectedGuardrails: [],
      };
      break;
    }
    if (decision.decision === "deny") {
      guarded = {
        decision: "blocked",
        guardrailId: decision.guardrailId,
        reason: decision.reason,
        approvedActions: newlyApproved,
        rejectedGuardrails: [],
      };
      break;
    }

    const approvalId = `${approvalPrefix}-${approvalNumber}`;
    const request = {
      approvalId,
      turnId: context.turnId,
      question: decision.question,
      guardrailId: decision.guardrailId,
    };
    const registered = yield* client(Agent, context.agentId).requestApproval(
      request,
    );
    let resolution: ApprovalDecision | undefined;
    if (registered) {
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
      try {
        resolution = yield* signal<ApprovalDecision>(
          approvalSignalName(approvalId),
        );
        yield* transcript.append({
          role: "event",
          type: "approval",
          ...request,
          ...resolution,
        });
      } catch (error) {
        yield* sendClient(Agent, context.agentId).cancelApproval({
          approvalId,
          turnId: context.turnId,
        });
        yield* transcript.append({
          role: "event",
          type: "approval_cancelled",
          approvalId,
          turnId: context.turnId,
        });
        throw error;
      }
    }

    if (!resolution) {
      guarded = {
        decision: "blocked",
        guardrailId: decision.guardrailId,
        reason: "human approval could not be registered",
        approvedActions: newlyApproved,
        rejectedGuardrails: [],
      };
      break;
    }
    if (resolution.decision === "rejected") {
      guarded = {
        decision: "blocked",
        guardrailId: decision.guardrailId,
        reason: resolution.reason
          ? `Human rejected the request: ${resolution.reason}`
          : "Human rejected the request",
        approvedActions: newlyApproved,
        rejectedGuardrails: [decision.guardrailId],
      };
      break;
    }

    newlyApproved.push({
      guardrailId: decision.guardrailId,
      question: decision.question,
      action: proposed,
    });
    approvedForAction.add(decision.guardrailId);
    approvalNumber += 1;
  }
  return guarded;
}
