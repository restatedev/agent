// One bounded agent step and its Turn-side task supervisor. The step sees an
// immutable message snapshot, calls the model once, and runs that response's
// foreground tools in parallel. It owns no state that survives its return.

import {
  all,
  allSettled,
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
import type {ModelResult} from "./model.js";
import {callModel} from "./model-gateway.js";
import {type SteeringSignal, TURN_SIGNALS} from "./types.js";

type ToolCallAction = Extract<ModelResult, {type: "tool_calls"}>;

export type ToolStep = {
  type: "tools";
  action: ToolCallAction;
  outcomes: ToolOutcome[];
};

type AgentStepResult =
  | Exclude<ModelResult, ToolCallAction>
  | ToolStep
  | {type: "tool_budget_exceeded"}
  | {type: "interrupted"; reason: string; tools?: ToolStep};

type StepSettlement = {
  step: AgentStepResult;
  steering: SteeringSignal[];
  nextSteering: Future<SteeringSignal>;
};

class AgentStepInterrupt extends InterruptedError {}

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

// Wait for one already-spawned step while buffering steering. Interruption
// stops and joins the step, preserving any foreground tool results it managed
// to produce. Turn remains responsible for committing the returned settlement.
export function* settleStep(
  task: Task<AgentStepResult>,
  steering: Future<SteeringSignal>,
  interrupt: Future<string>,
): Operation<StepSettlement> {
  const buffered: SteeringSignal[] = [];
  let nextSteering = steering;

  try {
    while (true) {
      const selected = yield* select({
        interrupt,
        steering: nextSteering,
        task,
      });
      if (selected.tag === "steering") {
        buffered.push(yield* selected.future);
        nextSteering = signal<SteeringSignal>(TURN_SIGNALS.steering);
        continue;
      }
      if (selected.tag === "task") {
        return {
          step: yield* selected.future,
          steering: buffered,
          nextSteering,
        };
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
      return {
        step: {type: "interrupted", reason, tools},
        steering: buffered,
        nextSteering,
      };
    }
  } catch (error) {
    task.interrupt(error);
    yield* allSettled([task]);
    throw error;
  }
}
