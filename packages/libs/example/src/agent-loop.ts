// The concrete model -> tools -> model policy for one agent turn.
//
// Turn owns the interrupt signal and agent-tools owns concrete tool behavior.
// This module keeps the live orchestration state needed to stop gracefully:
// model rounds, parallel tool batches, steering, pending tasks, and the model
// context used for a final interruption response.

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
import {type SteeringSignal, TURN_SIGNALS} from "./types.js";

type AgentLoopInput = {
  agentId: string;
  turnId: string;
  messages: ModelMessage[];
  interrupt: Future<string>;
};

type AgentLoopResult = (
  | {status: "completed"; text: string}
  | {status: "interrupted"; reason: string; text: string}
  | {status: "failed"; error: string}
) & {consumedSteering: number};

type PendingOperation = {
  call: ToolCall;
  task: Task<PendingEvent>;
};

type ModelStep =
  | {
      type: "completed";
      action: ModelResult;
      steering: SteeringSignal[];
      nextSteering: Future<SteeringSignal>;
    }
  | {type: "interrupted"; reason: string};

type ToolStep =
  | {
      type: "completed";
      outcomes: ToolOutcome[];
      pending: PendingOperation[];
      steering: SteeringSignal[];
      nextSteering: Future<SteeringSignal>;
    }
  | {
      type: "interrupted";
      reason: string;
      outcomes: ToolOutcome[];
      events: PendingEvent[];
    };

type CancellationStep = {
  outcomes: ToolOutcome[];
  pending: PendingOperation[];
  events: PendingEvent[];
};

type PendingStep =
  | {
      type: "steering";
      steering: SteeringSignal;
      nextSteering: Future<SteeringSignal>;
    }
  | {type: "completion"; event: PendingEvent}
  | {type: "interrupted"; reason: string};

const MAX_ROUNDS = 8;
const MAX_TOOL_CALLS = 24;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toSteeringMessage({queued, message}: SteeringSignal): ModelMessage {
  const queuedMessages =
    queued.length === 0
      ? ["(none)"]
      : queued.map((text, index) => `${index + 1}. ${JSON.stringify(text)}`);
  return {
    role: "user",
    content: [
      "[Steering update]",
      "Queued user messages promoted into this turn:",
      ...queuedMessages,
      "",
      "New steering message:",
      message,
    ].join("\n"),
  };
}

// Steering is buffered while a model call is in flight. The completed model
// action remains the current round; buffered instructions apply afterward.
function* runModelStep(
  agentId: string,
  messages: ModelMessage[],
  steering: Future<SteeringSignal>,
  interrupt: Future<string>,
): Operation<ModelStep> {
  const modelTask = spawn(callModel(agentId, messages, agentTools.manifests));
  const buffered: SteeringSignal[] = [];
  let nextSteering = steering;

  while (true) {
    const selected = yield* select({
      interrupt,
      steering: nextSteering,
      model: modelTask,
    });
    if (selected.tag === "interrupt") {
      const reason = yield* selected.future;
      modelTask.interrupt(new InterruptedError(reason));
      yield* allSettled([modelTask]);
      return {type: "interrupted", reason};
    }
    if (selected.tag === "model") {
      return {
        type: "completed",
        action: yield* selected.future,
        steering: buffered,
        nextSteering,
      };
    }
    buffered.push(yield* selected.future);
    nextSteering = signal<SteeringSignal>(TURN_SIGNALS.steering);
  }
}

// Foreground calls finish as one protocol-complete batch. Steering received
// meanwhile is buffered, and pending calls start turn-scoped completion tasks.
function* runToolStep(
  calls: ToolCall[],
  context: AgentToolContext,
  steering: Future<SteeringSignal>,
  interrupt: Future<string>,
): Operation<ToolStep> {
  const tasks = calls.map((call) => spawn(agentTools.execute(call, context)));
  const completed = all(tasks);
  const buffered: SteeringSignal[] = [];
  let nextSteering = steering;

  while (true) {
    const selected = yield* select({
      interrupt,
      steering: nextSteering,
      tools: completed,
    });
    if (selected.tag === "interrupt") {
      const reason = yield* selected.future;
      for (const task of tasks) {
        task.interrupt(new InterruptedError(reason));
      }
      const settled = yield* allSettled(tasks);
      const outcomes = settled.map(
        (result, index): ToolOutcome =>
          result.status === "fulfilled"
            ? result.value
            : {
                call: calls[index],
                status: "failed",
                error: `interrupted before completion: ${reason}`,
              },
      );
      return {
        type: "interrupted",
        reason,
        outcomes,
        events: outcomes.flatMap((outcome): PendingEvent[] =>
          outcome.status === "pending"
            ? [
                {
                  call: outcome.call,
                  outcome: {status: "cancelled", reason},
                },
              ]
            : [],
        ),
      };
    }
    if (selected.tag === "steering") {
      buffered.push(yield* selected.future);
      nextSteering = signal<SteeringSignal>(TURN_SIGNALS.steering);
      continue;
    }

    const outcomes = yield* selected.future;
    return {
      type: "completed",
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
    steering: Future<SteeringSignal>,
    interrupt: Future<string>,
  ): Operation<PendingStep> {
    const selected = yield* select({
      interrupt,
      steering,
      completion: race(pending.map(({task}) => task)),
    });
    if (selected.tag === "interrupt") {
      return {type: "interrupted", reason: yield* selected.future};
    }
    if (selected.tag === "steering") {
      return {
        type: "steering",
        steering: yield* selected.future,
        nextSteering: signal<SteeringSignal>(TURN_SIGNALS.steering),
      };
    }
    return {type: "completion", event: yield* selected.future};
  },

  *stop(
    pending: PendingOperation[],
    reason: unknown,
  ): Operation<PendingEvent[]> {
    for (const operation of pending) {
      operation.task.interrupt(reason);
    }
    const settled = yield* allSettled(pending.map(({task}) => task));
    return settled.map((result, index) =>
      result.status === "fulfilled"
        ? result.value
        : {
            call: pending[index].call,
            outcome: {
              status: "cancelled",
              reason: errorMessage(reason),
            },
          },
    );
  },
};

function interruptionInstruction(reason: string): ModelMessage {
  return {
    role: "user",
    content: [
      "[Graceful interruption]",
      `User instruction: ${JSON.stringify(reason)}`,
      "Stop the original execution now and do not request any more tools.",
      "Using only completed results and runtime events already present above, give the best direct answer possible.",
      "Honor the user's interruption instruction, distinguish completed work from cancelled or incomplete work, and never invent missing results.",
    ].join("\n"),
  };
}

function* finalizeInterruption(
  agentId: string,
  messages: ModelMessage[],
  pending: PendingOperation[],
  reason: string,
  consumedSteering: number,
): Operation<AgentLoopResult> {
  const stopped = yield* pendingOperations.stop(
    pending,
    new InterruptedError(reason),
  );
  messages.push(...stopped.map(agentTools.toRuntimeMessage));
  messages.push(interruptionInstruction(reason));

  try {
    const final = yield* callModel(agentId, messages, []);
    if (final.type === "text" && final.content.trim()) {
      return {
        status: "interrupted",
        reason,
        text: final.content,
        consumedSteering,
      };
    }
    const detail =
      final.type === "error"
        ? final.message
        : "the finalizer unexpectedly requested a tool";
    return {
      status: "interrupted",
      reason,
      text: `The turn was interrupted (${reason}), but its final response could not be generated: ${detail}.`,
      consumedSteering,
    };
  } catch (error) {
    if (error instanceof InterruptedError || error instanceof CancelledError) {
      throw error;
    }
    return {
      status: "interrupted",
      reason,
      text: `The turn was interrupted (${reason}), but its final response could not be generated: ${errorMessage(error)}.`,
      consumedSteering,
    };
  }
}

// Run model -> tools -> model until there is a final answer or a graceful
// interruption finalizes the work completed so far.
export function* agentLoop({
  agentId,
  turnId,
  messages: context,
  interrupt,
}: AgentLoopInput): Operation<AgentLoopResult> {
  const messages = [...context];
  const toolContext = {agentId, turnId};
  let steering = signal<SteeringSignal>(TURN_SIGNALS.steering);
  let consumedSteering = 0;
  let toolCallCount = 0;
  let modelRounds = 0;
  let pending: PendingOperation[] = [];

  try {
    while (modelRounds < MAX_ROUNDS) {
      const step = yield* runModelStep(agentId, messages, steering, interrupt);
      if (step.type === "interrupted") {
        return yield* finalizeInterruption(
          agentId,
          messages,
          pending,
          step.reason,
          consumedSteering,
        );
      }
      steering = step.nextSteering;
      consumedSteering += step.steering.length;
      const {action} = step;
      modelRounds += 1;

      // A text/error response was produced before these instructions arrived.
      // It has no side effects, so apply the buffered steering instead of
      // exposing a stale answer or retrying a stale model error.
      if (action.type !== "tool_calls" && step.steering.length > 0) {
        messages.push(...step.steering.map(toSteeringMessage));
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
          const next = yield* pendingOperations.next(
            pending,
            steering,
            interrupt,
          );
          if (next.type === "steering") {
            consumedSteering += 1;
            steering = next.nextSteering;
            messages.push(toSteeringMessage(next.steering));
          } else if (next.type === "completion") {
            pending = pending.filter(
              ({call}) => call.toolCallId !== next.event.call.toolCallId,
            );
            messages.push(agentTools.toRuntimeMessage(next.event));
          } else {
            messages.push({role: "assistant", content: action.content});
            return yield* finalizeInterruption(
              agentId,
              messages,
              pending,
              next.reason,
              consumedSteering,
            );
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
      const toolStep = yield* runToolStep(
        action.calls,
        toolContext,
        steering,
        interrupt,
      );
      if (toolStep.type === "interrupted") {
        messages.push(agentTools.toModelMessage(toolStep.outcomes));
        messages.push(...toolStep.events.map(agentTools.toRuntimeMessage));
        return yield* finalizeInterruption(
          agentId,
          messages,
          pending,
          toolStep.reason,
          consumedSteering,
        );
      }
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
        ...[...step.steering, ...toolStep.steering].map(toSteeringMessage),
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
