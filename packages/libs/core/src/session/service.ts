// AgentSession is a Virtual Object keyed by agent id. It owns the canonical
// transcript. One doTurn invocation is one agent run: the agent SDK owns the
// model/tool loop, steering, interruption, background tools and
// finalization; this handler owns the transcript, the sandbox and
// reconciliation with the Agent controller.

import {agent, type RunResult} from "@restate-agents/core";
import type {
  ConversationCompactionPlan,
  ConversationCompactionResult,
  ConversationEntry,
  HistoryPage,
} from "@restate-agents/types";
import {AgentSessionDefinition} from "@restate-agents/types/services";
import {CancelledError, TerminalError} from "@restatedev/restate-sdk";
import * as restate from "@restatedev/restate-sdk-gen";

import {Agent} from "../agent/index.js";
import {errorMessage} from "../errors.js";
import {
  AGENT_SESSION_SIGNALS,
  type AgentTurnOutcome,
  type AgentTurnRequest,
} from "../internal-types.js";
import {AGENT_SYSTEM, agentModel, compactConversation} from "../model/index.js";
import {executionRetention, noRetention} from "../retention.js";
import {
  destroySandbox,
  openTurnSandbox,
  type TurnSandbox,
} from "../sandbox/index.js";
import {objectKey} from "../state.js";
import {buildModelContext} from "./context.js";
import {guardOutput, guardToolCall, recordEvidence} from "./guardrails.js";
import type {TurnHistory} from "./history.js";
import * as history from "./history.js";
import {turnProgress} from "./progress.js";
import {askHuman} from "./tools/approval.js";
import type {TurnContext} from "./turn-context.js";
import {turnTools} from "./turn-tools.js";

const MAX_STEPS = 50;
// The turn is bounded by its steps and each program by its own 128 calls,
// not by a turn-wide call budget; this bound only trips once both run out.
const MAX_TOOL_CALLS = MAX_STEPS * 128;

/** The operational agent. Profile, tools and grants are per-turn inputs. */
const turnAgent = agent<TurnContext>({
  model: agentModel,
  maxSteps: MAX_STEPS,
  maxToolCalls: MAX_TOOL_CALLS,
  maxOutputTokens: 32_000,
  *instructions({context}) {
    return [AGENT_SYSTEM, context.instructions].filter(Boolean).join("\n\n");
  },
  beforeStep: recordEvidence,
  beforeTool: guardToolCall,
  afterRun: (candidate, {context}) => guardOutput(candidate, context),
  // The humanApproval tool: the Agent registers the request, the UI decides.
  *onHumanApproval(request, {context}) {
    const decision = yield* askHuman(context, {
      approvalId: request.call.id,
      question: request.question ?? `Allow ${request.call.name}?`,
    });
    return decision?.decision === "approved";
  },
});

/** What a turn holds: resources released on every exit, and its progress. */
type TurnResources = {
  sandbox: TurnSandbox;
  closeTools?: () => restate.Operation<void>;
  progress?: ReturnType<typeof turnProgress>;
};

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
     * outcome to the Agent on every exit. The invocation owns the agent run
     * and, while it runs, the agent's sandbox.
     */
    *doTurn(req: AgentTurnRequest): restate.Operation<AgentTurnOutcome> {
      const turnId = restate.handlerRequest().id;
      const resources: TurnResources = {sandbox: openTurnSandbox(objectKey())};
      let transcript: TurnHistory | undefined;
      let reconciled: AgentTurnOutcome | null;
      let outcome: AgentTurnOutcome;
      // Every exit reports to the Agent, which clears its active turn only
      // then. Cancellation at any point, including cleanup and the report
      // itself, falls through to the one-way report in `abandonTurn`.
      try {
        try {
          // History is opened once for the whole invocation. The controller
          // already chose the starting entries and immutable turn profile.
          transcript = yield* history.openTurn();
          yield* transcript.append(...req.entries);
          outcome = yield* runTurn(req, turnId, transcript, resources);
        } catch (error) {
          if (error instanceof CancelledError) throw error;
          outcome = failedOutcome(turnId, resources, error);
        }
        try {
          yield* releaseResources(resources);
        } catch (error) {
          if (error instanceof CancelledError) throw error;
          outcome = failedOutcome(
            turnId,
            resources,
            error,
            "Turn cleanup failed",
          );
        }
        // The controller reconciles late steering and interruption before
        // the outcome is recorded in the public transcript.
        reconciled = yield* restate
          .client(Agent, objectKey())
          .onTurnEnd(outcome);
      } catch (error) {
        if (error instanceof CancelledError)
          yield* abandonTurn(turnId, transcript, resources);
        throw error;
      }
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
      // Only `history` is public. The rest are driven by the Agent, and a
      // direct doTurn would bypass its profile, guardrails and turn record.
      history: {shared: true, ...noRetention},
      compact: {shared: true, ingressPrivate: true, ...noRetention},
      applyCompaction: {ingressPrivate: true, ...noRetention},
      retire: {ingressPrivate: true, ...executionRetention},
      doTurn: {
        ingressPrivate: true,
        ...executionRetention,
        inactivityTimeout: {hours: 1},
        abortTimeout: {minutes: 15},
      },
    },
  },
});

/** One agent run over the turn's model context and permitted tools. */
function* runTurn(
  req: AgentTurnRequest,
  turnId: string,
  transcript: TurnHistory,
  resources: TurnResources,
): restate.Operation<AgentTurnOutcome> {
  const conversation = transcript.context();
  const messages = buildModelContext(
    conversation.entries,
    conversation.summary,
    req.memories,
    req.agentName,
  );
  const input = messages.pop();
  if (input?.role !== "user")
    throw new TerminalError("A turn must start with user input");
  const catalog = yield* turnTools(req);
  resources.closeTools = catalog.close;
  const prior = [...messages, ...catalog.notes];
  const context: TurnContext = {
    agentId: objectKey(),
    turnId,
    instructions: req.instructions,
    sandbox: resources.sandbox,
    transcript,
    policy: {
      guardrails: req.guardrails,
      evidenceFrom: prior.length,
      evidence: [],
      approved: [],
      rejected: new Set(),
    },
  };
  const progress = turnProgress(context);
  resources.progress = progress;
  const result = yield* turnAgent.run(input.content, {
    name: "turn",
    context,
    messages: prior,
    tools: catalog.tools,
    controls: {
      steering: progress.steering,
      interrupt: restate.signal<string>(AGENT_SESSION_SIGNALS.interrupt),
    },
    onProgress: (event) => progress.record(event),
  });
  return turnOutcome(turnId, result, progress.consumedSteering);
}

function turnOutcome(
  turnId: string,
  result: RunResult,
  consumedSteering: number,
): AgentTurnOutcome {
  switch (result.status) {
    case "completed":
      return {
        turnId,
        status: "completed",
        response: result.output,
        consumedSteering,
      };
    case "interrupted":
      return {
        turnId,
        status: "interrupted",
        reason: result.reason,
        ...(result.output ? {response: result.output} : {}),
        consumedSteering,
      };
    case "stopped": {
      const reason =
        result.reason === "max_steps"
          ? `The agent reached its ${MAX_STEPS}-step limit.`
          : "The agent reached its tool-call limit.";
      return {
        turnId,
        status: "stopped",
        cause: "step_limit",
        reason,
        response:
          result.output ??
          `The turn stopped (${reason}), but its final response could not be generated.`,
        consumedSteering,
      };
    }
  }
}

function failedOutcome(
  turnId: string,
  resources: TurnResources,
  error: unknown,
  prefix?: string,
): AgentTurnOutcome {
  const message = errorMessage(error);
  return {
    turnId,
    status: "failed",
    error: prefix ? `${prefix}: ${message}` : message,
    consumedSteering: resources.progress?.consumedSteering ?? 0,
  };
}

function* releaseResources(resources: TurnResources): restate.Operation<void> {
  if (resources.closeTools) yield* resources.closeTools();
  yield* resources.sandbox.release();
}

/**
 * Cleanup after invocation cancellation. The report comes first and nothing
 * may skip it; the Agent ignores it if an earlier report already retired the
 * turn. Then the interruption is appended and resources are released.
 */
function* abandonTurn(
  turnId: string,
  transcript: TurnHistory | undefined,
  resources: TurnResources,
): restate.Operation<void> {
  const outcome: AgentTurnOutcome = {
    turnId,
    status: "interrupted",
    reason: "Turn cancelled",
    consumedSteering: resources.progress?.consumedSteering ?? 0,
  };
  yield* restate.sendClient(Agent, objectKey()).onTurnEnd(outcome);
  if (transcript) yield* transcript.append(...outcomeEntries(outcome));
  yield* releaseResources(resources);
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
