// One bounded agent step and its Turn-side task supervisor. The step sees an
// immutable message snapshot, calls the agent model once, gates its proposed
// action, and runs an allowed foreground tool batch in parallel. It owns no
// state that survives its return.

import type {ApprovalDecision, Guardrail} from "@restate-agents/types";
import {
  all,
  allSettled,
  client,
  type Future,
  InterruptedError,
  type Operation,
  sendClient,
  signal,
  spawn,
  type Task,
} from "@restatedev/restate-sdk-gen";
import type {ModelMessage} from "ai";
import {Agent} from "../agent/index.js";
import type {
  GuardrailApproval,
  ModelResult,
  ProposedAction,
} from "../gateway/index.js";
import {callGuardrailModel, callModel} from "../gateway/index.js";
import {approvalSignalName} from "../internal-types.js";
import {raceBranches} from "../race.js";
import type {DiscoveredAgentTool} from "./dynamic-tools.js";
import type {TurnHistory} from "./history.js";
import type {AgentToolContext, ToolOutcome} from "./tools.js";
import * as agentTools from "./tools.js";

type ToolCallAction = Extract<ModelResult, {type: "tool_calls"}>;

/** Guardrail decisions that the Turn must retain across model steps. */
export type GuardrailDecisions = {
  approvedActions: GuardrailApproval[];
  rejectedGuardrails: string[];
};

/** A model tool-call action paired with its foreground execution outcomes. */
export type ToolStep = GuardrailDecisions & {
  type: "tools";
  step: number;
  action: ToolCallAction;
  outcomes: ToolOutcome[];
};

type AgentStepResult =
  | (GuardrailDecisions & Extract<ModelResult, {type: "text" | "error"}>)
  | ToolStep
  | (GuardrailDecisions & {
      type: "guardrail_blocked";
      guardrailId: string;
      reason: string;
    })
  | (GuardrailDecisions & {type: "tool_budget_exceeded"})
  | {type: "interrupted"; reason: string; tools?: ToolStep};

/**
 * Runs one bounded model step, guardrail decision, and foreground tool batch.
 *
 * The caller owns all durable Turn state and decides whether to commit the
 * returned proposal after accounting for concurrent steering or interruption.
 */
export function* agentStep({
  context,
  transcript,
  instructions,
  messages,
  guardrailMessages,
  guardrails,
  approvedActions,
  rejectedGuardrails,
  stepNumber,
  remainingToolCalls,
  discoveredTools,
}: {
  context: AgentToolContext;
  transcript: TurnHistory;
  instructions?: string;
  messages: ModelMessage[];
  guardrailMessages: ModelMessage[];
  guardrails: Guardrail[];
  approvedActions: GuardrailApproval[];
  rejectedGuardrails: string[];
  stepNumber: number;
  remainingToolCalls: number;
  discoveredTools: DiscoveredAgentTool[];
}): Operation<AgentStepResult> {
  let activeTools:
    | {
        action: ToolCallAction;
        tasks: Task<ToolOutcome>[];
        decisions: GuardrailDecisions;
      }
    | undefined;

  try {
    const action = yield* callModel({
      agentId: context.agentId,
      instructions,
      messages,
      tools: agentTools.manifests(discoveredTools),
    });
    if (action.type === "error") {
      return {...action, approvedActions: [], rejectedGuardrails: []};
    }
    if (
      action.type === "tool_calls" &&
      action.calls.length > remainingToolCalls
    ) {
      return {
        type: "tool_budget_exceeded",
        approvedActions: [],
        rejectedGuardrails: [],
      };
    }

    const proposed: ProposedAction =
      action.type === "text"
        ? action
        : {
            type: action.type,
            calls: action.calls,
            ...(action.activity ? {activity: action.activity} : {}),
          };
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
        agentId: context.agentId,
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

      const approvalId = `guardrail-${stepNumber}-${approvalNumber}`;
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
    const decisions = {
      approvedActions: guarded.approvedActions,
      rejectedGuardrails: guarded.rejectedGuardrails,
    };
    if (guarded.decision === "blocked") {
      return {
        type: "guardrail_blocked",
        guardrailId: guarded.guardrailId,
        reason: guarded.reason,
        ...decisions,
      };
    }
    if (action.type === "text") {
      return {...action, ...decisions};
    }

    const tasks: Task<ToolOutcome>[] = [];
    activeTools = {action, tasks, decisions};
    yield* transcript.append(
      ...(action.activity
        ? [
            {
              role: "event" as const,
              type: "activity" as const,
              turnId: context.turnId,
              step: stepNumber,
              message: action.activity,
            },
          ]
        : []),
      {
        role: "event",
        type: "tools",
        turnId: context.turnId,
        step: stepNumber,
        phase: "started",
        calls: action.calls.map((call) => {
          const summary = agentTools.summarize(call);
          return {
            id: call.toolCallId,
            name: call.toolName,
            ...(summary ? {summary} : {}),
          };
        }),
      },
    );
    tasks.push(
      ...action.calls.map((call) =>
        spawn(agentTools.execute(call, context, discoveredTools)),
      ),
    );
    return {
      type: "tools",
      step: stepNumber,
      action,
      outcomes: yield* all(tasks),
      ...decisions,
    };
  } catch (error) {
    if (!activeTools) {
      if (!(error instanceof AgentStepInterrupt)) {
        throw error;
      }
      return {type: "interrupted", reason: error.message};
    }

    const {action, tasks, decisions} = activeTools;
    for (const task of tasks) {
      task.interrupt(error);
    }
    const settled = yield* allSettled(tasks);
    if (!(error instanceof AgentStepInterrupt)) {
      throw error;
    }
    return {
      type: "interrupted",
      reason: error.message,
      tools: {
        type: "tools",
        step: stepNumber,
        action,
        ...decisions,
        outcomes: action.calls.map((call, index): ToolOutcome => {
          const result = settled[index];
          return result?.status === "fulfilled"
            ? result.value
            : {
                call,
                status: "failed",
                error: `interrupted before completion: ${error.message}`,
              };
        }),
      },
    };
  }
}

/**
 * Settles an already-spawned step or interrupts and joins it, preserving any
 * foreground tool results produced before the interruption boundary.
 */
export function* settleStep(
  task: Task<AgentStepResult>,
  interrupt: Future<string>,
): Operation<AgentStepResult> {
  try {
    const selected = yield* raceBranches({interrupt, task});
    if (selected.tag === "task") {
      return selected.value;
    }

    const reason = selected.value;
    task.interrupt(new AgentStepInterrupt(reason));
    const [settled] = yield* allSettled([task]);
    const completed =
      settled.status === "fulfilled" ? settled.value : undefined;
    const tools =
      completed?.type === "tools"
        ? completed
        : completed?.type === "interrupted"
          ? completed.tools
          : undefined;
    return {type: "interrupted", reason, tools};
  } catch (error) {
    task.interrupt(error);
    yield* allSettled([task]);
    throw error;
  }
}

class AgentStepInterrupt extends InterruptedError {}
