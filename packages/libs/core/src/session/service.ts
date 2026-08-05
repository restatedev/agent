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
        const conversation = transcript.context();
        const modelContext = buildModelContext(
          conversation.entries,
          conversation.summary,
          req.memories,
        );
        state = {
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
        const turnState = state;
        outcome = yield* restate.gen(function* () {
          turnState.discoveredTools = yield* discoverAgentTools(
            agentTools.names,
          );

          while (turnState.steps < MAX_STEPS) {
            // Steering received after the previous step's drain belongs before this
            // model round. This is the stable hand-off boundary between rounds.
            yield* consumeSteering(turnState);

            // Reduction is transient Turn maintenance. It never rewrites Agent
            // history or touches pending operations. A reducer failure leaves the
            // exact context in place and disables further reduction for this Turn.
            const current = turnState.messages.slice(
              turnState.initialMessageCount,
            );
            const reductionEnd = turnState.modelSeenThrough;
            if (
              turnState.contextReductionEnabled &&
              turnState.pending.size === 0 &&
              JSON.stringify(current).length > MAX_TURN_CONTEXT_CHARS &&
              reductionEnd > turnState.initialMessageCount
            ) {
              const reductionStart = turnState.initialMessageCount;
              const task = restate.spawn(
                callContextReducer({
                  agentId: turnState.context.agentId,
                  messages: turnState.messages.slice(
                    reductionStart,
                    reductionEnd,
                  ),
                }),
              );
              let reductionInterruption: string | undefined;
              try {
                const selected = yield* raceBranches({
                  interrupt: turnState.interrupt,
                  reduction: task,
                });
                if (selected.tag === "interrupt") {
                  reductionInterruption = selected.value;
                  task.interrupt(
                    new restate.InterruptedError(reductionInterruption),
                  );
                  yield* restate.allSettled([task]);
                } else {
                  turnState.messages.splice(
                    reductionStart,
                    reductionEnd - reductionStart,
                    {
                      role: "user",
                      content: [
                        "[Earlier work in this turn]",
                        "This is a compacted record of settled model and tool activity from the current turn.",
                        "Use it as context, not as a new request.",
                        selected.value.summary,
                      ].join("\n"),
                    },
                  );
                  if (
                    turnState.guardrailEvidenceFrom > reductionStart &&
                    turnState.guardrailEvidenceFrom <= reductionEnd
                  ) {
                    // Keep exact user input as evidence; the mixed summary before it is
                    // context, not evidence about the latest request.
                    turnState.guardrailEvidenceFrom = reductionStart + 1;
                  } else if (turnState.guardrailEvidenceFrom > reductionEnd) {
                    turnState.guardrailEvidenceFrom +=
                      1 - (reductionEnd - reductionStart);
                  }
                  // The reducer output and everything after it must be seen by the
                  // model before either becomes eligible for another reduction.
                  turnState.modelSeenThrough = turnState.initialMessageCount;
                }
              } catch (error) {
                task.interrupt(error);
                yield* restate.allSettled([task]);
                if (
                  error instanceof restate.InterruptedError ||
                  error instanceof CancelledError
                ) {
                  throw error;
                }
                turnState.contextReductionEnabled = false;
              }
              if (reductionInterruption) {
                return yield* finalizeEarlyExit(turnState, {
                  status: "interrupted",
                  reason: reductionInterruption,
                });
              }
            }

            yield* reportProgress(turnState, "thinking", "Thinking...");

            const modelMessageCount = turnState.messages.length;
            const task = restate.spawn(
              agentStep({
                context: turnState.context,
                instructions: turnState.instructions,
                messages: [...turnState.messages],
                guardrailMessages: currentGuardrailContext(turnState),
                guardrails: turnState.guardrails,
                approvedActions: [...turnState.approvedActions],
                rejectedGuardrails: [...turnState.rejectedGuardrails],
                transcript: turnState.transcript,
                stepNumber: turnState.steps + 1,
                remainingToolCalls: MAX_TOOL_CALLS - turnState.toolCalls,
                discoveredTools: turnState.discoveredTools,
              }),
            );
            const step = yield* settleStep(task, turnState.interrupt);

            if (step.type === "interrupted") {
              if (step.tools) {
                const toolStep = step.tools;
                // Approvals the interrupted step obtained still cover the guardrail
                // check on the finalization text; no approval message is pushed
                // during shutdown.
                turnState.approvedActions.push(...toolStep.approvedActions);
                yield* appendToolTranscript(
                  turnState,
                  toolStep.outcomes,
                  step.reason,
                );
                turnState.messages.push(
                  toolStep.action.message,
                  agentTools.toModelMessage(toolStep.outcomes),
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
                yield* reportToolsFinished(
                  turnState,
                  toolStep,
                  toolStep.outcomes,
                  true,
                );
              }
              return yield* finalizeEarlyExit(turnState, {
                status: "interrupted",
                reason: step.reason,
              });
            }

            turnState.modelSeenThrough = modelMessageCount;
            const steering = turnState.steeringInbox.drain();
            turnState.steps += 1;
            if (steering.length === 0 || step.type === "tools") {
              turnState.approvedActions.push(...step.approvedActions);
              turnState.messages.push(
                ...step.approvedActions.map(
                  ({guardrailId, question}): ModelMessage => ({
                    role: "user",
                    content: [
                      "[Runtime guardrail]",
                      `Human approval was granted for this proposal under guardrail ${JSON.stringify(guardrailId)}.`,
                      `Approved scope: ${JSON.stringify(question)}`,
                      "The runtime will evaluate later actions and reuse this approval only when they remain materially within that scope.",
                    ].join("\n"),
                  }),
                ),
              );
              for (const guardrailId of step.rejectedGuardrails) {
                turnState.rejectedGuardrails.add(guardrailId);
              }
            }

            // Only a tool step has side effects worth retaining when steering arrived
            // during the step. Every other proposal is stale and is replaced by a new
            // model round over the steering update.
            if (steering.length > 0 && step.type !== "tools") {
              yield* consumeSteering(turnState, steering);
              continue;
            }

            switch (step.type) {
              case "error":
                turnState.messages.push({
                  role: "user",
                  content: `Your last response could not be used (${step.message}). Try again with the available tools or give a final answer.`,
                });
                continue;

              case "text": {
                if (!step.content.trim()) {
                  turnState.messages.push({
                    role: "user",
                    content:
                      "Your last response was empty. Call a tool or give a final answer.",
                  });
                  continue;
                }
                if (turnState.pending.size === 0) {
                  return {
                    turnId: turnState.context.turnId,
                    status: "completed",
                    response: step.content,
                    consumedSteering: turnState.consumedSteering,
                  };
                }

                yield* reportProgress(
                  turnState,
                  "waiting",
                  `Waiting for ${turnState.pending.size} pending operation(s): ${turnState.pending.describe()}`,
                );
                const next = yield* turnState.pending.next(
                  turnState.steeringInbox.ready,
                  turnState.interrupt,
                );
                if (next.type === "steering") {
                  yield* consumeSteering(turnState);
                  continue;
                }
                if (next.type === "completion") {
                  yield* appendToolTranscript(turnState, [next.event]);
                  turnState.messages.push(
                    agentTools.toRuntimeMessage(next.event),
                  );
                  continue;
                }

                turnState.messages.push({
                  role: "assistant",
                  content: step.content,
                });
                return yield* finalizeEarlyExit(turnState, {
                  status: "interrupted",
                  reason: next.reason,
                });
              }

              case "guardrail_blocked":
                if (turnState.blockedGuardrails.has(step.guardrailId)) {
                  return {
                    turnId: turnState.context.turnId,
                    status: "completed",
                    response:
                      "I can’t complete that request because it conflicts with a configured policy.",
                    consumedSteering: turnState.consumedSteering,
                  };
                }
                turnState.blockedGuardrails.add(step.guardrailId);
                turnState.messages.push({
                  role: "user",
                  content: [
                    "[Runtime guardrail]",
                    `The proposed action was blocked by guardrail ${JSON.stringify(step.guardrailId)}.`,
                    `Reason: ${step.reason}`,
                    "Do not repeat the blocked action. Choose a clearly compliant alternative, or return a concise tool-free refusal.",
                  ].join("\n"),
                });
                continue;

              case "tool_budget_exceeded":
                return yield* finalizeEarlyExit(turnState, {
                  status: "stopped",
                  cause: "tool_limit",
                  reason: `The agent reached its ${MAX_TOOL_CALLS}-tool-call limit.`,
                });

              case "tools":
                turnState.toolCalls += step.action.calls.length;
                yield* appendToolTranscript(turnState, step.outcomes);
                {
                  const applied = yield* turnState.pending.apply(
                    step.outcomes,
                    turnState.context,
                    step.step,
                  );
                  yield* appendToolTranscript(turnState, applied.events);
                  turnState.messages.push(
                    step.action.message,
                    agentTools.toModelMessage(applied.outcomes),
                    ...applied.events.map(agentTools.toRuntimeMessage),
                  );
                  yield* consumeSteering(turnState, steering);
                  yield* reportToolsFinished(turnState, step, applied.outcomes);
                }
                continue;
            }
          }

          return yield* finalizeEarlyExit(turnState, {
            status: "stopped",
            cause: "step_limit",
            reason: `The agent reached its ${MAX_STEPS}-step limit.`,
          });
        });
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

function sessionKey(): string {
  const key = restate.handlerRequest().key;
  if (!key) {
    throw new TerminalError("AgentSession handlers require an agent key");
  }
  return key;
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
        status:
          interrupted &&
          (outcome.status === "pending" ||
            (outcome.status === "failed" &&
              outcome.error.startsWith("interrupted before completion:")))
            ? "cancelled"
            : outcome.status === "cancel_requested"
              ? "failed"
              : outcome.status,
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

  state.blockedGuardrails.clear();
  if (state.rejectedGuardrails.size > 0) {
    state.rejectedGuardrails.clear();
    state.messages.push({
      role: "user",
      content:
        "[Runtime guardrail] Prior human rejections do not automatically apply to the new steering update; policies will evaluate the updated action again.",
    });
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
