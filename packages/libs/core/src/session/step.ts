// One bounded agent step and its Turn-side task supervisor. The step sees an
// immutable message snapshot, calls the agent model once, gates its proposed
// action, and runs an allowed foreground tool batch in parallel. It owns no
// state that survives its return: a program still running when steering
// arrives is handed to the turn's pending operations instead.

import type {Guardrail} from "@restate-agents/types";
import {
  all,
  type Future,
  type FutureSettledResult,
  gen,
  InterruptedError,
  type Operation,
  select,
  spawn,
  type Task,
} from "@restatedev/restate-sdk-gen";

import {
  callModel,
  type GuardrailApproval,
  type ModelMessage,
  type ModelResult,
  type ProposedAction,
  type ToolCall,
} from "../model/index.js";
import {PROGRAM_TOOL_NAME} from "../ptc/definition.js";
import {interruptAndJoin, raceBranches} from "../tasks.js";
import type {DiscoveredAgentTool} from "./dynamic-tools.js";
import {type GuardrailDecisions, guardAction} from "./guardrails.js";
import type {TurnHistory} from "./history.js";
import type {McpAgentTool} from "./mcp-tools.js";
import type {createPendingOperations} from "./pending.js";
import {executeProgramTool, type ToolExecutionScope} from "./program-tool.js";
import type {AgentToolContext, PendingEvent, ToolOutcome} from "./tools.js";
import * as agentTools from "./tools.js";

type ToolCallAction = Extract<ModelResult, {type: "tool_calls"}>;

/** A model tool-call action paired with its foreground execution outcomes. */
export type ToolStep = GuardrailDecisions & {
  type: "tools";
  step: number;
  action: ToolCallAction;
  outcomes: ToolOutcome[];
  pendingEvents: PendingEvent[];
  /** Programs still running, keyed by call ID; their outcomes are pending. */
  handoffs: Map<string, Task<ToolOutcome>>;
};

export type AgentStepResult =
  | (GuardrailDecisions & Extract<ModelResult, {type: "text" | "error"}>)
  | ToolStep
  | (GuardrailDecisions & {
      type: "guardrail_blocked";
      guardrailId: string;
      reason: string;
      inputTokens?: number;
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
  steering,
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
  /** Resolves when steering is waiting to be read by the model. */
  steering: Future<void>;
}): Operation<AgentStepResult> {
  let activeTools:
    | {
        action: ToolCallAction;
        tasks: Task<ToolOutcome>[];
        decisions: GuardrailDecisions;
      }
    | undefined;
  const pendingEvents: PendingEvent[] = [];
  // Set once the step has returned with programs still running. Later
  // cancellations from those programs are recorded directly, because the turn
  // has already consumed `pendingEvents`.
  let handedOff = false;
  // Gates a proposal against the guardrails, given approvals and rejections
  // already made in this turn.
  const gate = (
    proposed: ProposedAction,
    approvalPrefix: string,
    decided: GuardrailDecisions,
  ) =>
    guardAction({
      context,
      transcript,
      instructions,
      guardrailMessages,
      guardrails,
      approvedActions: [...approvedActions, ...decided.approvedActions],
      rejectedGuardrails: [
        ...rejectedGuardrails,
        ...decided.rejectedGuardrails,
      ],
      approvalPrefix,
      proposed,
    });

  try {
    const action = yield* callModel({
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
        : yield* gate(proposed, `guardrail-${stepNumber}`, {
            approvedActions: [],
            rejectedGuardrails: [],
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
        inputTokens: action.inputTokens,
        ...decisions,
      };
    }
    if (action.type === "text") {
      return {...action, ...decisions};
    }

    const tasks: Task<ToolOutcome>[] = [];
    const settled: (ToolOutcome | undefined)[] = [];
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
      agentTools.toolsEvent(
        context.turnId,
        stepNumber,
        "started",
        action.calls.map((call) => agentTools.toolActivity(call)),
      ),
    );
    // PTC's nested calls are gated one by one, and their approvals extend
    // this step's decisions.
    const scope: ToolExecutionScope = {
      transcript,
      step: stepNumber,
      *guard(nested) {
        const guarded = yield* gate(
          {type: "tool_calls", calls: [nested]},
          `guardrail-${stepNumber}-${nested.toolCallId}`,
          decisions,
        );
        decisions.approvedActions.push(...guarded.approvedActions);
        decisions.rejectedGuardrails.push(...guarded.rejectedGuardrails);
        return guarded.decision === "blocked" ? guarded.reason : undefined;
      },
      *cancelPending(outcome) {
        const applied = yield* pending.apply([outcome], context, stepNumber);
        if (handedOff)
          yield* transcript.append(
            ...applied.events.flatMap((event) =>
              agentTools.transcriptEntries(event, context),
            ),
          );
        else pendingEvents.push(...applied.events);
        return applied.outcomes[0];
      },
    };
    tasks.push(
      ...action.calls.map((call, index) =>
        spawn(
          gen(function* () {
            const outcome = yield* executeCall(
              call,
              context,
              discoveredTools,
              mcpTools,
              scope,
            );
            // Recorded as each tool settles, so a steering handoff knows
            // which results are already final.
            settled[index] = outcome;
            return outcome;
          }),
        ),
      ),
    );
    const toolsDone = all(tasks);
    const finished = yield* select({tools: toolsDone, steering});
    if (finished.tag === "tools")
      return {
        type: "tools",
        step: stepNumber,
        action,
        outcomes: yield* toolsDone,
        pendingEvents,
        handoffs: new Map(),
        ...decisions,
      };

    // Steering is waiting. A program can run for minutes (a retry loop with
    // sleeps, an approval), so it must not hold the new input back: let
    // ordinary tools finish, then hand still-running programs to the turn,
    // which reports their result as a pending completion later. Approvals a
    // program obtains after the handoff do not extend this step's decisions.
    const isProgram = (index: number) =>
      action.calls[index].toolName === PROGRAM_TOOL_NAME;
    yield* all(tasks.filter((_, index) => !isProgram(index)));
    const handoffs = new Map<string, Task<ToolOutcome>>();
    const outcomes = action.calls.map((call, index): ToolOutcome => {
      const outcome = settled[index];
      if (outcome) return outcome;
      handoffs.set(call.toolCallId, tasks[index]);
      return {
        call,
        status: "pending",
        result: {
          operationId: call.toolCallId,
          status: "running",
          note: "New user input arrived while this program was running. It continues in the background and its result is reported when it finishes; cancel it with cancelOperation if it is no longer wanted.",
        },
      };
    });
    handedOff = handoffs.size > 0;
    return {
      type: "tools",
      step: stepNumber,
      action,
      outcomes,
      pendingEvents,
      handoffs,
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
    const settled = yield* interruptAndJoin(tasks, error);
    if (!(error instanceof AgentStepInterrupt)) {
      // The turn fails or is cancelled without these outcomes, so close the
      // batch here: every call that was started gets a finished status.
      yield* transcript.append(
        agentTools.toolsEvent(
          context.turnId,
          stepNumber,
          "finished",
          action.calls.map((call, index) =>
            agentTools.toolActivity(call, abandonedStatus(settled[index])),
          ),
        ),
      );
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
        handoffs: new Map(),
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
    const [settled] = yield* interruptAndJoin(
      [task],
      new AgentStepInterrupt(reason),
    );
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
    yield* interruptAndJoin([task], error);
    throw error;
  }
}

class AgentStepInterrupt extends InterruptedError {}

/**
 * Executes one model-selected call. A program runs here, because its nested
 * calls need the step's policy gate and pending supervisor; every other tool
 * goes to the tool dispatcher, which PTC also uses for the nested calls.
 */
export function* executeCall(
  call: ToolCall,
  context: AgentToolContext,
  discovered: DiscoveredAgentTool[],
  mcpTools: McpAgentTool[],
  scope: ToolExecutionScope,
): Operation<ToolOutcome> {
  if (call.toolName === PROGRAM_TOOL_NAME) {
    return yield* executeProgramTool(
      call,
      context,
      discovered,
      mcpTools,
      scope,
    );
  }
  return yield* agentTools.execute(call, context, discovered, mcpTools);
}

type ToolActivityStatus = Parameters<typeof agentTools.toolActivity>[1];

// The finished status of a call whose step failed or was cancelled. A call
// that never settled, or settled as pending, is cancelled: its completion
// phase will never run.
function abandonedStatus(
  result: FutureSettledResult<ToolOutcome> | undefined,
): ToolActivityStatus {
  if (result?.status !== "fulfilled") {
    return "cancelled";
  }
  switch (result.value.status) {
    case "pending":
      return "cancelled";
    case "cancel_requested":
      return "failed";
    default:
      return result.value.status;
  }
}
