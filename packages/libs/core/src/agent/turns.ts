// Turn routing: every way work reaches the agent. `ask` and external
// deliveries start a turn while idle; while busy they queue, steer or
// interrupt the active one. `onTurnEnd` accepts the turn's outcome and starts
// its successor from the queue.

import type {AgentDelivery, ConversationEntry} from "@restate-agents/types";
import {CancelledError, TerminalError} from "@restatedev/restate-sdk";
import * as restate from "@restatedev/restate-sdk-gen";

import {
  configuredMcpServers,
  grantedMcpServers,
  resolveMcpGrants,
} from "../session/mcp-config.js";
import * as activeTurn from "./active-turn.js";
import * as approvals from "./approvals.js";
import {
  type AgentHandlers,
  forbidden,
  isDeleted,
  readMetadata,
  requireDirectAccess,
  requireLive,
  requireTopLevel,
} from "./guards.js";
import * as profile from "./profile.js";
import * as subAgents from "./sub-agents.js";

export const handlers: AgentHandlers<
  "ask" | "interrupt" | "steer" | "deliver" | "onTurnEnd"
> = {
  /** Starts a turn while idle, or queues the message for the next one. */
  *ask({message}) {
    yield* requireDirectAccess();
    const current = yield* activeTurn.current();
    if (!current) {
      const turnId = yield* startTurn([
        {role: "user", text: message, delivery: "turn"},
      ]);
      return {decision: "start", turnId, stats: {pendingMessages: 0}};
    }
    const pendingMessages = yield* activeTurn.enqueue(queued(message));
    return {
      decision: "queue",
      turnId: null,
      activeTurnId: current.id,
      stats: {pendingMessages},
    };
  },

  /**
   * Stops the active turn and optionally queues a replacement message, which
   * is accepted even after interruption has begun. The reason guides the
   * turn's tool-free final answer.
   *
   * @returns Whether an interruption or a replacement was accepted.
   */
  *interrupt({reason, message}) {
    yield* requireLive();
    // A child's conversation is read-only; the user may only stop it.
    if ((yield* readMetadata()).parentAgentId) {
      if (message !== undefined)
        throw forbidden(
          "Sub-agent conversations are read-only; only interrupt is allowed",
        );
      reason = "Interrupted by the user";
    }
    const current = yield* activeTurn.current();
    if (!current) return false;
    const sent = yield* activeTurn.interrupt(reason);
    yield* subAgents.stopTasksOf(current.id, reason);
    if (message) yield* activeTurn.enqueue(queued(message));
    return sent || message !== undefined;
  },

  /**
   * Sends queued messages and a new instruction to the active turn without
   * cancelling its tools.
   *
   * @returns `false` when no turn can receive it; the queue is then untouched.
   */
  *steer({message}) {
    yield* requireDirectAccess();
    return yield* activeTurn.steer(message);
  },

  /** Routes a message from an external producer. */
  *deliver(delivery) {
    if (yield* isDeleted()) return;
    yield* requireTopLevel();
    yield* route(delivery);
  },

  /**
   * Accepts the active turn's single outcome, clears what it left behind and
   * starts its successor from the queue. Stale or duplicate outcomes return
   * `null`; otherwise the reconciled outcome is what AgentSession appends.
   */
  *onTurnEnd(outcome) {
    const finished = yield* activeTurn.finish(outcome);
    if (!finished) return null;
    const {turnId} = finished.outcome;
    yield* subAgents.stopTasksOf(turnId, "Parent turn ended");
    yield* approvals.clearTurn(turnId);
    const queuedMessages = finished.queuedEntries.filter(
      ({role}) => role === "user",
    ).length;
    if (queuedMessages > 0 && !(yield* isDeleted()))
      yield* startSuccessor(finished.queuedEntries, queuedMessages);
    return finished.outcome;
  },
};

/**
 * Routes an external delivery. Idle agents start a turn; busy ones apply the
 * producer's queue, steer or interrupt policy.
 */
export function* route(delivery: AgentDelivery): restate.Operation<void> {
  const current = yield* activeTurn.current();
  if (!current) {
    yield* startTurn([
      deliveryEvent(delivery, "start"),
      {role: "user", text: delivery.message, delivery: "turn"},
    ]);
    return;
  }
  // Coalescing producers never stack: a recurring schedule firing faster
  // than the agent works would otherwise grow the queue without bound or
  // interrupt every successor turn it caused.
  if (
    delivery.coalesce &&
    delivery.sourceId &&
    (yield* activeTurn.hasDelivery(delivery.source, delivery.sourceId))
  )
    return;

  const routing =
    current.interruptReason !== undefined ? "queue" : delivery.whenBusy;
  const event = deliveryEvent(delivery, routing, current.id);
  if (routing === "steer") {
    yield* activeTurn.steer(delivery.message, event);
    return;
  }
  yield* activeTurn.enqueue(event, queued(delivery.message));
  if (routing === "interrupt")
    yield* activeTurn.interrupt(
      delivery.interruptReason ??
        `${delivery.source} delivered a message that requested interruption`,
    );
}

/**
 * Starts a turn from the current profile snapshot. Every entry path (ask,
 * delivery, queued successor, delegation) comes through here.
 *
 * @returns The turn ID.
 */
export function* startTurn(
  entries: ConversationEntry[],
): restate.Operation<string> {
  const agentProfile = yield* profile.read();
  const metadata = yield* readMetadata();
  // Read configuration before any state change: an invalid configuration
  // throws, and state written by a failed invocation is not rolled back.
  const servers = yield* configuredMcpServers();
  // A direct ask implicitly creates the agent; persist its default metadata
  // so later initialization cannot change its parent.
  if (!(yield* restate.state().get("metadata")))
    restate.state().set("metadata", metadata);
  // Normally empty while idle. It holds a successor's input that onTurnEnd
  // could not start, which must open the next turn ahead of the new input.
  const parked = yield* activeTurn.drainPending();
  const tools = resolveMcpGrants(agentProfile.tools, servers);
  return yield* activeTurn.start({
    ...agentProfile,
    agentName: metadata.name,
    tools,
    mcpServers: grantedMcpServers(tools, servers),
    entries: [...parked, ...entries],
  });
}

// `finish` already cleared the turn and its queue, and failing here would
// also stop AgentSession from appending the outcome. A successor that cannot
// start (invalid MCP_SERVERS_JSON) parks its input in the queue instead; the
// next turn start picks it up.
function* startSuccessor(
  queuedEntries: ConversationEntry[],
  queuedMessages: number,
): restate.Operation<void> {
  try {
    yield* startTurn([
      ...queuedEntries,
      {role: "event", type: "dispatch", queuedMessages},
    ]);
  } catch (error) {
    if (!(error instanceof TerminalError) || error instanceof CancelledError)
      throw error;
    yield* activeTurn.enqueue(...queuedEntries);
  }
}

function queued(text: string): ConversationEntry {
  return {role: "user", text, delivery: "queued"};
}

function deliveryEvent(
  delivery: AgentDelivery,
  routing: "start" | "queue" | "steer" | "interrupt",
  turnId?: string,
): ConversationEntry {
  return {
    role: "event",
    type: "delivery",
    source: delivery.source,
    ...(delivery.sourceId ? {sourceId: delivery.sourceId} : {}),
    whenBusy: delivery.whenBusy,
    routing,
    ...(turnId ? {turnId} : {}),
  };
}
