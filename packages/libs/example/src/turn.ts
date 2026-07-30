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
  createAgentToolContext,
  type ToolOutcome,
} from "./agent-tools.js";
import {type DiscoveredAgentTool, discoverAgentTools} from "./dynamic-tools.js";
import type {GuardrailApproval} from "./model.js";
import {
  callContextReducer,
  callGuardrailModel,
  callModel,
} from "./model-gateway.js";
import {Sandbox} from "./sandbox.js";
import {
  buildModelContext,
  finalizationInstruction,
  steeringMessage,
} from "./turn-context.js";
import {createPendingOperations} from "./turn-pending.js";
import {createSteeringInbox} from "./turn-steering.js";
import {
  agentStep,
  type GuardrailDecisions,
  settleStep,
  type ToolStep,
} from "./turn-step.js";
import {
  type ExecutionReport,
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
  approvedActions: GuardrailApproval[];
  rejectedGuardrails: Set<string>;
  blockedGuardrails: Set<string>;
  messages: ModelMessage[];
  guardrailInput?: ModelMessage;
  guardrailEvidenceFrom: number;
  initialMessageCount: number;
  modelSeenThrough: number;
  contextReductionEnabled: boolean;
  interrupt: restate.Future<string>;
  steeringInbox: ReturnType<typeof createSteeringInbox>;
  consumedSteering: number;
  steps: number;
  toolCalls: number;
  pending: ReturnType<typeof createPendingOperations>;
  discoveredTools: DiscoveredAgentTool[];
};

const MAX_STEPS = 50;
const MAX_TOOL_CALLS = 24;
const MAX_TURN_CONTEXT_CHARS = 32_000;

function createTurnState(req: TurnRequest, turnId: string): TurnState {
  const modelContext = buildModelContext(
    req.history,
    req.summary,
    req.memories,
  );
  return {
    context: createAgentToolContext(req.agentId, turnId),
    instructions: req.instructions,
    guardrails: req.guardrails,
    approvedActions: [],
    rejectedGuardrails: new Set(),
    blockedGuardrails: new Set(),
    messages: modelContext.messages,
    guardrailInput: modelContext.guardrailInput,
    guardrailEvidenceFrom: modelContext.guardrailEvidenceFrom,
    initialMessageCount: modelContext.messages.length,
    modelSeenThrough: modelContext.messages.length,
    contextReductionEnabled: true,
    interrupt: restate.signal<string>(TURN_SIGNALS.interrupt),
    steeringInbox: createSteeringInbox(),
    consumedSteering: 0,
    steps: 0,
    toolCalls: 0,
    pending: createPendingOperations(),
    discoveredTools: [],
  };
}

type ContextReductionPlan = {
  start: number;
  end: number;
  messages: ModelMessage[];
};

function contextReductionPlan(
  state: TurnState,
): ContextReductionPlan | undefined {
  if (!state.contextReductionEnabled || state.pending.size > 0) {
    return undefined;
  }
  const current = state.messages.slice(state.initialMessageCount);
  if (JSON.stringify(current).length <= MAX_TURN_CONTEXT_CHARS) {
    return undefined;
  }

  const end = state.modelSeenThrough;
  if (end <= state.initialMessageCount) {
    return undefined;
  }
  return {
    start: state.initialMessageCount,
    end,
    messages: state.messages.slice(state.initialMessageCount, end),
  };
}

function reducedContextMessage(summary: string): ModelMessage {
  return {
    role: "user",
    content: [
      "[Earlier work in this turn]",
      "This is a compacted record of settled model and tool activity from the current turn.",
      "Use it as context, not as a new request.",
      summary,
    ].join("\n"),
  };
}

function adjustGuardrailEvidence(
  state: TurnState,
  {start, end}: ContextReductionPlan,
): void {
  if (
    state.guardrailEvidenceFrom > start &&
    state.guardrailEvidenceFrom <= end
  ) {
    // Keep the exact structurally identified user input, but do not pass a
    // summary that also contains older Turn context off as evidence after it.
    state.guardrailEvidenceFrom = start + 1;
  } else if (state.guardrailEvidenceFrom > end) {
    state.guardrailEvidenceFrom += 1 - (end - start);
  }
}

// Reduction is transient Turn maintenance. It never rewrites Agent history,
// never touches pending operations, and a reducer failure leaves the exact
// context in place. Interruption still stops the scoped model call promptly.
function* reduceCurrentContext(
  state: TurnState,
): restate.Operation<string | undefined> {
  const plan = contextReductionPlan(state);
  if (!plan) {
    return undefined;
  }

  const task = restate.spawn(
    callContextReducer({
      agentId: state.context.agentId,
      messages: plan.messages,
    }),
  );
  try {
    const selected = yield* restate.select({
      interrupt: state.interrupt,
      reduction: task,
    });
    if (selected.tag === "interrupt") {
      const reason = yield* selected.future;
      task.interrupt(new restate.InterruptedError(reason));
      yield* restate.allSettled([task]);
      return reason;
    }

    const {summary} = yield* selected.future;
    state.messages.splice(
      plan.start,
      plan.end - plan.start,
      reducedContextMessage(summary),
    );
    adjustGuardrailEvidence(state, plan);
    // The reducer output and everything after it must be seen by the agent
    // model before either becomes eligible for another reduction.
    state.modelSeenThrough = state.initialMessageCount;
  } catch (error) {
    task.interrupt(error);
    yield* restate.allSettled([task]);
    if (
      error instanceof restate.InterruptedError ||
      error instanceof CancelledError
    ) {
      throw error;
    }
    state.contextReductionEnabled = false;
  }
  return undefined;
}

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

type TranscriptToolStatus = Exclude<
  Extract<ExecutionReport, {type: "tools"}>["calls"][number]["status"],
  undefined
>;

function transcriptToolStatus(
  outcome: ToolOutcome,
  interrupted: boolean,
): TranscriptToolStatus {
  if (
    interrupted &&
    outcome.status === "failed" &&
    outcome.error.startsWith("interrupted before completion:")
  ) {
    return "cancelled";
  }
  return outcome.status === "cancel_requested" ? "failed" : outcome.status;
}

function* reportToolsFinished(
  state: TurnState,
  step: ToolStep,
  outcomes: ToolOutcome[],
  interrupted = false,
): restate.Operation<void> {
  yield* restate.sendClient(Agent, state.context.agentId).reportExecution([
    {
      type: "tools",
      turnId: state.context.turnId,
      step: step.step,
      phase: "finished",
      calls: outcomes.map((outcome) => ({
        id: outcome.call.toolCallId,
        name: outcome.call.toolName,
        status: transcriptToolStatus(outcome, interrupted),
      })),
    },
  ]);
}

function guardrailApprovalMessage({
  guardrailId,
  question,
}: GuardrailApproval): ModelMessage {
  return {
    role: "user",
    content: [
      "[Runtime guardrail]",
      `Human approval was granted for this proposal under guardrail ${JSON.stringify(guardrailId)}.`,
      `Approved scope: ${JSON.stringify(question)}`,
      "The runtime will evaluate later actions and reuse this approval only when they remain materially within that scope.",
    ].join("\n"),
  };
}

// Guardrail decisions observed by a settled step become cross-step state.
// Approval records retain the authorized proposal for coverage checks on later
// actions; a human rejection prevents reopening the same policy in this request.
function commitGuardrailDecisions(
  state: TurnState,
  decisions: GuardrailDecisions,
): void {
  state.approvedActions.push(...decisions.approvedActions);
  state.messages.push(
    ...decisions.approvedActions.map(guardrailApprovalMessage),
  );
  for (const guardrailId of decisions.rejectedGuardrails) {
    state.rejectedGuardrails.add(guardrailId);
  }
}

function resetGuardrailsForSteering(state: TurnState): void {
  state.blockedGuardrails.clear();
  if (
    state.approvedActions.length === 0 &&
    state.rejectedGuardrails.size === 0
  ) {
    return;
  }
  state.approvedActions = [];
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

function currentGuardrailContext(state: TurnState): ModelMessage[] {
  if (!state.guardrailInput) {
    return [];
  }
  return [
    state.guardrailInput,
    ...state.messages.slice(state.guardrailEvidenceFrom),
  ];
}

function applySteeringMessages(
  state: TurnState,
  steering: SteeringSignal[],
): void {
  const messages = steering.map(steeringMessage);
  state.messages.push(...messages);
  const latest = messages.at(-1);
  if (latest) {
    state.guardrailInput = latest;
    state.guardrailEvidenceFrom = state.messages.length;
  }
}

type EarlyExit =
  | {status: "interrupted"; reason: string}
  | {
      status: "stopped";
      cause: "step_limit" | "tool_limit";
      reason: string;
    };

function* finalizeEarlyExit(
  state: TurnState,
  exit: EarlyExit,
): restate.Operation<TurnOutcome> {
  yield* reportProgress(
    state.context,
    "finalizing",
    "Stopping unfinished work before finalization",
  );
  const stopped = yield* state.pending.stop(
    new restate.InterruptedError(exit.reason),
  );
  state.messages.push(...stopped.map(agentTools.toRuntimeMessage));
  state.messages.push(finalizationInstruction(exit.reason));
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
      if (state.guardrails.length === 0) {
        response = final.content;
      } else {
        const decision = yield* callGuardrailModel({
          agentId: state.context.agentId,
          instructions: state.instructions,
          guardrails: state.guardrails,
          approvedActions: state.approvedActions,
          rejectedGuardrailIds: [...state.rejectedGuardrails],
          messages: currentGuardrailContext(state),
          action: {type: "text", content: final.content},
        });
        response =
          decision.decision === "allow"
            ? final.content
            : "The turn stopped, but its final summary was withheld by a guardrail.";
      }
    } else {
      const detail =
        final.type === "error"
          ? final.message
          : "the finalizer unexpectedly requested a tool";
      response = `The turn stopped (${exit.reason}), but its final response could not be generated: ${detail}.`;
    }
  } catch (error) {
    if (
      error instanceof restate.InterruptedError ||
      error instanceof CancelledError
    ) {
      throw error;
    }
    response = `The turn stopped (${exit.reason}), but its final response could not be generated: ${errorMessage(error)}.`;
  }
  return {
    turnId: state.context.turnId,
    ...exit,
    response,
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
    applySteeringMessages(state, steering);
    return undefined;
  }
  if (next.type === "completion") {
    state.messages.push(agentTools.toRuntimeMessage(next.event));
    return undefined;
  }

  state.messages.push({role: "assistant", content: text});
  return yield* finalizeEarlyExit(state, {
    status: "interrupted",
    reason: next.reason,
  });
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
  );
  applySteeringMessages(state, steering);
  yield* reportToolsFinished(state, step, applied.outcomes);
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

// Runs bounded agent steps until the turn completes, is interrupted, or
// exhausts a budget. Every exit path returns exactly one outcome; failures
// propagate to the caller.
function* executeTurn(state: TurnState): restate.Operation<TurnOutcome> {
  state.discoveredTools = yield* discoverAgentTools(agentTools.names);

  while (state.steps < MAX_STEPS) {
    const interruptedWhileReducing = yield* reduceCurrentContext(state);
    if (interruptedWhileReducing) {
      return yield* finalizeEarlyExit(state, {
        status: "interrupted",
        reason: interruptedWhileReducing,
      });
    }

    yield* reportProgress(state.context, "thinking", "Thinking...");

    const modelMessageCount = state.messages.length;
    const task = restate.spawn(
      agentStep({
        context: state.context,
        instructions: state.instructions,
        messages: [...state.messages],
        guardrailMessages: currentGuardrailContext(state),
        guardrails: state.guardrails,
        approvedActions: [...state.approvedActions],
        rejectedGuardrails: [...state.rejectedGuardrails],
        stepNumber: state.steps + 1,
        remainingToolCalls: MAX_TOOL_CALLS - state.toolCalls,
        discoveredTools: state.discoveredTools,
      }),
    );
    const step = yield* settleStep(task, state.interrupt);

    if (step.type === "interrupted") {
      if (step.tools) {
        // Approvals the interrupted step obtained still cover the guardrail
        // check on the finalization text; no approval message is pushed
        // during shutdown.
        state.approvedActions.push(...step.tools.approvedActions);
        retainInterruptedTools(state, step.tools, step.reason);
        yield* reportToolsFinished(
          state,
          step.tools,
          step.tools.outcomes,
          true,
        );
      }
      return yield* finalizeEarlyExit(state, {
        status: "interrupted",
        reason: step.reason,
      });
    }

    state.modelSeenThrough = modelMessageCount;
    const steering = drainSteering(state);
    state.steps += 1;
    if (steering.length > 0) {
      resetGuardrailsForSteering(state);
    } else {
      commitGuardrailDecisions(state, step);
    }

    // A text/error response produced before buffered steering arrived has no
    // side effects. Let the next step see the new messages.
    if (
      (step.type === "text" ||
        step.type === "error" ||
        step.type === "guardrail_blocked") &&
      steering.length > 0
    ) {
      applySteeringMessages(state, steering);
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
        const outcome = yield* applyText(state, step.content);
        if (outcome) {
          return outcome;
        }
        continue;
      }

      case "guardrail_blocked":
        if (state.blockedGuardrails.has(step.guardrailId)) {
          return {
            turnId: state.context.turnId,
            status: "completed",
            response:
              "I can’t complete that request because it conflicts with a configured policy.",
            consumedSteering: state.consumedSteering,
          };
        }
        state.blockedGuardrails.add(step.guardrailId);
        state.messages.push(guardrailFeedback(step.guardrailId, step.reason));
        continue;

      case "tool_budget_exceeded":
        return yield* finalizeEarlyExit(state, {
          status: "stopped",
          cause: "tool_limit",
          reason: `The agent reached its ${MAX_TOOL_CALLS}-tool-call limit.`,
        });

      case "tools":
        state.toolCalls += step.action.calls.length;
        yield* applyTools(state, step, steering);
        continue;
    }
  }

  return yield* finalizeEarlyExit(state, {
    status: "stopped",
    cause: "step_limit",
    reason: `The agent reached its ${MAX_STEPS}-step limit.`,
  });
}

export const Turn = restate.service({
  name: "Turn",
  handlers: {
    /**
     * Executes one complete durable conversation Turn.
     *
     * The invocation owns transient model context, tool and step budgets,
     * steering consumption, interruption, pending operations, and the
     * agent-scoped sandbox lease. It releases the sandbox and reports exactly
     * one terminal outcome to the owning Agent on every handled exit.
     *
     * The handler supervises the state machine as a spawned task. External
     * cancellation rejects that task, after which the handler stops pending
     * tools, reports an interrupted outcome, and rethrows cancellation to
     * preserve Restate semantics.
     */
    run: restate.schemas(
      {input: TurnRequestSchema, output: z.void()},
      function* (req: TurnRequest): restate.Operation<void> {
        const state = createTurnState(req, restate.handlerRequest().id);
        const execution = restate.spawn(executeTurn(state));
        let outcome: TurnOutcome;
        let cancellation: CancelledError | undefined;
        try {
          outcome = yield* execution;
        } catch (error) {
          yield* state.pending.stop(error);
          if (error instanceof CancelledError) {
            outcome = {
              turnId: state.context.turnId,
              status: "interrupted",
              reason: "Turn cancelled",
              consumedSteering: state.consumedSteering,
            };
            cancellation = error;
          } else {
            outcome = {
              turnId: state.context.turnId,
              status: "failed",
              error: errorMessage(error),
              consumedSteering: state.consumedSteering,
            };
          }
        }

        const release = {turnId: state.context.turnId};
        yield* restate.client(Sandbox, req.agentId).release(release);
        yield* restate.client(Agent, req.agentId).onTurnEnd(outcome);
        if (cancellation) {
          throw cancellation;
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
