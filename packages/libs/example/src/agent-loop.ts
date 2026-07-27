// The concrete model -> tools -> model policy for one agent turn.
//
// Turn owns hard interruption and agent-tools owns concrete tool behavior.
// This module keeps only the live orchestration state that cannot cross either
// boundary: model rounds, parallel tool batches, steering, and pending tasks.

import {CancelledError} from "@restatedev/restate-sdk";
import {
  all,
  allSettled,
  type Future,
  InterruptedError,
  type Operation,
  race,
  select,
  signal,
  spawn,
  type Task,
} from "@restatedev/restate-sdk-gen";
import type {ModelMessage} from "ai";
import {
  type AgentToolContext,
  agentTools,
  type PendingEvent,
  type ToolOutcome,
} from "./agent-tools.js";
import type {ModelResult, ToolCall} from "./model.js";
import {callModel} from "./model-gateway.js";

type AgentLoopInput = {
  agentId: string;
  turnId: string;
  messages: ModelMessage[];
};

type AgentLoopResult = (
  | {status: "completed"; text: string}
  | {status: "failed"; error: string}
) & {consumedSteering: number};

type PendingOperation = {
  call: ToolCall;
  task: Task<PendingEvent>;
};

type ModelStep = {
  action: ModelResult;
  steering: string[];
  nextSteering: Future<string>;
};

type ToolStep = {
  outcomes: ToolOutcome[];
  pending: PendingOperation[];
  steering: string[];
  nextSteering: Future<string>;
};

type CancellationStep = {
  outcomes: ToolOutcome[];
  pending: PendingOperation[];
  events: PendingEvent[];
};

type PendingStep =
  | {type: "steering"; message: string; nextSteering: Future<string>}
  | {type: "completion"; event: PendingEvent};

const MAX_ROUNDS = 8;
const MAX_TOOL_CALLS = 24;
const STEERING = "steering";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Steering is buffered while a model call is in flight. The completed model
// action remains the current round; buffered instructions apply afterward.
function* runModelStep(
  agentId: string,
  messages: ModelMessage[],
  steering: Future<string>,
): Operation<ModelStep> {
  const modelTask = spawn(callModel(agentId, messages, agentTools.manifests));
  const buffered: string[] = [];
  let nextSteering = steering;

  while (true) {
    const selected = yield* select({
      steering: nextSteering,
      model: modelTask,
    });
    if (selected.tag === "model") {
      return {
        action: yield* selected.future,
        steering: buffered,
        nextSteering,
      };
    }
    buffered.push(yield* selected.future);
    nextSteering = signal<string>(STEERING);
  }
}

// Foreground calls finish as one protocol-complete batch. Steering received
// meanwhile is buffered, and pending calls start turn-scoped completion tasks.
function* runToolStep(
  calls: ToolCall[],
  context: AgentToolContext,
  steering: Future<string>,
): Operation<ToolStep> {
  const tasks = calls.map((call) => spawn(agentTools.execute(call, context)));
  const completed = all(tasks);
  const buffered: string[] = [];
  let nextSteering = steering;

  while (true) {
    const selected = yield* select({
      steering: nextSteering,
      tools: completed,
    });
    if (selected.tag === "steering") {
      buffered.push(yield* selected.future);
      nextSteering = signal<string>(STEERING);
      continue;
    }

    const outcomes = yield* selected.future;
    return {
      outcomes,
      pending: outcomes.flatMap((outcome): PendingOperation[] =>
        outcome.status === "pending"
          ? [
              {
                call: outcome.call,
                task: spawn(agentTools.complete(outcome.call, context)),
              },
            ]
          : [],
      ),
      steering: buffered,
      nextSteering,
    };
  }
}

// The loop owns the live task registry, so pending-task coordination belongs
// together here even though each task's concrete behavior lives in agent-tools.
const pendingOperations = {
  // Resolve declarative cancellation requests after preserving the model's
  // complete tool-call/result protocol. A completion that wins the race is
  // reported as completed rather than being rewritten as cancelled.
  *applyCancellations(
    outcomes: ToolOutcome[],
    pending: PendingOperation[],
  ): Operation<CancellationStep> {
    const resolved: ToolOutcome[] = [];
    const events: PendingEvent[] = [];
    let remaining = pending;

    for (const outcome of outcomes) {
      if (outcome.status !== "cancel_requested") {
        resolved.push(outcome);
        continue;
      }

      const operation = remaining.find(
        ({call}) => call.toolCallId === outcome.operationId,
      );
      if (!operation) {
        resolved.push({
          call: outcome.call,
          status: "failed",
          error: `no pending operation found for ${outcome.operationId}`,
        });
        continue;
      }

      operation.task.interrupt(new InterruptedError(outcome.reason));
      const [settled] = yield* allSettled([operation.task]);
      remaining = remaining.filter(
        ({call}) => call.toolCallId !== operation.call.toolCallId,
      );

      if (settled.status === "fulfilled") {
        events.push(settled.value);
        resolved.push({
          call: outcome.call,
          status: "failed",
          error: `${outcome.operationId} completed before it could be cancelled`,
        });
        continue;
      }

      events.push({
        call: operation.call,
        outcome: {status: "cancelled", reason: outcome.reason},
      });
      resolved.push({
        call: outcome.call,
        status: "succeeded",
        result: `Cancelled pending ${operation.call.toolName} operation ${outcome.operationId}`,
      });
    }

    return {outcomes: resolved, pending: remaining, events};
  },

  *next(
    pending: PendingOperation[],
    steering: Future<string>,
  ): Operation<PendingStep> {
    const selected = yield* select({
      steering,
      completion: race(pending.map(({task}) => task)),
    });
    if (selected.tag === "steering") {
      return {
        type: "steering",
        message: yield* selected.future,
        nextSteering: signal<string>(STEERING),
      };
    }
    return {type: "completion", event: yield* selected.future};
  },

  *stop(pending: PendingOperation[], reason: unknown): Operation<void> {
    for (const operation of pending) {
      operation.task.interrupt(reason);
    }
    yield* allSettled(pending.map(({task}) => task));
  },
};

// Run model -> tools -> model until there is a final answer.
export function* agentLoop({
  agentId,
  turnId,
  messages: context,
}: AgentLoopInput): Operation<AgentLoopResult> {
  const messages = [...context];
  const toolContext = {agentId, turnId};
  let steering = signal<string>(STEERING);
  let consumedSteering = 0;
  let toolCallCount = 0;
  let modelRounds = 0;
  let pending: PendingOperation[] = [];

  try {
    while (modelRounds < MAX_ROUNDS) {
      const step = yield* runModelStep(agentId, messages, steering);
      steering = step.nextSteering;
      consumedSteering += step.steering.length;
      const {action} = step;
      modelRounds += 1;

      // A text/error response was produced before these instructions arrived.
      // It has no side effects, so apply the buffered steering instead of
      // exposing a stale answer or retrying a stale model error.
      if (action.type !== "tool_calls" && step.steering.length > 0) {
        messages.push(
          ...step.steering.map(
            (content): ModelMessage => ({role: "user", content}),
          ),
        );
        continue;
      }

      if (action.type === "error") {
        messages.push({
          role: "user",
          content: `Your last response could not be used (${action.message}). Try again with the available tools or give a final answer.`,
        });
        continue;
      }

      if (action.type === "text") {
        if (!action.content.trim()) {
          messages.push({
            role: "user",
            content:
              "Your last response was empty. Call a tool or give a final answer.",
          });
          continue;
        }
        if (pending.length > 0) {
          const next = yield* pendingOperations.next(pending, steering);
          if (next.type === "steering") {
            consumedSteering += 1;
            steering = next.nextSteering;
            messages.push({role: "user", content: next.message});
          } else {
            pending = pending.filter(
              ({call}) => call.toolCallId !== next.event.call.toolCallId,
            );
            messages.push(agentTools.toRuntimeMessage(next.event));
          }
          continue;
        }
        return {
          status: "completed",
          text: action.content,
          consumedSteering,
        };
      }

      toolCallCount += action.calls.length;
      if (toolCallCount > MAX_TOOL_CALLS) {
        yield* pendingOperations.stop(
          pending,
          new InterruptedError("agent exceeded its tool-call budget"),
        );
        return {
          status: "failed",
          error: `agent exceeded its ${MAX_TOOL_CALLS}-tool-call budget`,
          consumedSteering,
        };
      }

      messages.push(action.message);
      const toolStep = yield* runToolStep(action.calls, toolContext, steering);
      steering = toolStep.nextSteering;
      consumedSteering += toolStep.steering.length;

      const cancellation = yield* pendingOperations.applyCancellations(
        toolStep.outcomes,
        pending,
      );
      messages.push(agentTools.toModelMessage(cancellation.outcomes));
      pending = [...cancellation.pending, ...toolStep.pending];
      messages.push(...cancellation.events.map(agentTools.toRuntimeMessage));
      messages.push(
        ...[...step.steering, ...toolStep.steering].map(
          (content): ModelMessage => ({role: "user", content}),
        ),
      );
    }

    yield* pendingOperations.stop(
      pending,
      new InterruptedError("agent exceeded its model-round budget"),
    );
    return {
      status: "failed",
      error: `agent did not finish within ${MAX_ROUNDS} rounds`,
      consumedSteering,
    };
  } catch (error) {
    yield* pendingOperations.stop(pending, error);
    if (error instanceof InterruptedError || error instanceof CancelledError) {
      throw error;
    }
    return {
      status: "failed",
      error: errorMessage(error),
      consumedSteering,
    };
  }
}
