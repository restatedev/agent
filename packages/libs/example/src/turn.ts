// One Turn invocation is the durable agent-turn state machine. It owns the
// transient model context, control-signal cursor, budgets, and pending tools.
// Each iteration spawns one bounded agent step and applies its returned data.

import {CancelledError} from "@restatedev/restate-sdk";
import {
  type Future,
  handlerRequest,
  InterruptedError,
  type Operation,
  schemas,
  sendClient,
  service,
  signal,
  spawn,
} from "@restatedev/restate-sdk-gen";
import type {ModelMessage} from "ai";
import {z} from "zod";
import {Agent} from "./agent.js";
import {createPendingOperations} from "./agent-pending.js";
import {
  type AgentToolContext,
  agentTools,
  type ToolOutcome,
} from "./agent-tools.js";
import {callModel} from "./model-gateway.js";
import {
  buildModelContext,
  interruptionInstruction,
  steeringMessage,
} from "./turn-context.js";
import {createSteeringInbox} from "./turn-steering.js";
import {agentStep, settleStep, type ToolStep} from "./turn-step.js";
import {
  type ProgressReport,
  type SteeringSignal,
  TURN_SIGNALS,
  type TurnOutcome,
  type TurnRequest,
  TurnRequestSchema,
} from "./types.js";

type TurnState = {
  context: AgentToolContext;
  messages: ModelMessage[];
  interrupt: Future<string>;
  steering: ReturnType<typeof createSteeringInbox>;
  consumedSteering: number;
  steps: number;
  toolCalls: number;
  pending: ReturnType<typeof createPendingOperations>;
};

const MAX_STEPS = 8;
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

function toolBatchSummary(outcomes: ToolOutcome[]): string {
  const succeeded = outcomes.filter(
    ({status}) => status === "succeeded",
  ).length;
  const failed = outcomes.filter(({status}) => status === "failed").length;
  const pending = outcomes.filter(({status}) => status === "pending").length;
  return `Tool batch finished: ${succeeded} succeeded, ${failed} failed, ${pending} pending`;
}

function* finalizeInterruption(
  state: TurnState,
  reason: string,
): Operation<TurnOutcome> {
  yield* reportProgress(
    state.context,
    "finalizing",
    "Stopping unfinished work for graceful interruption",
  );
  const stopped = yield* state.pending.stop(new InterruptedError(reason));
  state.messages.push(...stopped.map(agentTools.toRuntimeMessage));
  state.messages.push(interruptionInstruction(reason));
  yield* reportProgress(
    state.context,
    "finalizing",
    "Preparing a final response from completed results",
  );

  let response: string;
  try {
    const final = yield* callModel(state.context.agentId, state.messages, []);
    if (final.type === "text" && final.content.trim()) {
      response = final.content;
    } else {
      const detail =
        final.type === "error"
          ? final.message
          : "the finalizer unexpectedly requested a tool";
      response = `The turn was interrupted (${reason}), but its final response could not be generated: ${detail}.`;
    }
  } catch (error) {
    if (error instanceof InterruptedError || error instanceof CancelledError) {
      throw error;
    }
    response = `The turn was interrupted (${reason}), but its final response could not be generated: ${errorMessage(error)}.`;
  }
  return {
    turnId: state.context.turnId,
    status: "interrupted",
    reason,
    response,
    consumedSteering: state.consumedSteering,
  };
}

function* failTurn(state: TurnState, error: unknown): Operation<TurnOutcome> {
  yield* state.pending.stop(error);
  return {
    turnId: state.context.turnId,
    status: "failed",
    error: errorMessage(error),
    consumedSteering: state.consumedSteering,
  };
}

// Text is a candidate final answer. Pending work keeps the state machine alive
// until a completion, steering update, or interruption chooses the next move.
function* applyText(
  state: TurnState,
  text: string,
): Operation<TurnOutcome | undefined> {
  if (!text.trim()) {
    state.messages.push({
      role: "user",
      content:
        "Your last response was empty. Call a tool or give a final answer.",
    });
    return undefined;
  }
  if (state.pending.size === 0) {
    return {
      turnId: state.context.turnId,
      status: "completed",
      response: text,
      consumedSteering: state.consumedSteering,
    };
  }

  yield* reportProgress(
    state.context,
    "waiting",
    `Waiting for ${state.pending.size} pending operation(s): ${state.pending.describe()}`,
  );
  const next = yield* state.pending.next(state.steering.ready, state.interrupt);
  if (next.type === "steering") {
    const steering = state.steering.drain();
    state.consumedSteering += steering.length;
    state.messages.push(...steering.map(steeringMessage));
    return undefined;
  }
  if (next.type === "completion") {
    state.messages.push(agentTools.toRuntimeMessage(next.event));
    return undefined;
  }

  state.messages.push({role: "assistant", content: text});
  return yield* finalizeInterruption(state, next.reason);
}

function* applyTools(
  state: TurnState,
  step: ToolStep,
  steering: SteeringSignal[],
): Operation<void> {
  const applied = yield* state.pending.apply(step.outcomes, state.context);
  state.messages.push(
    step.action.message,
    agentTools.toModelMessage(applied.outcomes),
    ...applied.events.map(agentTools.toRuntimeMessage),
    ...steering.map(steeringMessage),
  );
  yield* reportProgress(
    state.context,
    "tools",
    toolBatchSummary(applied.outcomes),
  );
}

function retainInterruptedTools(
  state: TurnState,
  step: ToolStep,
  reason: string,
): void {
  state.messages.push(
    step.action.message,
    agentTools.toModelMessage(step.outcomes),
    ...step.outcomes.flatMap((outcome): ModelMessage[] =>
      outcome.status === "pending"
        ? [
            agentTools.toRuntimeMessage({
              call: outcome.call,
              outcome: {status: "cancelled", reason},
            }),
          ]
        : [],
    ),
  );
}

export const Turn = service({
  name: "Turn",
  handlers: {
    // One handler invocation owns the complete transient state machine and
    // reports exactly one high-level outcome to the Agent.
    run: schemas(
      {input: TurnRequestSchema, output: z.void()},
      function* (req: TurnRequest): Operation<void> {
        const turnId = handlerRequest().id;
        const state: TurnState = {
          context: {agentId: req.agentId, turnId},
          messages: buildModelContext(req.history, req.summary),
          interrupt: signal<string>(TURN_SIGNALS.interrupt),
          steering: createSteeringInbox(),
          consumedSteering: 0,
          steps: 0,
          toolCalls: 0,
          pending: createPendingOperations(),
        };

        try {
          let result: TurnOutcome | undefined;
          steps: while (state.steps < MAX_STEPS) {
            yield* reportProgress(
              state.context,
              "thinking",
              state.steps === 0
                ? "Planning the turn"
                : `Planning agent step ${state.steps + 1}`,
            );

            const task = spawn(
              agentStep({
                context: state.context,
                messages: [...state.messages],
                remainingToolCalls: MAX_TOOL_CALLS - state.toolCalls,
              }),
            );
            const step = yield* settleStep(task, state.interrupt);

            if (step.type === "interrupted") {
              if (step.tools) {
                retainInterruptedTools(state, step.tools, step.reason);
              }
              result = yield* finalizeInterruption(state, step.reason);
              break;
            }

            const steering = state.steering.drain();
            state.consumedSteering += steering.length;
            state.steps += 1;

            // A text/error response produced before buffered steering arrived
            // has no side effects. Let the next step see the new messages.
            if (
              (step.type === "text" || step.type === "error") &&
              steering.length > 0
            ) {
              state.messages.push(...steering.map(steeringMessage));
              continue;
            }

            switch (step.type) {
              case "error":
                state.messages.push({
                  role: "user",
                  content: `Your last response could not be used (${step.message}). Try again with the available tools or give a final answer.`,
                });
                continue;

              case "text": {
                const completed = yield* applyText(state, step.content);
                if (!completed) {
                  continue;
                }
                result = completed;
                break steps;
              }

              case "tool_budget_exceeded":
                result = yield* failTurn(
                  state,
                  new InterruptedError(
                    `agent exceeded its ${MAX_TOOL_CALLS}-tool-call budget`,
                  ),
                );
                break steps;

              case "tools":
                state.toolCalls += step.action.calls.length;
                yield* applyTools(state, step, steering);
                continue;
            }
          }

          const outcome =
            result ??
            (yield* failTurn(
              state,
              new InterruptedError(
                `agent did not finish within ${MAX_STEPS} steps`,
              ),
            ));
          yield* state.steering.stop(new InterruptedError("Turn settled"));
          yield* sendClient(Agent, req.agentId).append(outcome);
        } catch (error) {
          yield* state.steering.stop(error);
          yield* state.pending.stop(error);
          if (error instanceof CancelledError) {
            yield* sendClient(Agent, req.agentId).append({
              turnId,
              status: "interrupted",
              reason: "Turn cancelled",
              consumedSteering: state.consumedSteering,
            });
            throw error;
          }

          yield* sendClient(Agent, req.agentId).append({
            turnId,
            status: "failed",
            error: errorMessage(error),
            consumedSteering: state.consumedSteering,
          });
        }
      },
    ),
  },
  options: {
    handlers: {
      run: {
        inactivityTimeout: {hours: 1},
        abortTimeout: {minutes: 15},
      },
    },
  },
});
