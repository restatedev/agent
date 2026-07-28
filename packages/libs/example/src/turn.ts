// One Turn invocation is the durable agent-turn state machine. It owns the
// transient model context, control-signal cursor, budgets, and pending tools.
// Each iteration spawns one bounded agent step and applies its returned data.

import {CancelledError} from "@restatedev/restate-sdk";
import * as restate from "@restatedev/restate-sdk-gen";
import type {ModelMessage} from "ai";
import {z} from "zod";
import {Agent} from "./agent.js";
import {
  type AgentToolContext,
  agentTools,
  type ToolOutcome,
} from "./agent-tools.js";
import {callGuardrailModel, callModel} from "./model-gateway.js";
import {
  buildModelContext,
  interruptionInstruction,
  steeringMessage,
} from "./turn-context.js";
import {createPendingOperations} from "./turn-pending.js";
import {createSteeringInbox} from "./turn-steering.js";
import {agentStep, settleStep, type ToolStep} from "./turn-step.js";
import {
  type Guardrail,
  type ProgressReport,
  type SteeringSignal,
  TURN_SIGNALS,
  type TurnOutcome,
  type TurnRequest,
  TurnRequestSchema,
} from "./types.js";

type TurnState = {
  context: AgentToolContext;
  instructions?: string;
  guardrails: Guardrail[];
  approvedGuardrails: Set<string>;
  rejectedGuardrails: Set<string>;
  blockedGuardrails: Set<string>;
  messages: ModelMessage[];
  interrupt: restate.Future<string>;
  steeringInbox: ReturnType<typeof createSteeringInbox>;
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
): restate.Operation<void> {
  yield* restate.sendClient(Agent, context.agentId).reportProgress({
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

function rememberGuardrailApprovals(
  state: TurnState,
  guardrailIds: string[],
): void {
  for (const guardrailId of guardrailIds) {
    state.approvedGuardrails.add(guardrailId);
  }
}

function guardrailApprovalMessage(guardrailId: string): ModelMessage {
  return {
    role: "user",
    content: [
      "[Runtime guardrail]",
      `Human approval was granted for guardrail ${JSON.stringify(guardrailId)} for the current request.`,
      "The runtime will evaluate this policy again if steering changes the request.",
    ].join("\n"),
  };
}

function resetGuardrailsForSteering(state: TurnState): void {
  state.blockedGuardrails.clear();
  if (
    state.approvedGuardrails.size === 0 &&
    state.rejectedGuardrails.size === 0
  ) {
    return;
  }
  state.approvedGuardrails.clear();
  state.rejectedGuardrails.clear();
  state.messages.push({
    role: "user",
    content:
      "[Runtime guardrail] Prior human approval decisions do not apply to the new steering update; all policies will be evaluated again.",
  });
}

function guardrailFeedback(guardrailId: string, reason: string): ModelMessage {
  return {
    role: "user",
    content: [
      "[Runtime guardrail]",
      `The proposed action was blocked by guardrail ${JSON.stringify(guardrailId)}.`,
      `Reason: ${reason}`,
      "Do not repeat the blocked action. Choose a clearly compliant alternative, or return a concise tool-free refusal.",
    ].join("\n"),
  };
}

function* finalizeInterruption(
  state: TurnState,
  reason: string,
): restate.Operation<TurnOutcome> {
  yield* reportProgress(
    state.context,
    "finalizing",
    "Stopping unfinished work for graceful interruption",
  );
  const stopped = yield* state.pending.stop(
    new restate.InterruptedError(reason),
  );
  state.messages.push(...stopped.map(agentTools.toRuntimeMessage));
  state.messages.push(interruptionInstruction(reason));
  yield* reportProgress(
    state.context,
    "finalizing",
    "Preparing a final response from completed results",
  );

  let response: string;
  try {
    const final = yield* callModel({
      agentId: state.context.agentId,
      instructions: state.instructions,
      messages: state.messages,
      tools: [],
    });
    if (final.type === "text" && final.content.trim()) {
      const remaining = state.guardrails.filter(
        ({id}) => !state.approvedGuardrails.has(id),
      );
      if (remaining.length === 0) {
        response = final.content;
      } else {
        const decision = yield* callGuardrailModel({
          agentId: state.context.agentId,
          instructions: state.instructions,
          guardrails: remaining,
          rejectedGuardrailIds: [...state.rejectedGuardrails],
          messages: state.messages,
          action: {type: "text", content: final.content},
        });
        response =
          decision.decision === "allow"
            ? final.content
            : "The turn was interrupted, but its final summary was withheld by a guardrail.";
      }
    } else {
      const detail =
        final.type === "error"
          ? final.message
          : "the finalizer unexpectedly requested a tool";
      response = `The turn was interrupted (${reason}), but its final response could not be generated: ${detail}.`;
    }
  } catch (error) {
    if (
      error instanceof restate.InterruptedError ||
      error instanceof CancelledError
    ) {
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

function* failTurn(
  state: TurnState,
  error: unknown,
): restate.Operation<TurnOutcome> {
  yield* state.pending.stop(error);
  return {
    turnId: state.context.turnId,
    status: "failed",
    error: errorMessage(error),
    consumedSteering: state.consumedSteering,
  };
}

function drainSteering(state: TurnState): SteeringSignal[] {
  const steering = state.steeringInbox.drain();
  state.consumedSteering += steering.length;
  return steering;
}

// Text is a candidate final answer. Pending work keeps the state machine alive
// until a completion, steering update, or interruption chooses the next move.
function* applyText(
  state: TurnState,
  text: string,
): restate.Operation<TurnOutcome | undefined> {
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
  const next = yield* state.pending.next(
    state.steeringInbox.ready,
    state.interrupt,
  );
  if (next.type === "steering") {
    const steering = drainSteering(state);
    resetGuardrailsForSteering(state);
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
): restate.Operation<void> {
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

export const Turn = restate.service({
  name: "Turn",
  handlers: {
    // One handler invocation owns the complete transient state machine and
    // reports exactly one high-level outcome to the Agent.
    run: restate.schemas(
      {input: TurnRequestSchema, output: z.void()},
      function* (req: TurnRequest): restate.Operation<void> {
        const turnId = restate.handlerRequest().id;
        const state: TurnState = {
          context: {
            agentId: req.agentId,
            turnId,
          },
          instructions: req.instructions,
          guardrails: req.guardrails,
          approvedGuardrails: new Set(),
          rejectedGuardrails: new Set(),
          blockedGuardrails: new Set(),
          messages: buildModelContext(req.history, req.summary, req.memories),
          interrupt: restate.signal<string>(TURN_SIGNALS.interrupt),
          steeringInbox: createSteeringInbox(),
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

            const task = restate.spawn(
              agentStep({
                context: state.context,
                instructions: state.instructions,
                messages: [...state.messages],
                guardrails: state.guardrails,
                approvedGuardrails: [...state.approvedGuardrails],
                rejectedGuardrails: [...state.rejectedGuardrails],
                stepNumber: state.steps + 1,
                remainingToolCalls: MAX_TOOL_CALLS - state.toolCalls,
              }),
            );
            const step = yield* settleStep(task, state.interrupt);

            if (step.type === "interrupted") {
              if (step.tools) {
                rememberGuardrailApprovals(
                  state,
                  step.tools.approvedGuardrails,
                );
                retainInterruptedTools(state, step.tools, step.reason);
              }
              result = yield* finalizeInterruption(state, step.reason);
              break;
            }

            const steering = drainSteering(state);
            state.steps += 1;
            if (steering.length > 0) {
              resetGuardrailsForSteering(state);
            } else if ("approvedGuardrails" in step) {
              const newlyApproved = step.approvedGuardrails.filter(
                (guardrailId) => !state.approvedGuardrails.has(guardrailId),
              );
              rememberGuardrailApprovals(state, newlyApproved);
              state.messages.push(
                ...newlyApproved.map(guardrailApprovalMessage),
              );
              if ("rejectedGuardrails" in step) {
                for (const guardrailId of step.rejectedGuardrails) {
                  state.rejectedGuardrails.add(guardrailId);
                }
              }
            }

            // A text/error response produced before buffered steering arrived
            // has no side effects. Let the next step see the new messages.
            if (
              (step.type === "text" ||
                step.type === "error" ||
                step.type === "guardrail_blocked") &&
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

              case "guardrail_blocked":
                if (state.blockedGuardrails.has(step.guardrailId)) {
                  result = {
                    turnId,
                    status: "completed",
                    response:
                      "I can’t complete that request because it conflicts with a configured policy.",
                    consumedSteering: state.consumedSteering,
                  };
                  break steps;
                }
                state.blockedGuardrails.add(step.guardrailId);
                state.messages.push(
                  guardrailFeedback(step.guardrailId, step.reason),
                );
                continue;

              case "tool_budget_exceeded":
                result = yield* failTurn(
                  state,
                  new restate.InterruptedError(
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
              new restate.InterruptedError(
                `agent did not finish within ${MAX_STEPS} steps`,
              ),
            ));
          yield* restate.sendClient(Agent, req.agentId).append(outcome);
        } catch (error) {
          yield* state.pending.stop(error);
          if (error instanceof CancelledError) {
            yield* restate.sendClient(Agent, req.agentId).append({
              turnId,
              status: "interrupted",
              reason: "Turn cancelled",
              consumedSteering: state.consumedSteering,
            });
            throw error;
          }

          yield* restate.sendClient(Agent, req.agentId).append({
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
