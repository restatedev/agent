// One bounded agent step. It sees an immutable message snapshot, calls the
// model once, and runs that response's foreground tools in parallel. It owns
// no state that survives its return.

import {
  all,
  allSettled,
  InterruptedError,
  type Operation,
  sendClient,
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
import type {ModelResult} from "./model.js";
import {callModel} from "./model-gateway.js";

type ToolCallAction = Extract<ModelResult, {type: "tool_calls"}>;

export type ToolStep = {
  type: "tools";
  action: ToolCallAction;
  outcomes: ToolOutcome[];
};

export type AgentStepResult =
  | Exclude<ModelResult, ToolCallAction>
  | ToolStep
  | {type: "tool_budget_exceeded"}
  | {type: "interrupted"; reason: string; tools?: ToolStep};

export class AgentStepInterrupt extends InterruptedError {}

export function* agentStep({
  context,
  messages,
  remainingToolCalls,
}: {
  context: AgentToolContext;
  messages: ModelMessage[];
  remainingToolCalls: number;
}): Operation<AgentStepResult> {
  let activeTools:
    | {action: ToolCallAction; tasks: Task<ToolOutcome>[]}
    | undefined;

  try {
    const action = yield* callModel(
      context.agentId,
      messages,
      agentTools.manifests,
    );
    if (action.type !== "tool_calls") {
      return action;
    }
    if (action.calls.length > remainingToolCalls) {
      return {type: "tool_budget_exceeded"};
    }

    const tasks = action.calls.map((call) =>
      spawn(agentTools.execute(call, context)),
    );
    activeTools = {action, tasks};
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
    };
  } catch (error) {
    if (!activeTools) {
      if (!(error instanceof AgentStepInterrupt)) {
        throw error;
      }
      return {type: "interrupted", reason: error.message};
    }

    const {action, tasks} = activeTools;
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
