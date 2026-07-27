// The concrete model -> tools -> model policy for one agent turn. Turn owns
// control signals; agent-tools owns concrete tool behavior.

import {CancelledError} from "@restatedev/restate-sdk";
import {
  all,
  allSettled,
  type Future,
  InterruptedError,
  type Operation,
  race,
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
  type PendingEvent,
  type ToolOutcome,
} from "./agent-tools.js";
import type {ModelResult, ToolCall} from "./model.js";
import {callModel} from "./model-gateway.js";
import {
  type ProgressReport,
  type SteeringSignal,
  TURN_SIGNALS,
} from "./types.js";

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

type CompletedStep<T> = {
  type: "completed";
  result: T;
  steering: SteeringSignal[];
  nextSteering: Future<SteeringSignal>;
};

type InterruptedStep = {type: "interrupted"; reason: string};

type ToolStep =
  | (CompletedStep<ToolOutcome[]> & {pending: PendingOperation[]})
  | (InterruptedStep & {
      outcomes: ToolOutcome[];
      events: PendingEvent[];
    });

type PendingStep =
  | {type: "steering"; steering: SteeringSignal}
  | {type: "completion"; event: PendingEvent}
  | InterruptedStep;

const MAX_ROUNDS = 8;
const MAX_TOOL_CALLS = 24;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function* reportProgress(
  context: AgentToolContext,
  phase: ProgressReport["phase"],
  message: string,
): Operation<void> {
  yield* sendClient(Agent, context.agentId).reportProgress({
    turnId: context.turnId,
    phase,
    message,
  });
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

function toolBatchSummary(outcomes: ToolOutcome[]): string {
  const succeeded = outcomes.filter(
    ({status}) => status === "succeeded",
  ).length;
  const failed = outcomes.filter(({status}) => status === "failed").length;
  const pending = outcomes.filter(({status}) => status === "pending").length;
  return `Tool batch finished: ${succeeded} succeeded, ${failed} failed, ${pending} pending`;
}

// Steering is buffered while a model call is in flight. The completed model
// action remains the current round; buffered instructions apply afterward.
function* runModelStep(
  agentId: string,
  messages: ModelMessage[],
  steering: Future<SteeringSignal>,
  interrupt: Future<string>,
): Operation<CompletedStep<ModelResult> | InterruptedStep> {
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
        result: yield* selected.future,
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
      result: outcomes,
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

// Pending tools outlive the model round that started them. Keep their live
// tasks in one turn-local registry instead of passing an array around the loop.
function createPendingOperations() {
  const active = new Map<string, PendingOperation>();

  return {
    get size(): number {
      return active.size;
    },

    describe(): string {
      return [...active.values()].map(({call}) => call.toolName).join(", ");
    },

    add(operations: PendingOperation[]): void {
      for (const operation of operations) {
        active.set(operation.call.toolCallId, operation);
      }
    },

    // A completion that wins the cancellation race remains completed.
    *applyCancellations(
      outcomes: ToolOutcome[],
    ): Operation<{outcomes: ToolOutcome[]; events: PendingEvent[]}> {
      const resolved: ToolOutcome[] = [];
      const events: PendingEvent[] = [];

      for (const outcome of outcomes) {
        if (outcome.status !== "cancel_requested") {
          resolved.push(outcome);
          continue;
        }

        const operation = active.get(outcome.operationId);
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
        active.delete(operation.call.toolCallId);

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

      return {outcomes: resolved, events};
    },

    *next(
      steering: Future<SteeringSignal>,
      interrupt: Future<string>,
    ): Operation<PendingStep> {
      const selected = yield* select({
        interrupt,
        steering,
        completion: race([...active.values()].map(({task}) => task)),
      });
      if (selected.tag === "interrupt") {
        return {type: "interrupted", reason: yield* selected.future};
      }
      if (selected.tag === "steering") {
        return {
          type: "steering",
          steering: yield* selected.future,
        };
      }
      const event = yield* selected.future;
      active.delete(event.call.toolCallId);
      return {type: "completion", event};
    },

    *stop(reason: unknown): Operation<PendingEvent[]> {
      const stopped = [...active.values()];
      active.clear();
      for (const operation of stopped) {
        operation.task.interrupt(reason);
      }
      const settled = yield* allSettled(stopped.map(({task}) => task));
      return settled.map((result, index) =>
        result.status === "fulfilled"
          ? result.value
          : {
              call: stopped[index].call,
              outcome: {
                status: "cancelled",
                reason: errorMessage(reason),
              },
            },
      );
    },
  };
}

type PendingOperations = ReturnType<typeof createPendingOperations>;

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
  context: AgentToolContext,
  messages: ModelMessage[],
  pending: PendingOperations,
  reason: string,
  consumedSteering: number,
): Operation<AgentLoopResult> {
  yield* reportProgress(
    context,
    "finalizing",
    "Stopping unfinished work for graceful interruption",
  );
  const stopped = yield* pending.stop(new InterruptedError(reason));
  messages.push(...stopped.map(agentTools.toRuntimeMessage));
  messages.push(interruptionInstruction(reason));
  yield* reportProgress(
    context,
    "finalizing",
    "Preparing a final response from completed results",
  );

  let text: string;
  try {
    const final = yield* callModel(context.agentId, messages, []);
    if (final.type === "text" && final.content.trim()) {
      text = final.content;
    } else {
      const detail =
        final.type === "error"
          ? final.message
          : "the finalizer unexpectedly requested a tool";
      text = `The turn was interrupted (${reason}), but its final response could not be generated: ${detail}.`;
    }
  } catch (error) {
    if (error instanceof InterruptedError || error instanceof CancelledError) {
      throw error;
    }
    text = `The turn was interrupted (${reason}), but its final response could not be generated: ${errorMessage(error)}.`;
  }
  return {
    status: "interrupted",
    reason,
    text,
    consumedSteering,
  };
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
  const pending = createPendingOperations();
  const finalize = (reason: string) =>
    finalizeInterruption(
      toolContext,
      messages,
      pending,
      reason,
      consumedSteering,
    );
  const fail = function* (error: unknown): Operation<AgentLoopResult> {
    yield* pending.stop(error);
    return {
      status: "failed",
      error: errorMessage(error),
      consumedSteering,
    };
  };

  try {
    while (modelRounds < MAX_ROUNDS) {
      yield* reportProgress(
        toolContext,
        "thinking",
        modelRounds === 0
          ? "Planning the turn"
          : `Planning model round ${modelRounds + 1}`,
      );
      const step = yield* runModelStep(agentId, messages, steering, interrupt);
      if (step.type === "interrupted") {
        return yield* finalize(step.reason);
      }
      steering = step.nextSteering;
      consumedSteering += step.steering.length;
      const action = step.result;
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
        if (pending.size > 0) {
          yield* reportProgress(
            toolContext,
            "waiting",
            `Waiting for ${pending.size} pending operation(s): ${pending.describe()}`,
          );
          const next = yield* pending.next(steering, interrupt);
          if (next.type === "steering") {
            consumedSteering += 1;
            steering = signal<SteeringSignal>(TURN_SIGNALS.steering);
            messages.push(toSteeringMessage(next.steering));
          } else if (next.type === "completion") {
            messages.push(agentTools.toRuntimeMessage(next.event));
          } else {
            messages.push({role: "assistant", content: action.content});
            return yield* finalize(next.reason);
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
        return yield* fail(
          new InterruptedError(
            `agent exceeded its ${MAX_TOOL_CALLS}-tool-call budget`,
          ),
        );
      }

      messages.push(action.message);
      yield* reportProgress(
        toolContext,
        "tools",
        `Running ${action.calls.length} tool call(s): ${action.calls
          .map(({toolName}) => toolName)
          .join(", ")}`,
      );
      const toolStep = yield* runToolStep(
        action.calls,
        toolContext,
        steering,
        interrupt,
      );
      if (toolStep.type === "interrupted") {
        messages.push(agentTools.toModelMessage(toolStep.outcomes));
        messages.push(...toolStep.events.map(agentTools.toRuntimeMessage));
        return yield* finalize(toolStep.reason);
      }
      steering = toolStep.nextSteering;
      consumedSteering += toolStep.steering.length;

      const cancellation = yield* pending.applyCancellations(toolStep.result);
      messages.push(agentTools.toModelMessage(cancellation.outcomes));
      pending.add(toolStep.pending);
      messages.push(...cancellation.events.map(agentTools.toRuntimeMessage));
      messages.push(
        ...[...step.steering, ...toolStep.steering].map(toSteeringMessage),
      );
      yield* reportProgress(
        toolContext,
        "tools",
        toolBatchSummary(cancellation.outcomes),
      );
    }

    return yield* fail(
      new InterruptedError(`agent did not finish within ${MAX_ROUNDS} rounds`),
    );
  } catch (error) {
    if (error instanceof InterruptedError || error instanceof CancelledError) {
      yield* pending.stop(error);
      throw error;
    }
    return yield* fail(error);
  }
}
