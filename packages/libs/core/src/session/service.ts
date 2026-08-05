// AgentSession is a Virtual Object keyed by agent id. One doTurn invocation is
// the durable agent-turn state machine and owns transient model context,
// control-signal consumption, budgets, and pending tools. Each iteration
// spawns one bounded agent step and applies its returned data.

import type {
  ConversationCompactionPlan,
  ConversationCompactionResult,
  ConversationEntry,
  Guardrail,
  HistoryPage,
} from "@restate-agents/types";
import {AgentSessionDefinition} from "@restate-agents/types/services";
import {CancelledError, TerminalError} from "@restatedev/restate-sdk";
import * as restate from "@restatedev/restate-sdk-gen";
import type {ModelMessage} from "ai";
import {Agent} from "../agent/index.js";
import {
  callContextReducer,
  callGuardrailModel,
  callModel,
  compactConversation,
  type GuardrailApproval,
} from "../gateway/index.js";
import {
  AGENT_SESSION_SIGNALS,
  type AgentSessionOutcome,
  type AgentSessionRequest,
  type AgentSessionSteering,
} from "../internal-types.js";
import {raceBranches} from "../race.js";
import {Sandbox} from "../sandbox/index.js";
import {
  buildModelContext,
  finalizationInstruction,
  steeringMessage,
} from "./context.js";
import {type DiscoveredAgentTool, discoverAgentTools} from "./dynamic-tools.js";
import type {TurnHistory} from "./history.js";
import * as history from "./history.js";
import {createPendingOperations} from "./pending.js";
import {createSteeringInbox} from "./steering.js";
import {
  agentStep,
  type GuardrailDecisions,
  settleStep,
  type ToolStep,
} from "./step.js";
import type {AgentToolContext, PendingEvent, ToolOutcome} from "./tools.js";
import * as agentTools from "./tools.js";

type AgentSessionState = {
  context: AgentToolContext;
  transcript: TurnHistory;
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

function sessionKey(): string {
  const key = restate.handlerRequest().key;
  if (!key) {
    throw new TerminalError("AgentSession handlers require an agent key");
  }
  return key;
}

function createSessionState(
  req: AgentSessionRequest,
  agentId: string,
  turnId: string,
  transcript: TurnHistory,
): AgentSessionState {
  const conversation = transcript.context();
  const modelContext = buildModelContext(
    conversation.entries,
    conversation.summary,
    req.memories,
  );
  return {
    context: agentTools.createAgentToolContext(agentId, turnId),
    transcript,
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
    interrupt: restate.signal<string>(AGENT_SESSION_SIGNALS.interrupt),
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
  state: AgentSessionState,
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
  state: AgentSessionState,
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
  state: AgentSessionState,
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
    const selected = yield* raceBranches({
      interrupt: state.interrupt,
      reduction: task,
    });
    if (selected.tag === "interrupt") {
      const reason = selected.value;
      task.interrupt(new restate.InterruptedError(reason));
      yield* restate.allSettled([task]);
      return reason;
    }

    const {summary} = selected.value;
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

type ProgressPhase = Extract<
  ConversationEntry,
  {role: "event"; type: "progress"}
>["phase"];

function* reportProgress(
  state: AgentSessionState,
  phase: ProgressPhase,
  message: string,
): restate.Operation<void> {
  yield* state.transcript.append({
    role: "event",
    type: "progress",
    turnId: state.context.turnId,
    phase,
    message,
  });
}

type TranscriptToolStatus = Exclude<
  Extract<
    ConversationEntry,
    {role: "event"; type: "tools"}
  >["calls"][number]["status"],
  undefined
>;

function transcriptToolStatus(
  outcome: ToolOutcome,
  interrupted: boolean,
): TranscriptToolStatus {
  if (
    interrupted &&
    (outcome.status === "pending" ||
      (outcome.status === "failed" &&
        outcome.error.startsWith("interrupted before completion:")))
  ) {
    return "cancelled";
  }
  return outcome.status === "cancel_requested" ? "failed" : outcome.status;
}

function* reportToolsFinished(
  state: AgentSessionState,
  step: ToolStep,
  outcomes: ToolOutcome[],
  interrupted = false,
): restate.Operation<void> {
  yield* state.transcript.append({
    role: "event",
    type: "tools",
    turnId: state.context.turnId,
    step: step.step,
    phase: "finished",
    calls: outcomes.map((outcome) => {
      const summary = agentTools.summarize(outcome.call);
      return {
        id: outcome.call.toolCallId,
        name: outcome.call.toolName,
        ...(summary ? {summary} : {}),
        status: transcriptToolStatus(outcome, interrupted),
      };
    }),
  });
}

function toolTranscriptEntries(
  state: AgentSessionState,
  events: Array<ToolOutcome | PendingEvent>,
  interruptedPendingReason?: string,
): ConversationEntry[] {
  return events.flatMap((event): ConversationEntry[] => {
    const entries = agentTools.transcriptEntries(
      event,
      state.context,
      interruptedPendingReason,
    );
    if (!("outcome" in event)) {
      return entries;
    }
    const summary = agentTools.summarize(event.call);
    return [
      ...entries,
      {
        role: "event",
        type: "tools",
        turnId: state.context.turnId,
        step: event.step,
        phase: "finished",
        calls: [
          {
            id: event.call.toolCallId,
            name: event.call.toolName,
            ...(summary ? {summary} : {}),
            status: event.outcome.status,
          },
        ],
      },
    ];
  });
}

function* appendToolTranscript(
  state: AgentSessionState,
  events: Array<ToolOutcome | PendingEvent>,
  interruptedPendingReason?: string,
): restate.Operation<void> {
  yield* state.transcript.append(
    ...toolTranscriptEntries(state, events, interruptedPendingReason),
  );
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
  state: AgentSessionState,
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

function resetGuardrailRejectionsForSteering(state: AgentSessionState): void {
  state.blockedGuardrails.clear();
  if (state.rejectedGuardrails.size === 0) {
    return;
  }
  state.rejectedGuardrails.clear();
  state.messages.push({
    role: "user",
    content:
      "[Runtime guardrail] Prior human rejections do not automatically apply to the new steering update; policies will evaluate the updated action again.",
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

function currentGuardrailContext(state: AgentSessionState): ModelMessage[] {
  if (!state.guardrailInput) {
    return [];
  }
  return [
    state.guardrailInput,
    ...state.messages.slice(state.guardrailEvidenceFrom),
  ];
}

function* applySteeringMessages(
  state: AgentSessionState,
  steering: AgentSessionSteering[],
): restate.Operation<void> {
  for (const signal of steering) {
    const queuedMessages = signal.queued.filter(
      ({role}) => role === "user",
    ).length;
    yield* state.transcript.append(
      ...signal.queued,
      {
        role: "user",
        text: signal.message,
        delivery: "steer",
      },
      {
        role: "event",
        type: "steer",
        turnId: state.context.turnId,
        queuedMessages,
      },
    );
  }

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
  state: AgentSessionState,
  exit: EarlyExit,
): restate.Operation<AgentSessionOutcome> {
  yield* reportProgress(
    state,
    "finalizing",
    "Stopping unfinished work before finalization",
  );
  const stopped = yield* state.pending.stop(
    new restate.InterruptedError(exit.reason),
  );
  yield* appendToolTranscript(state, stopped);
  state.messages.push(...stopped.map(agentTools.toRuntimeMessage));
  state.messages.push(finalizationInstruction(exit.reason));
  yield* reportProgress(
    state,
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

function* consumeSteering(
  state: AgentSessionState,
  steering = state.steeringInbox.drain(),
): restate.Operation<void> {
  if (steering.length === 0) {
    return;
  }
  resetGuardrailRejectionsForSteering(state);
  yield* applySteeringMessages(state, steering);
  state.consumedSteering += steering.length;
}

// Text is a candidate final answer. Pending work keeps the state machine alive
// until a completion, steering update, or interruption chooses the next move.
function* applyText(
  state: AgentSessionState,
  text: string,
): restate.Operation<AgentSessionOutcome | undefined> {
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
    state,
    "waiting",
    `Waiting for ${state.pending.size} pending operation(s): ${state.pending.describe()}`,
  );
  const next = yield* state.pending.next(
    state.steeringInbox.ready,
    state.interrupt,
  );
  if (next.type === "steering") {
    yield* consumeSteering(state);
    return undefined;
  }
  if (next.type === "completion") {
    yield* appendToolTranscript(state, [next.event]);
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
  state: AgentSessionState,
  step: ToolStep,
  steering: AgentSessionSteering[],
): restate.Operation<void> {
  yield* appendToolTranscript(state, step.outcomes);
  const applied = yield* state.pending.apply(
    step.outcomes,
    state.context,
    step.step,
  );
  yield* appendToolTranscript(state, applied.events);
  state.messages.push(
    step.action.message,
    agentTools.toModelMessage(applied.outcomes),
    ...applied.events.map(agentTools.toRuntimeMessage),
  );
  yield* consumeSteering(state, steering);
  yield* reportToolsFinished(state, step, applied.outcomes);
}

function retainInterruptedTools(
  state: AgentSessionState,
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
              step: step.step,
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
function* executeTurn(
  state: AgentSessionState,
): restate.Operation<AgentSessionOutcome> {
  state.discoveredTools = yield* discoverAgentTools(agentTools.names);

  while (state.steps < MAX_STEPS) {
    // Steering received after the previous step's drain belongs before this
    // model round. This is the stable hand-off boundary between rounds.
    yield* consumeSteering(state);

    const interruptedWhileReducing = yield* reduceCurrentContext(state);
    if (interruptedWhileReducing) {
      return yield* finalizeEarlyExit(state, {
        status: "interrupted",
        reason: interruptedWhileReducing,
      });
    }

    yield* reportProgress(state, "thinking", "Thinking...");

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
        transcript: state.transcript,
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
        yield* appendToolTranscript(state, step.tools.outcomes, step.reason);
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
    const steering = state.steeringInbox.drain();
    state.steps += 1;
    if (steering.length === 0 || step.type === "tools") {
      commitGuardrailDecisions(state, step);
    }

    // Only a tool step has side effects worth retaining when steering arrived
    // during the step. Every other proposal is stale and is replaced by a new
    // model round over the steering update.
    if (steering.length > 0 && step.type !== "tools") {
      yield* consumeSteering(state, steering);
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

function outcomeEntries(outcome: AgentSessionOutcome): ConversationEntry[] {
  switch (outcome.status) {
    case "completed":
      return [
        {
          role: "assistant",
          text: outcome.response,
          turnId: outcome.turnId,
          status: "completed",
        },
      ];

    case "interrupted":
      return [
        {
          role: "event",
          type: "interrupt",
          turnId: outcome.turnId,
          reason: outcome.reason,
        },
        ...(outcome.response
          ? [
              {
                role: "assistant" as const,
                text: outcome.response,
                turnId: outcome.turnId,
                status: "interrupted" as const,
              },
            ]
          : []),
      ];

    case "stopped":
      return [
        {
          role: "event",
          type: "stop",
          turnId: outcome.turnId,
          cause: outcome.cause,
          reason: outcome.reason,
        },
        {
          role: "assistant",
          text: outcome.response,
          turnId: outcome.turnId,
          status: "stopped",
        },
      ];

    case "failed":
      return [
        {
          role: "assistant",
          text: outcome.error,
          turnId: outcome.turnId,
          status: "failed",
        },
      ];
  }
}

export const AgentSession = restate.implement(AgentSessionDefinition, {
  handlers: {
    /** Returns one page from this AgentSession's authoritative transcript. */
    *history({fromSequence, limit}): restate.Operation<HistoryPage> {
      return yield* history.page(fromSequence, limit);
    },

    /** Summarizes one reserved transcript prefix without blocking writers. */
    *compact(plan: ConversationCompactionPlan): restate.Operation<void> {
      const input = yield* history.readCompaction(plan);
      if (!input) {
        return;
      }
      const result = yield* compactConversation(input);
      yield* restate
        .sendClient(AgentSession, sessionKey())
        .applyCompaction(result);
    },

    /** Applies a summary only when it matches the reserved transcript range. */
    *applyCompaction(
      result: ConversationCompactionResult,
    ): restate.Operation<void> {
      yield* history.finishCompaction(result);
    },

    /**
     * Executes one complete durable conversation Turn.
     *
     * The invocation owns transient model context, tool and step budgets,
     * steering consumption, interruption, pending operations, and the
     * agent-scoped sandbox lease. It releases the sandbox and reports exactly
     * one terminal outcome to the owning Agent on every handled exit.
     *
     * External cancellation is caught at the handler boundary, where pending
     * tools are stopped, an interrupted outcome is reported, and cancellation
     * is rethrown to preserve Restate semantics.
     */
    *doTurn(req: AgentSessionRequest): restate.Operation<void> {
      const agentId = sessionKey();
      const turnId = restate.handlerRequest().id;
      let state: AgentSessionState | undefined;
      let transcript: TurnHistory | undefined;
      let outcome: AgentSessionOutcome;
      try {
        transcript = yield* history.openTurn();
        yield* transcript.append(...req.entries);
        state = createSessionState(req, agentId, turnId, transcript);
        outcome = yield* executeTurn(state);
      } catch (error) {
        if (error instanceof CancelledError) {
          outcome = {
            turnId,
            status: "interrupted",
            reason: "Turn cancelled",
            consumedSteering: state?.consumedSteering ?? 0,
          };

          // Cancellation may reject every later parked operation. Record all
          // local state synchronously before each best-effort send, and never
          // wait for already-cancelled child tasks.
          const stopped = state?.pending.cancelAll(error) ?? [];
          if (transcript) {
            try {
              yield* transcript.append(
                ...(state ? toolTranscriptEntries(state, stopped) : []),
                ...outcomeEntries(outcome),
              );
            } catch {
              // State writes precede the notification wait; reconciliation
              // below remains the authoritative controller cleanup.
            }
          }
          try {
            yield* restate.sendClient(Sandbox, agentId).release({turnId});
          } catch {
            // The durable one-way call is emitted before its acknowledgement.
          }
          try {
            yield* restate.sendClient(Agent, agentId).onTurnEnd(outcome);
          } catch {
            // The Agent invocation remains durable even if cancellation wins
            // the local acknowledgement race.
          }
          throw error;
        }

        if (state) {
          const stopped = yield* state.pending.stop(error);
          yield* appendToolTranscript(state, stopped);
        }
        outcome = {
          turnId,
          status: "failed",
          error: errorMessage(error),
          consumedSteering: state?.consumedSteering ?? 0,
        };
      }

      yield* restate.client(Sandbox, agentId).release({turnId});
      const reconciled = yield* restate
        .client(Agent, agentId)
        .onTurnEnd(outcome);
      if (reconciled && transcript) {
        yield* transcript.append(...outcomeEntries(reconciled));
        const compaction = yield* transcript.beginCompaction();
        if (compaction) {
          yield* restate.sendClient(AgentSession, agentId).compact(compaction);
        }
      }
    },
  },
  options: {
    handlers: {
      history: {
        shared: true,
        idempotencyRetention: 0,
        journalRetention: 0,
      },
      compact: {
        shared: true,
        idempotencyRetention: 0,
        journalRetention: 0,
      },
      applyCompaction: {
        idempotencyRetention: 0,
        journalRetention: 0,
      },
      doTurn: {
        inactivityTimeout: {hours: 1},
        abortTimeout: {minutes: 15},
      },
    },
  },
});
