// One bounded agent step and its Turn-side task supervisor. The step sees an
// immutable message snapshot, calls the agent model once, gates its proposed
// action, and runs an allowed foreground tool batch in parallel. It owns no
// state that survives its return.

import type {Guardrail} from "@restate-agents/types";
import {
  all,
  allSettled,
  type Future,
  InterruptedError,
  type Operation,
  spawn,
  type Task,
} from "@restatedev/restate-sdk-gen";
import type {ModelMessage} from "ai";

import type {
  GuardrailApproval,
  ModelResult,
  ProposedAction,
} from "../gateway/index.js";
import {callModel} from "../gateway/index.js";
import {PROGRAM_TOOL_NAME} from "../ptc/definition.js";
import {raceBranches} from "../race.js";
import type {DiscoveredAgentTool} from "./dynamic-tools.js";
import {type GuardrailDecisions, guardAction} from "./guardrails.js";
import type {TurnHistory} from "./history.js";
import type {McpAgentTool} from "./mcp-tools.js";
import type {createPendingOperations} from "./pending.js";
import type {AgentToolContext, PendingEvent, ToolOutcome} from "./tools.js";
import * as agentTools from "./tools.js";

type ToolCallAction = Extract<ModelResult, {type: "tool_calls"}>;

export type {GuardrailDecisions} from "./guardrails.js";

/** A model tool-call action paired with its foreground execution outcomes. */
export type ToolStep = GuardrailDecisions & {
  type: "tools";
  step: number;
  action: ToolCallAction;
  outcomes: ToolOutcome[];
  pendingEvents: PendingEvent[];
};

type AgentStepResult =
  | (GuardrailDecisions & Extract<ModelResult, {type: "text" | "error"}>)
  | ToolStep
  | (GuardrailDecisions & {
      type: "guardrail_blocked";
      guardrailId: string;
      reason: string;
    })
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
  discoveredTools,
  mcpTools,
  pending,
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
  discoveredTools: DiscoveredAgentTool[];
  mcpTools: McpAgentTool[];
  pending: ReturnType<typeof createPendingOperations>;
}): Operation<AgentStepResult> {
  let activeTools:
    | {
        action: ToolCallAction;
        tasks: Task<ToolOutcome>[];
        decisions: GuardrailDecisions;
      }
    | undefined;
  const pendingEvents: PendingEvent[] = [];

  try {
    const action = yield* callModel({
      agentId: context.agentId,
      instructions,
      messages,
      tools: agentTools.modelManifests(discoveredTools, mcpTools, context),
    });
    if (action.type === "error") {
      return {...action, approvedActions: [], rejectedGuardrails: []};
    }

    const proposed: ProposedAction =
      action.type === "text"
        ? action
        : {
            type: action.type,
            calls: action.calls.filter(
              (call) => call.toolName !== PROGRAM_TOOL_NAME,
            ),
            ...(action.activity ? {activity: action.activity} : {}),
          };
    // PTC is only orchestration. Gate concrete subtool inputs when emitted,
    // not the JavaScript source or the wrapper's mere use.
    const guarded =
      proposed.type === "tool_calls" && proposed.calls.length === 0
        ? {
            decision: "allow" as const,
            approvedActions: [],
            rejectedGuardrails: [],
          }
        : yield* guardAction({
            context,
            transcript,
            instructions,
            guardrailMessages,
            guardrails,
            approvedActions,
            rejectedGuardrails,
            approvalPrefix: `guardrail-${stepNumber}`,
            proposed,
          });
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
        spawn(
          agentTools.execute(call, context, discoveredTools, mcpTools, {
            transcript,
            step: stepNumber,
            *guard(nested) {
              const guarded = yield* guardAction({
                context,
                transcript,
                instructions,
                guardrailMessages,
                guardrails,
                approvedActions: [
                  ...approvedActions,
                  ...decisions.approvedActions,
                ],
                rejectedGuardrails: [
                  ...rejectedGuardrails,
                  ...decisions.rejectedGuardrails,
                ],
                approvalPrefix: `guardrail-${stepNumber}-${nested.toolCallId}`,
                proposed: {type: "tool_calls", calls: [nested]},
              });
              decisions.approvedActions.push(...guarded.approvedActions);
              decisions.rejectedGuardrails.push(...guarded.rejectedGuardrails);
              return guarded.decision === "blocked"
                ? guarded.reason
                : undefined;
            },
            *cancelPending(outcome) {
              const applied = yield* pending.apply(
                [outcome],
                context,
                stepNumber,
              );
              pendingEvents.push(...applied.events);
              return applied.outcomes[0];
            },
          }),
        ),
      ),
    );
    return {
      type: "tools",
      step: stepNumber,
      action,
      outcomes: yield* all(tasks),
      pendingEvents,
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
        pendingEvents,
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
