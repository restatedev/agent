// Active-turn management for one Agent virtual object. This component owns the
// `turn` and `pending` state keys plus the AgentSession invocation and signals.
// It deliberately knows nothing about conversation history.

import type {ConversationEntry} from "@restate-agents/types";
import * as restate from "@restatedev/restate-sdk-gen";
import {
  AGENT_SESSION_SIGNALS,
  type AgentSessionOutcome,
  type AgentSessionRequest,
  type AgentSessionSteering,
} from "../internal-types.js";
import {AgentSession} from "../session/index.js";

/** Durable state for the invocation currently owned by the Agent. */
type ActiveTurnState = {
  /** AgentSession.doTurn invocation ID and signal target. */
  id: string;
  /** The accepted interruption while its terminal outcome is still pending. */
  interruptReason?: string;
  /** Steering signals sent to this turn in FIFO order. */
  steeringBatches: AgentSessionSteering[];
};

/** Information returned when an active turn is successfully retired. */
type FinishedTurn = {
  /** Final outcome after reconciling a late accepted interruption. */
  outcome: AgentSessionOutcome;
  /** Transcript entries that must open the next turn, in original order. */
  queuedEntries: ConversationEntry[];
};

/** Returns the current turn. */
export function* current(): restate.Operation<ActiveTurnState | undefined> {
  return (yield* restate.state().get<ActiveTurnState>("turn")) ?? undefined;
}

/**
 * Handler-scoped access to active-turn state for the current Agent object.
 *
 * These functions must run inside an Agent handler. They use Restate's current
 * context and hold no process-local state. Mutations rely on exclusive handler
 * serialization; history remains a separate concern.
 */
/**
 * Starts an AgentSession invocation and records it as the active turn.
 *
 * The exclusive Agent caller is responsible for ensuring no turn is active.
 *
 * @returns The new invocation ID.
 */
export function* start(
  agentId: string,
  request: AgentSessionRequest,
): restate.Operation<string> {
  const started = yield* restate
    .sendClient(AgentSession, agentId)
    .doTurn(request);
  restate.state().set("turn", {
    id: started.id,
    steeringBatches: [],
  });
  return started.id;
}

/**
 * Adds transcript entries to the FIFO batch for the next turn.
 *
 * @returns The new number of pending user messages.
 */
export function* enqueue(
  ...entries: ConversationEntry[]
): restate.Operation<number> {
  const pending =
    (yield* restate.state().get<ConversationEntry[]>("pending")) ?? [];
  pending.push(...entries);
  restate.state().set("pending", pending);
  return pending.filter(({role}) => role === "user").length;
}

/**
 * Signals the active invocation to interrupt and marks it as winding down.
 *
 * @returns `true` when this call sent the first interrupt, `false` when one
 * was already pending, or `undefined` when no Turn is active.
 */
export function* interrupt(
  reason: string,
): restate.Operation<boolean | undefined> {
  const active = yield* current();
  if (!active) {
    return undefined;
  }
  if (active.interruptReason !== undefined) {
    return false;
  }
  restate
    .invocation(active.id)
    .signal<string>(AGENT_SESSION_SIGNALS.interrupt)
    .resolve(reason);
  restate.state().set("turn", {...active, interruptReason: reason});
  return true;
}

/**
 * Promotes queued messages and a new instruction into the active Turn.
 *
 * Pending messages are drained into the signal as a separate FIFO list.
 *
 * @returns Whether an active turn accepted the steering signal.
 */
export function* steer(
  message: string,
  ...entries: ConversationEntry[]
): restate.Operation<boolean> {
  const active = yield* current();
  if (!active || active.interruptReason !== undefined) {
    return false;
  }

  const pending =
    (yield* restate.state().get<ConversationEntry[]>("pending")) ?? [];
  restate.state().clear("pending");
  const steering = {queued: [...pending, ...entries], message};
  restate.state().set("turn", {
    ...active,
    steeringBatches: [...active.steeringBatches, steering],
  });
  restate
    .invocation(active.id)
    .signal<AgentSessionSteering>(AGENT_SESSION_SIGNALS.steering)
    .resolve(steering);
  return true;
}

/**
 * Retires the matching active turn and drains its pending-message batch.
 *
 * Stale or duplicate outcomes are ignored. A late accepted interruption is
 * reflected in the final outcome, and every unconsumed steering entry is
 * recovered for the successor turn.
 *
 * @returns Reconciliation information, or `undefined` for an outcome that
 * does not belong to the active turn.
 */
export function* finish(
  outcome: AgentSessionOutcome,
): restate.Operation<FinishedTurn | undefined> {
  const active = yield* current();
  if (active?.id !== outcome.turnId) {
    return undefined;
  }

  restate.state().clear("turn");
  const pending =
    (yield* restate.state().get<ConversationEntry[]>("pending")) ?? [];
  restate.state().clear("pending");

  const missedSteeringEntries = active.steeringBatches
    .slice(outcome.consumedSteering)
    .flatMap(({queued, message}): ConversationEntry[] => [
      ...queued,
      {role: "user", text: message, delivery: "queued"},
    ]);
  const reconciled =
    active.interruptReason !== undefined && outcome.status !== "interrupted"
      ? {
          turnId: outcome.turnId,
          status: "interrupted" as const,
          reason: active.interruptReason,
          ...("response" in outcome ? {response: outcome.response} : {}),
          consumedSteering: outcome.consumedSteering,
        }
      : outcome;
  return {
    outcome: reconciled,
    queuedEntries: [...missedSteeringEntries, ...pending],
  };
}
