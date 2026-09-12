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
  McpTurnCredential,
} from "@restate-agents/types";
import {AgentSessionDefinition} from "@restate-agents/types/services";
import {CancelledError, TerminalError} from "@restatedev/restate-sdk";
import * as restate from "@restatedev/restate-sdk-gen";
import type {ModelMessage} from "ai";
import {Agent} from "../agent/index.js";
import {
  callGuardrailModel,
  callModel,
  compactConversation,
  type GuardrailApproval,
} from "../gateway/index.js";
import {
  AGENT_SESSION_SIGNALS,
  type AgentTurnOutcome,
  type AgentTurnRequest,
} from "../internal-types.js";
import {Sandbox} from "../sandbox/index.js";
import {
  buildModelContext,
  finalizationInstruction,
  steeringMessage,
} from "./context.js";
import {type DiscoveredAgentTool, discoverAgentTools} from "./dynamic-tools.js";
import type {TurnHistory} from "./history.js";
import * as history from "./history.js";
import {
  discoverMcpTools,
  type McpAgentTool,
  type McpServerAvailability,
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
  mcpCredentials: McpTurnCredential[];
};

const MAX_STEPS = 50;

/**
 * Durable per-Agent conversation transcript and active Turn execution boundary.
 */
export const AgentSession = restate.implement(AgentSessionDefinition, {
  handlers: {
    /** Lightweight terminal-response cursor for the account's agent list. */
    *lastTurnSequence(): restate.Operation<number> {
      return yield* history.lastTurnSequence();
    },
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
     * The invocation owns transient model context, the step bound,
     * steering consumption, interruption, pending operations, and the
     * agent-scoped sandbox lease. It releases the sandbox and reports exactly
     * one terminal outcome to the owning Agent on every handled exit.
     *
     * External cancellation is caught at the handler boundary, where pending
     * tools are stopped, an interrupted outcome is reported, and cancellation
     * is rethrown to preserve Restate semantics.
     */
    *doTurn(req: AgentTurnRequest): restate.Operation<AgentTurnOutcome> {
      const agentId = sessionKey();
      const turnId = restate.handlerRequest().id;
      let state: AgentSessionState | undefined;
      let transcript: TurnHistory | undefined;
      let outcome: AgentTurnOutcome;
      try {
        transcript = yield* history.openTurn();
        yield* transcript.append(...req.entries);
        const conversation = transcript.context();
        const modelContext = buildModelContext(
          conversation.entries,
          conversation.summary,
          req.memories,
          req.agentName,
        );
        state = {
          context: agentTools.createAgentToolContext(
            agentId,
            turnId,
            req.webSearchEnabled,
            req.tools,
            req.ownerUserId,
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
          mcpCredentials: req.mcpCredentials,
        };
        outcome = yield* executeTurn(state);
      } catch (error) {
        if (error instanceof CancelledError) {
          if (state?.mcpServers.some(({protocol}) => protocol === "stateful")) {
            releaseMcpSessionsAfterCancellation(turnId);
          }
          outcome = {
            turnId,
            status: "interrupted",
            reason: "Turn cancelled",
            consumedSteering: state?.consumedSteering ?? 0,
          };

          // Record local state without waiting for already-cancelled child
          // tasks, then append the cancellation boundary and emit durable
          // one-way cleanup for the owning services.
          const stopped = state?.pending.cancelAll(error) ?? [];
          if (transcript) {
            yield* transcript.append(
              ...(state ? toolTranscriptEntries(state, stopped) : []),
              ...outcomeEntries(outcome),
            );
          }
          yield* restate.sendClient(Sandbox, agentId).release({turnId});
          yield* restate.sendClient(Agent, agentId).onTurnEnd(outcome);
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

      if (state?.mcpServers.some(({protocol}) => protocol === "stateful")) {
        yield* releaseMcpSessions(turnId);
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
      return reconciled ?? outcome;
    },
  },
  options: {
    handlers: {
      lastTurnSequence: {
        shared: true,
        idempotencyRetention: 0,
        journalRetention: 0,
      },
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
        journalRetention: {hours: 1},
        idempotencyRetention: {hours: 1},
        inactivityTimeout: {hours: 1},
        abortTimeout: {minutes: 15},
      },
    },
  },
});

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
    state.mcpCredentials,
    {
      agentId: state.context.agentId,
      turnId: state.context.turnId,
      ownerUserId: state.context.ownerUserId,
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
      state.messages.push(
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
        // Output recovery already ran inside ModelGateway. Never restart it
        // from this loop or spend the remaining 50 steps making no progress.
        if (step.code === "output_limit")
          throw new TerminalError(
            `${step.message} The turn stopped after bounded output recovery; completed tool results remain in the conversation.`,
          );
        if (++consecutiveModelErrors >= 3)
          throw new TerminalError(
            `The model returned unusable responses three times in a row. Last error: ${step.message}`,
          );
        state.messages.push({
          role: "user",
          content: `Your last response could not be used (${step.message}). Try again with the available tools or give a final answer.`,
        });
        continue;

      case "text": {
        if (!step.content.trim()) {
          state.messages.push({
            role: "user",
            content:
              "Your last response was empty. Call a tool or give a final answer.",
          });
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
        state.messages.push({
          role: "user",
          content: [
            "[Runtime guardrail]",
            `The proposed action was blocked by guardrail ${JSON.stringify(step.guardrailId)}.`,
            `Reason: ${step.reason}`,
            "Do not repeat the blocked action. Choose a clearly compliant alternative, or return a concise tool-free refusal.",
          ].join("\n"),
        });
        continue;

      case "tools":
        yield* appendToolTranscript(state, step.pendingEvents);
        yield* appendToolTranscript(state, step.outcomes);
        {
          const applied = yield* state.pending.apply(
            step.outcomes,
            state.context,
            step.step,
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

function mcpAvailabilityMessage(
  servers: McpServerAvailability[],
): ModelMessage {
  return {
    role: "user",
    content: [
      "[Configured MCP server availability for this turn]",
      ...servers.map((server) => {
        if (server.status === "available") {
          return `- ${JSON.stringify(server.serverId)}: available (${server.toolCount} tools)`;
        }
        const detail =
          server.warnings.length > 0
            ? server.warnings.join("; ")
            : "tool discovery returned no catalog";
        return `- ${JSON.stringify(server.serverId)}: configured but unavailable (${detail})`;
      }),
      "This is runtime status, not a user request.",
      "A configured-but-unavailable server is still configured. Do not claim it is absent or unconfigured.",
      "When the user's request needs an unavailable server, explain its exact availability problem and ask them to reconnect or correct its configuration.",
    ].join("\n"),
  };
}

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
