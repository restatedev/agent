// One bounded agent step and its Turn-side task supervisor. The step sees an
// immutable message snapshot, calls the agent model once, gates its proposed
// action, and runs an allowed foreground tool batch in parallel. It owns no
// state that survives its return.

import {
  all,
  allSettled,
  client,
  type Future,
  InterruptedError,
  type Operation,
  select,
  sendClient,
  signal,
  spawn,
  type Task,
} from "@restatedev/restate-sdk-gen";
import type {ModelMessage} from "ai";
import {Agent} from "./agent.js";
import {
  type AgentToolContext,
  agentTools,
  type ToolOutcome,
} from "./agent-tools.js";
import type {GuardrailDecision, ModelResult, ProposedAction} from "./model.js";
import {callGuardrailModel, callModel} from "./model-gateway.js";
import {
  type ApprovalDecision,
  approvalSignalName,
  type Guardrail,
} from "./types.js";

type ToolCallAction = Extract<ModelResult, {type: "tool_calls"}>;

export type ToolStep = {
  type: "tools";
  action: ToolCallAction;
  outcomes: ToolOutcome[];
  approvedGuardrails: string[];
};

type TextStep = Extract<ModelResult, {type: "text"}> & {
  approvedGuardrails: string[];
};

type GuardrailBlockedStep = {
  type: "guardrail_blocked";
  guardrailId: string;
  reason: string;
  approvedGuardrails: string[];
  rejectedGuardrails: string[];
};

type AgentStepResult =
  | TextStep
  | Extract<ModelResult, {type: "error"}>
  | ToolStep
  | GuardrailBlockedStep
  | {type: "tool_budget_exceeded"}
  | {type: "interrupted"; reason: string; tools?: ToolStep};

class AgentStepInterrupt extends InterruptedError {}

function proposedAction(
  action: Exclude<ModelResult, {type: "error"}>,
): ProposedAction {
  return action.type === "text"
    ? action
    : {type: action.type, calls: action.calls};
}

function* requestGuardrailApproval(
  context: AgentToolContext,
  stepNumber: number,
  approvalNumber: number,
  decision: Extract<GuardrailDecision, {decision: "require_approval"}>,
): Operation<ApprovalDecision | undefined> {
  const approvalId = `guardrail-${stepNumber}-${approvalNumber}`;
  const registered = yield* client(Agent, context.agentId).requestApproval({
    approvalId,
    turnId: context.turnId,
    question: decision.question,
    guardrailId: decision.guardrailId,
  });
  if (!registered) {
    return undefined;
  }

  yield* sendClient(Agent, context.agentId).reportProgress({
    turnId: context.turnId,
    phase: "waiting",
    message: `Guardrail ${decision.guardrailId} requires human approval`,
  });
  try {
    return yield* signal<ApprovalDecision>(approvalSignalName(approvalId));
  } catch (error) {
    yield* sendClient(Agent, context.agentId).cancelApproval({
      approvalId,
      turnId: context.turnId,
    });
    throw error;
  }
}

function* enforceGuardrails({
  context,
  instructions,
  messages,
  action,
  guardrails,
  approvedGuardrails,
  rejectedGuardrails,
  stepNumber,
}: {
  context: AgentToolContext;
  instructions?: string;
  messages: ModelMessage[];
  action: ProposedAction;
  guardrails: Guardrail[];
  approvedGuardrails: string[];
  rejectedGuardrails: string[];
  stepNumber: number;
}): Operation<
  | {decision: "allow"; approvedGuardrails: string[]}
  | {
      decision: "blocked";
      guardrailId: string;
      reason: string;
      approvedGuardrails: string[];
      rejectedGuardrails: string[];
    }
> {
  const approved = [...approvedGuardrails];
  let approvalNumber = 1;

  while (true) {
    const remaining = guardrails.filter(({id}) => !approved.includes(id));
    if (remaining.length === 0) {
      return {decision: "allow", approvedGuardrails: approved};
    }

    const decision = yield* callGuardrailModel({
      agentId: context.agentId,
      instructions,
      guardrails: remaining,
      rejectedGuardrailIds: rejectedGuardrails,
      messages,
      action,
    });
    if (decision.decision === "allow") {
      return {decision: "allow", approvedGuardrails: approved};
    }
    if (decision.decision === "deny") {
      return {
        decision: "blocked",
        guardrailId: decision.guardrailId,
        reason: decision.reason,
        approvedGuardrails: approved,
        rejectedGuardrails: [],
      };
    }

    const resolution = yield* requestGuardrailApproval(
      context,
      stepNumber,
      approvalNumber,
      decision,
    );
    if (!resolution) {
      return {
        decision: "blocked",
        guardrailId: decision.guardrailId,
        reason: "human approval could not be registered",
        approvedGuardrails: approved,
        rejectedGuardrails: [],
      };
    }
    if (resolution.decision === "rejected") {
      const reason = resolution.reason
        ? `Human rejected the request: ${resolution.reason}`
        : "Human rejected the request";
      return {
        decision: "blocked",
        guardrailId: decision.guardrailId,
        reason,
        approvedGuardrails: approved,
        rejectedGuardrails: [decision.guardrailId],
      };
    }

    approved.push(decision.guardrailId);
    approvalNumber += 1;
  }
}

export function* agentStep({
  context,
  instructions,
  messages,
  guardrails,
  approvedGuardrails,
  rejectedGuardrails,
  stepNumber,
  remainingToolCalls,
}: {
  context: AgentToolContext;
  instructions?: string;
  messages: ModelMessage[];
  guardrails: Guardrail[];
  approvedGuardrails: string[];
  rejectedGuardrails: string[];
  stepNumber: number;
  remainingToolCalls: number;
}): Operation<AgentStepResult> {
  let activeTools:
    | {
        action: ToolCallAction;
        tasks: Task<ToolOutcome>[];
        approvedGuardrails: string[];
      }
    | undefined;

  try {
    const action = yield* callModel({
      agentId: context.agentId,
      instructions,
      guardrails,
      messages,
      tools: agentTools.manifests,
    });
    if (action.type === "error") {
      return action;
    }
    if (
      action.type === "tool_calls" &&
      action.calls.length > remainingToolCalls
    ) {
      return {type: "tool_budget_exceeded"};
    }

    const guarded = yield* enforceGuardrails({
      context,
      instructions,
      messages,
      action: proposedAction(action),
      guardrails,
      approvedGuardrails,
      rejectedGuardrails,
      stepNumber,
    });
    if (guarded.decision === "blocked") {
      return {
        type: "guardrail_blocked",
        guardrailId: guarded.guardrailId,
        reason: guarded.reason,
        approvedGuardrails: guarded.approvedGuardrails,
        rejectedGuardrails: guarded.rejectedGuardrails,
      };
    }
    if (action.type === "text") {
      return {
        ...action,
        approvedGuardrails: guarded.approvedGuardrails,
      };
    }

    const tasks = action.calls.map((call) =>
      spawn(agentTools.execute(call, context)),
    );
    activeTools = {
      action,
      tasks,
      approvedGuardrails: guarded.approvedGuardrails,
    };
    yield* sendClient(Agent, context.agentId).reportProgress({
      turnId: context.turnId,
      phase: "tools",
      message: `Running ${action.calls.length} tool call(s): ${action.calls
        .map(({toolName}) => toolName)
        .join(", ")}`,
    });
    return {
      type: "tools",
      action,
      outcomes: yield* all(tasks),
      approvedGuardrails: guarded.approvedGuardrails,
    };
  } catch (error) {
    if (!activeTools) {
      if (!(error instanceof AgentStepInterrupt)) {
        throw error;
      }
      return {type: "interrupted", reason: error.message};
    }

    const {action, tasks, approvedGuardrails} = activeTools;
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
        action,
        approvedGuardrails,
        outcomes: settled.map(
          (result, index): ToolOutcome =>
            result.status === "fulfilled"
              ? result.value
              : {
                  call: action.calls[index],
                  status: "failed",
                  error: `interrupted before completion: ${error.message}`,
                },
        ),
      },
    };
  }
}

// Wait for one already-spawned step. Interruption stops and joins the step,
// preserving any foreground tool results it managed to produce. Turn remains
// responsible for committing the returned result.
export function* settleStep(
  task: Task<AgentStepResult>,
  interrupt: Future<string>,
): Operation<AgentStepResult> {
  try {
    const selected = yield* select({interrupt, task});
    if (selected.tag === "task") {
      return yield* selected.future;
    }

    const reason = yield* selected.future;
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
