// AgentSession is a Virtual Object keyed by agent id. One doTurn invocation is
// the durable agent-turn state machine and owns transient model context,
// control-signal consumption, step bounds, and pending tools. Each iteration
// spawns one bounded agent step and applies its returned data.

import type {
  ConversationCompactionPlan,
  ConversationCompactionResult,
  ConversationEntry,
  Guardrail,
  HistoryPage,
  McpServer,
} from "@restate-agents/types";
import {AgentSessionDefinition} from "@restate-agents/types/services";
import {CancelledError, TerminalError} from "@restatedev/restate-sdk";
import * as restate from "@restatedev/restate-sdk-gen";
import type {ModelMessage} from "ai";

import {Agent} from "../agent/index.js";
import {errorMessage, isCancellation} from "../errors.js";
import {
  AGENT_SESSION_SIGNALS,
  type AgentTurnOutcome,
  type AgentTurnRequest,
} from "../internal-types.js";
import {
  callGuardrailModel,
  callModel,
  compactConversation,
  type GuardrailApproval,
} from "../model/index.js";
import {executionRetention, noRetention} from "../retention.js";
import {destroySandbox} from "../sandbox/index.js";
import {objectKey} from "../state.js";
import {
  approvalGrantedMessage,
  buildModelContext,
  emptyResponseMessage,
  finalizationInstruction,
  guardrailBlockedMessage,
  mcpAvailabilityMessage,
  rejectionsResetMessage,
  steeringMessage,
  unusableResponseMessage,
} from "./context.js";
import {type DiscoveredAgentTool, discoverAgentTools} from "./dynamic-tools.js";
import type {TurnHistory} from "./history.js";
import * as history from "./history.js";
import {
  discoverMcpTools,
  type McpAgentTool,
  releaseMcpSessions,
  releaseMcpSessionsAfterCancellation,
} from "./mcp-tools.js";
import {createPendingOperations} from "./pending.js";
import {createSteeringInbox} from "./steering.js";
import {agentStep, settleStep, type ToolStep} from "./step.js";
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
  interrupt: restate.Future<string>;
  steeringInbox: ReturnType<typeof createSteeringInbox>;
  consumedSteering: number;
  steps: number;
  pending: ReturnType<typeof createPendingOperations>;
  discoveredTools: DiscoveredAgentTool[];
  mcpTools: McpAgentTool[];
  mcpServers: McpServer[];
};

const MAX_STEPS = 50;

/**
 * Durable per-Agent conversation transcript and active Turn execution boundary.
 */
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
        .sendClient(AgentSession, objectKey())
        .applyCompaction(result);
    },

    /** Applies a summary only when it matches the reserved transcript range. */
    *applyCompaction(
      result: ConversationCompactionResult,
    ): restate.Operation<void> {
      yield* history.finishCompaction(result);
    },

    /**
     * Destroys the retired agent's sandbox and files. Exclusive, so it runs
     * after any active turn has suspended the sandbox.
     */
    *retire(): restate.Operation<void> {
      yield* destroySandbox();
    },

    /**
     * Executes one complete durable conversation turn and reports exactly one
     * outcome to the Agent on every exit. The invocation owns the model
     * context, step bound, steering, interruption, pending operations and,
     * while it runs, the agent's sandbox.
     */
    *doTurn(req: AgentTurnRequest): restate.Operation<AgentTurnOutcome> {
      const turnId = restate.handlerRequest().id;
      let transcript: TurnHistory | undefined;
      let state: AgentSessionState | undefined;
      let outcome: AgentTurnOutcome;
      try {
        // History is opened once for the whole invocation. The controller
        // already chose the starting entries and immutable turn profile.
        transcript = yield* history.openTurn();
        yield* transcript.append(...req.entries);
        state = startState(req, turnId, transcript);
        outcome = yield* executeTurn(state);
      } catch (error) {
        if (error instanceof CancelledError) {
          yield* abandonTurn(turnId, transcript, state, error);
          throw error;
        }
        if (state)
          yield* appendToolTranscript(state, yield* state.pending.stop(error));
        outcome = {
          turnId,
          status: "failed",
          error: errorMessage(error),
          consumedSteering: state?.consumedSteering ?? 0,
        };
      }

      if (state && usesStatefulMcp(state)) yield* releaseMcpSessions(turnId);
      if (state) yield* state.context.sandbox.release();
      // The controller reconciles late steering and interruption before the
      // outcome is recorded in the public transcript.
      const reconciled = yield* restate
        .client(Agent, objectKey())
        .onTurnEnd(outcome);
      if (reconciled && transcript) {
        yield* transcript.append(...outcomeEntries(reconciled));
        const compaction = yield* transcript.beginCompaction();
        if (compaction)
          yield* restate
            .sendClient(AgentSession, objectKey())
            .compact(compaction);
      }
      return reconciled ?? outcome;
    },
  },
  options: {
    handlers: {
      history: {shared: true, ...noRetention},
      compact: {shared: true, ...noRetention},
      applyCompaction: noRetention,
      retire: executionRetention,
      doTurn: {
        ...executionRetention,
        inactivityTimeout: {hours: 1},
        abortTimeout: {minutes: 15},
      },
    },
  },
});

function startState(
  req: AgentTurnRequest,
  turnId: string,
  transcript: TurnHistory,
): AgentSessionState {
  const conversation = transcript.context();
  const modelContext = buildModelContext(
    conversation.entries,
    conversation.summary,
    req.memories,
    req.agentName,
  );
  return {
    context: agentTools.createAgentToolContext(
      objectKey(),
      turnId,
      req.webSearchEnabled,
      req.tools,
    ),
    transcript,
    instructions: req.instructions,
    guardrails: req.guardrails,
    approvedActions: [],
    rejectedGuardrails: new Set(),
    blockedGuardrails: new Set(),
    messages: modelContext.messages,
    guardrailInput: modelContext.guardrailInput,
    guardrailEvidenceFrom: modelContext.guardrailEvidenceFrom,
    interrupt: restate.signal<string>(AGENT_SESSION_SIGNALS.interrupt),
    steeringInbox: createSteeringInbox(),
    consumedSteering: 0,
    steps: 0,
    pending: createPendingOperations(),
    discoveredTools: [],
    mcpTools: [],
    mcpServers: req.mcpServers,
  };
}

/**
 * Cleanup after invocation cancellation. The coroutine tree is already
 * cancelled, so nothing here waits on child tasks: it records what was
 * running, appends the interruption, suspends the sandbox and tells the Agent
 * one way.
 */
function* abandonTurn(
  turnId: string,
  transcript: TurnHistory | undefined,
  state: AgentSessionState | undefined,
  error: CancelledError,
): restate.Operation<void> {
  if (state && usesStatefulMcp(state))
    releaseMcpSessionsAfterCancellation(turnId);
  const outcome: AgentTurnOutcome = {
    turnId,
    status: "interrupted",
    reason: "Turn cancelled",
    consumedSteering: state?.consumedSteering ?? 0,
  };
  const stopped = state?.pending.cancelAll(error) ?? [];
  if (transcript)
    yield* transcript.append(
      ...(state ? toolTranscriptEntries(state, stopped) : []),
      ...outcomeEntries(outcome),
    );
  if (state) yield* state.context.sandbox.release();
  yield* restate.sendClient(Agent, objectKey()).onTurnEnd(outcome);
}

function usesStatefulMcp(state: AgentSessionState): boolean {
  return state.mcpServers.some(({protocol}) => protocol === "stateful");
}

/**
 * Runs the iterative model/tool state machine for one Turn.
 *
 * The caller retains the mutable state reference so partially completed work
 * remains available for failure and cancellation cleanup.
 */
function* executeTurn(
  state: AgentSessionState,
): restate.Operation<AgentTurnOutcome> {
  state.discoveredTools = yield* discoverAgentTools(agentTools.names);
  const mcpDiscovery = yield* discoverMcpTools(
    state.mcpServers,
    {
      agentId: state.context.agentId,
      turnId: state.context.turnId,
    },
    [...agentTools.names, ...state.discoveredTools.map(({name}) => name)],
  );
  state.mcpTools = mcpDiscovery.tools;
  if (mcpDiscovery.servers.length > 0) {
    state.messages.push(mcpAvailabilityMessage(mcpDiscovery.servers));
  }

  let consecutiveModelErrors = 0;
  while (state.steps < MAX_STEPS) {
    // Steering received after the previous step's drain belongs before this
    // model round. This is the stable hand-off boundary between rounds.
    yield* consumeSteering(state);

    yield* reportProgress(state, "thinking", "Thinking...");

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
        discoveredTools: state.discoveredTools,
        mcpTools: state.mcpTools,
        pending: state.pending,
        steering: state.steeringInbox.ready,
      }),
    );
    const step = yield* settleStep(task, state.interrupt);

    if (step.type === "interrupted") {
      if (step.tools) {
        const toolStep = step.tools;
        // Approvals the interrupted step obtained still cover the guardrail
        // check on the finalization text; no approval message is pushed
        // during shutdown.
        state.approvedActions.push(...toolStep.approvedActions);
        yield* appendToolTranscript(state, toolStep.pendingEvents);
        yield* appendToolTranscript(state, toolStep.outcomes, step.reason);
        state.messages.push(
          toolStep.action.message,
          agentTools.toModelMessage(toolStep.outcomes),
          ...toolStep.pendingEvents.map(agentTools.toRuntimeMessage),
          ...toolStep.outcomes.flatMap((outcome): ModelMessage[] =>
            outcome.status === "pending"
              ? [
                  agentTools.toRuntimeMessage({
                    step: toolStep.step,
                    call: outcome.call,
                    outcome: {status: "cancelled", reason: step.reason},
                  }),
                ]
              : [],
          ),
        );
        yield* reportToolsFinished(state, toolStep, toolStep.outcomes, true);
      }
      return yield* finalizeEarlyExit(state, {
        status: "interrupted",
        reason: step.reason,
      });
    }

    const steering = state.steeringInbox.drain();
    state.steps += 1;
    if (steering.length === 0 || step.type === "tools") {
      state.approvedActions.push(...step.approvedActions);
      state.messages.push(...step.approvedActions.map(approvalGrantedMessage));
      for (const guardrailId of step.rejectedGuardrails) {
        state.rejectedGuardrails.add(guardrailId);
      }
    }

    // Only a tool step has side effects worth retaining when steering arrived
    // during the step. Every other proposal is stale and is replaced by a new
    // model round over the steering update.
    if (steering.length > 0 && step.type !== "tools") {
      consecutiveModelErrors = 0;
      yield* consumeSteering(state, steering);
      continue;
    }

    if (step.type !== "error") consecutiveModelErrors = 0;
    switch (step.type) {
      case "error":
        // Output recovery already ran inside callModel. Never restart it
        // from this loop or spend the remaining 50 steps making no progress.
        if (step.code === "output_limit")
          throw new TerminalError(
            `${step.message} The turn stopped after bounded output recovery; completed tool results remain in the conversation.`,
          );
        if (++consecutiveModelErrors >= 3)
          throw new TerminalError(
            `The model returned unusable responses three times in a row. Last error: ${step.message}`,
          );
        state.messages.push(unusableResponseMessage(step.message));
        continue;

      case "text": {
        if (!step.content.trim()) {
          state.messages.push(emptyResponseMessage);
          continue;
        }
        if (state.pending.size === 0) {
          return {
            turnId: state.context.turnId,
            status: "completed",
            response: step.content,
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
          continue;
        }
        if (next.type === "completion") {
          yield* appendToolTranscript(state, [next.event]);
          state.messages.push(agentTools.toRuntimeMessage(next.event));
          continue;
        }

        state.messages.push({
          role: "assistant",
          content: step.content,
        });
        return yield* finalizeEarlyExit(state, {
          status: "interrupted",
          reason: next.reason,
        });
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
        state.messages.push(
          guardrailBlockedMessage(step.guardrailId, step.reason),
        );
        continue;

      case "tools":
        yield* appendToolTranscript(state, step.pendingEvents);
        yield* appendToolTranscript(state, step.outcomes);
        {
          const applied = yield* state.pending.apply(
            step.outcomes,
            state.context,
            step.step,
            step.handoffs,
          );
          yield* appendToolTranscript(state, applied.events);
          state.messages.push(
            step.action.message,
            agentTools.toModelMessage(applied.outcomes),
            ...step.pendingEvents.map(agentTools.toRuntimeMessage),
            ...applied.events.map(agentTools.toRuntimeMessage),
          );
          yield* consumeSteering(state, steering);
          yield* reportToolsFinished(state, step, applied.outcomes);
        }
        continue;
    }
  }

  return yield* finalizeEarlyExit(state, {
    status: "stopped",
    cause: "step_limit",
    reason: `The agent reached its ${MAX_STEPS}-step limit.`,
  });
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

function* reportToolsFinished(
  state: AgentSessionState,
  step: ToolStep,
  outcomes: ToolOutcome[],
  interrupted = false,
): restate.Operation<void> {
  yield* state.transcript.append(
    agentTools.toolsEvent(
      state.context.turnId,
      step.step,
      "finished",
      outcomes.map((outcome) =>
        agentTools.toolActivity(
          outcome.call,
          interrupted &&
            (outcome.status === "pending" ||
              (outcome.status === "failed" &&
                outcome.error.startsWith("interrupted before completion:")))
            ? "cancelled"
            : outcome.status === "cancel_requested"
              ? "failed"
              : outcome.status,
        ),
      ),
    ),
  );
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
    if (!("outcome" in event)) return entries;
    return [
      ...entries,
      agentTools.toolsEvent(state.context.turnId, event.step, "finished", [
        agentTools.toolActivity(event.call, event.outcome.status),
      ]),
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

function currentGuardrailContext(state: AgentSessionState): ModelMessage[] {
  if (!state.guardrailInput) {
    return [];
  }
  return [
    state.guardrailInput,
    ...state.messages.slice(state.guardrailEvidenceFrom),
  ];
}

type EarlyExit =
  | {status: "interrupted"; reason: string}
  | {
      status: "stopped";
      cause: "step_limit";
      reason: string;
    };

function* finalizeEarlyExit(
  state: AgentSessionState,
  exit: EarlyExit,
): restate.Operation<AgentTurnOutcome> {
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
      instructions: state.instructions,
      messages: state.messages,
      tools: [],
    });
    if (final.type === "text" && final.content.trim()) {
      if (state.guardrails.length === 0) {
        response = final.content;
      } else {
        const decision = yield* callGuardrailModel({
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
    if (isCancellation(error)) throw error;
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

  state.blockedGuardrails.clear();
  if (state.rejectedGuardrails.size > 0) {
    state.rejectedGuardrails.clear();
    state.messages.push(rejectionsResetMessage);
  }

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
  state.consumedSteering += steering.length;
}

function outcomeEntries(outcome: AgentTurnOutcome): ConversationEntry[] {
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
