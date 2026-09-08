// Agent is the durable conversation controller. It is a Virtual Object keyed
// by agent id, so its exclusive handlers serialize every decision about the
// active turn, queued messages, persistent profile, approvals, and private MCP
// authorization state.
//
// It never runs turn execution itself. `ask` starts or queues work,
// `interrupt` and `steer` resolve signals on the active AgentSession
// invocation, external producers use `deliver` to enter those same routing
// decisions, and `onTurnEnd` accepts the invocation's high-level outcome.

import type {
  AgentDelivery,
  AgentNotificationTopic,
  AgentProfile,
  ApprovalRequest,
  AskResult,
  ConversationEntry,
} from "@restate-agents/types";
import {
  AgentDefinition,
  AgentNotificationsDefinition,
} from "@restate-agents/types/services";
import {TerminalError} from "@restatedev/restate-sdk";
import * as restate from "@restatedev/restate-sdk-gen";
import type {
  AgentTurnOutcome,
  MemoryUpdate,
  MemoryUpdateResult,
} from "../internal-types.js";
import * as activeTurn from "./active-turn.js";
import * as approvals from "./approval.js";
import * as mcpAuthorization from "./mcp-authorization.js";
import * as profile from "./profile.js";

// Internal coordination handlers are high-volume and their completed
// invocations carry no information worth retaining.
const noRetention = {idempotencyRetention: 0, journalRetention: 0};

/** Durable per-Agent controller for turns, routing, profile, and user actions. */
export const Agent = restate.implement(AgentDefinition, {
  handlers: {
    /**
     * Accepts a user message, starting a Turn while idle or appending it to the
     * next-Turn queue while another Turn is active.
     *
     * Clients use `steer` or `interrupt` when they want to affect active work.
     *
     * @returns The routing decision, relevant Turn ID, and queue statistics.
     */
    *ask({message}): restate.Operation<AskResult> {
      const agentId = agentKey();
      const current = yield* activeTurn.current();
      if (current) {
        const pendingMessages = yield* activeTurn.enqueue({
          role: "user",
          text: message,
          delivery: "queued",
        });
        return {
          decision: "queue",
          turnId: null,
          activeTurnId: current.id,
          stats: {pendingMessages},
        };
      }

      const turnId = yield* startTurn(agentId, [
        {role: "user", text: message, delivery: "turn"},
      ]);
      return {
        decision: "start",
        turnId,
        stats: {pendingMessages: 0},
      };
    },

    /**
     * Stops the active Turn and optionally queues a replacement user message.
     *
     * The reason guides tool-free finalization. A replacement is still
     * accepted after interruption has begun.
     *
     * @returns Whether an interruption or replacement message was accepted.
     */
    *interrupt({reason, message}): restate.Operation<boolean> {
      const current = yield* activeTurn.current();
      const requested = yield* activeTurn.interrupt(reason);
      if (requested === undefined || current === undefined) {
        return false;
      }

      if (message) {
        yield* activeTurn.enqueue({
          role: "user",
          text: message,
          delivery: "queued",
        });
      }
      if (!requested) {
        return message !== undefined;
      }

      const cancelledAuthorizations = yield* mcpAuthorization.cancelTurn(
        current.id,
        "Turn interrupted",
      );
      if (cancelledAuthorizations.length > 0) {
        yield* publishNotification("mcpAuth");
      }

      return true;
    },

    /**
     * Redirects the active Turn with queued messages followed by a new user
     * instruction, without cancelling its current tools.
     *
     * @returns `false` when no Turn can receive steering; the queue is then
     * left untouched.
     */
    *steer(message): restate.Operation<boolean> {
      return yield* activeTurn.steer(message);
    },

    /**
     * Routes a message delivered by an external producer.
     *
     * Idle Agents start a Turn. Busy Agents apply the producer's queue,
     * steer, or interrupt policy using the same active-turn primitives as
     * direct user interaction.
     */
    *deliver(delivery): restate.Operation<void> {
      const current = yield* activeTurn.current();
      if (!current) {
        yield* startTurn(agentKey(), [
          deliveryEvent(delivery, "start"),
          {role: "user", text: delivery.message, delivery: "turn"},
        ]);
        return;
      }

      if (
        current.interruptReason !== undefined ||
        delivery.whenBusy === "queue"
      ) {
        yield* activeTurn.enqueue(
          deliveryEvent(delivery, "queue", current.id),
          {
            role: "user",
            text: delivery.message,
            delivery: "queued",
          },
        );
        return;
      }

      if (delivery.whenBusy === "steer") {
        yield* activeTurn.steer(
          delivery.message,
          deliveryEvent(delivery, "steer", current.id),
        );
        return;
      }

      yield* activeTurn.enqueue(
        deliveryEvent(delivery, "interrupt", current.id),
        {
          role: "user",
          text: delivery.message,
          delivery: "queued",
        },
      );
      yield* activeTurn.interrupt(
        delivery.interruptReason ??
          `${delivery.source} delivered a message that requested interruption`,
      );
    },

    /**
     * Returns the durable instructions, memories, guardrails, and MCP servers
     * that the next Turn will snapshot.
     */
    *profile(): restate.Operation<AgentProfile> {
      return yield* profile.read();
    },

    /**
     * Replaces persistent user instructions.
     *
     * `null` clears the instructions. Running Turns retain their initial
     * profile snapshot.
     */
    *setInstructions({instructions}): restate.Operation<void> {
      profile.setInstructions(instructions);
      yield* publishNotification("profile");
    },

    /**
     * Replaces the complete per-Agent guardrail list.
     *
     * Running Turns retain their initial profile snapshot; subsequent Turns
     * enforce the replacement list.
     */
    *setGuardrails({guardrails}): restate.Operation<void> {
      profile.setGuardrails(guardrails);
      yield* publishNotification("profile");
    },

    /** Enables or disables built-in web search for subsequent turns. */
    *setWebSearchEnabled({enabled}): restate.Operation<void> {
      profile.setWebSearchEnabled(enabled);
      yield* publishNotification("profile");
    },

    /** Creates or replaces one MCP server in the Agent profile. */
    *upsertMcpServer(server) {
      const previous = (yield* profile.read()).mcpServers.find(
        ({id}) => id === server.id,
      );
      const result = yield* profile.upsertMcpServer(server);
      if (result.accepted) {
        if (previous && JSON.stringify(previous) !== JSON.stringify(server)) {
          const invalidated = yield* mcpAuthorization.invalidateServer(
            server.id,
            "MCP server configuration changed",
          );
          if (invalidated) {
            yield* publishNotification("mcpAuth");
          }
        }
        yield* publishNotification("profile");
      }
      return result;
    },

    /** Removes one MCP server from the Agent profile. */
    *removeMcpServer({id}) {
      const removed = yield* profile.removeMcpServer(id);
      if (removed) {
        const invalidated = yield* mcpAuthorization.invalidateServer(
          id,
          "MCP server was removed",
        );
        if (invalidated) {
          yield* publishNotification("mcpAuth");
        }
        yield* publishNotification("profile");
      }
      return {removed};
    },

    /** Registers a user authorization action requested by the active Turn. */
    *requestMcpAuthorization(request) {
      const current = yield* activeTurn.current();
      if (
        current?.id !== request.turnId ||
        current.interruptReason !== undefined
      ) {
        return null;
      }
      const server = (yield* profile.read()).mcpServers.find(
        ({id}) => id === request.serverId,
      );
      if (
        server?.auth.type === "none" ||
        server?.auth.type !== request.authType
      ) {
        return null;
      }

      const existing = (yield* mcpAuthorization.requests()).find(
        ({turnId, serverId}) =>
          turnId === request.turnId && serverId === request.serverId,
      );
      const registered = yield* mcpAuthorization.register(request);
      if (registered && !existing) {
        yield* publishNotification("mcpAuth");
      }
      return registered ?? null;
    },

    /** Removes an authorization wait abandoned by Turn cancellation. */
    *cancelMcpAuthorization(request): restate.Operation<void> {
      if (yield* mcpAuthorization.cancel(request)) {
        yield* publishNotification("mcpAuth");
      }
    },

    /** Returns user-visible pending MCP authorization actions. */
    *mcpAuthorizations() {
      return yield* mcpAuthorization.requests();
    },

    /** Returns private OAuth context to the trusted BFF. */
    *mcpAuthorizationContext({authRequestId}) {
      const request = (yield* mcpAuthorization.requests()).find(
        (candidate) => candidate.authRequestId === authRequestId,
      );
      const server = request
        ? (yield* profile.read()).mcpServers.find(
            ({id}) => id === request.serverId,
          )
        : undefined;
      return yield* mcpAuthorization.context(authRequestId, server);
    },

    /** Persists PKCE and discovery state across the OAuth redirect. */
    *saveMcpAuthorizationFlow({authRequestId, flow}) {
      const current = yield* activeTurn.current();
      const request = (yield* mcpAuthorization.requests()).find(
        (candidate) => candidate.authRequestId === authRequestId,
      );
      if (
        !request ||
        current?.id !== request.turnId ||
        current.interruptReason !== undefined
      ) {
        return false;
      }
      return yield* mcpAuthorization.saveFlow(authRequestId, flow);
    },

    /** Stores private OAuth state and resumes the Turn with an access token. */
    *completeMcpAuthorization({authRequestId, oauthState}) {
      const current = yield* activeTurn.current();
      const completed = yield* mcpAuthorization.complete(
        authRequestId,
        oauthState,
        current?.interruptReason === undefined ? current?.id : undefined,
      );
      if (!completed) {
        return false;
      }
      yield* publishNotification("mcpAuth");
      return true;
    },

    /** Stores a private bearer token and resumes its waiting Turn. */
    *completeMcpBearerAuthorization({authRequestId, accessToken}) {
      const current = yield* activeTurn.current();
      const completed = yield* mcpAuthorization.completeBearer(
        authRequestId,
        accessToken,
        current?.interruptReason === undefined ? current?.id : undefined,
      );
      if (!completed) {
        return false;
      }
      yield* publishNotification("mcpAuth");
      return true;
    },

    /**
     * Applies one atomic model-requested memory batch.
     *
     * Only the active, non-interrupting Turn may mutate its Agent's memories.
     */
    *updateMemory({
      turnId,
      changes,
    }: MemoryUpdate): restate.Operation<MemoryUpdateResult> {
      const current = yield* activeTurn.current();
      if (current?.id !== turnId || current.interruptReason !== undefined) {
        return {
          applied: false,
          error: "memory update rejected because its Turn is no longer active",
        };
      }

      const result = yield* profile.applyMemory(changes);
      if (result.applied) {
        yield* publishNotification("profile");
      }
      return result;
    },

    /**
     * Registers a pending human-approval request for an active Turn.
     *
     * Registration is idempotent for an identical request and rejected for a
     * stale, interrupting, or conflicting Turn.
     *
     * @returns Whether the request is registered and can receive a decision.
     */
    *requestApproval(request: ApprovalRequest): restate.Operation<boolean> {
      const current = yield* activeTurn.current();
      if (
        current?.id !== request.turnId ||
        current.interruptReason !== undefined
      ) {
        return false;
      }
      const registration = yield* approvals.register(request);
      if (registration === "rejected") {
        return false;
      }
      if (registration === "added") {
        yield* publishNotification("approvals");
      }
      return true;
    },

    /**
     * Idempotently removes an approval request abandoned by interruption or
     * Turn failure.
     */
    *cancelApproval(request): restate.Operation<void> {
      if (yield* approvals.cancel(request)) {
        yield* publishNotification("approvals");
      }
    },

    /**
     * Returns every human-approval request currently awaiting a decision.
     */
    *approvals(): restate.Operation<ApprovalRequest[]> {
      return yield* approvals.list();
    },

    /**
     * Resolves a pending approval and signals its waiting tool or policy gate.
     *
     * The decision is accepted only while the originating Turn is active and
     * not interrupting.
     *
     * @returns Whether the decision was delivered.
     */
    *resolveApproval(resolution): restate.Operation<boolean> {
      const current = yield* activeTurn.current();
      const request = yield* approvals.resolve(
        resolution,
        current?.interruptReason === undefined ? current?.id : undefined,
      );
      if (!request) {
        return false;
      }
      yield* publishNotification("approvals");
      return true;
    },

    /**
     * Reconciles the active Turn's single terminal outcome.
     *
     * The handler retires matching Turn state, clears abandoned approvals,
     * and dispatches queued work. Stale or duplicate outcomes are ignored.
     *
     * @returns The reconciled outcome AgentSession must append, or `null` for
     * a stale or duplicate outcome.
     */
    *onTurnEnd(outcome): restate.Operation<AgentTurnOutcome | null> {
      const finished = yield* activeTurn.finish(outcome);
      if (!finished) {
        return null;
      }
      const cancelledApprovals = yield* approvals.clearTurn(
        finished.outcome.turnId,
      );
      if (cancelledApprovals.length > 0) {
        yield* publishNotification("approvals");
      }
      const cancelledAuthorizations = yield* mcpAuthorization.clearTurn(
        finished.outcome.turnId,
      );
      if (cancelledAuthorizations.length > 0) {
        yield* publishNotification("mcpAuth");
      }

      const queuedMessages = finished.queuedEntries.filter(
        ({role}) => role === "user",
      ).length;
      if (queuedMessages > 0) {
        yield* startTurn(agentKey(), [
          ...finished.queuedEntries,
          {
            role: "event",
            type: "dispatch",
            queuedMessages,
          },
        ]);
      }
      return finished.outcome;
    },
  },
  options: {
    enableLazyState: true,
    handlers: {
      // High-volume coordination paths keep no completed-invocation state.
      onTurnEnd: noRetention,
      updateMemory: noRetention,
      upsertMcpServer: noRetention,
      removeMcpServer: noRetention,
      requestMcpAuthorization: noRetention,
      cancelMcpAuthorization: noRetention,
      mcpAuthorizations: {shared: true, ...noRetention},
      mcpAuthorizationContext: {shared: true, ...noRetention},
      saveMcpAuthorizationFlow: noRetention,
      completeMcpAuthorization: noRetention,
      completeMcpBearerAuthorization: noRetention,
      deliver: noRetention,
      requestApproval: noRetention,
      cancelApproval: noRetention,
      approvals: {shared: true, ...noRetention},
      profile: {shared: true, ...noRetention},
    },
  },
});

// Cross-component coordination belongs here: snapshot the Agent profile and
// let AgentSession append the entries that open the turn.
function* startTurn(
  agentId: string,
  entries: ConversationEntry[],
): restate.Operation<string> {
  const agentProfile = yield* profile.read();
  const oauthStates = yield* mcpAuthorization.oauthStates();
  const bearerCredentials = yield* mcpAuthorization.bearerCredentials();
  const mcpCredentials = agentProfile.mcpServers.flatMap((server) => {
    if (server.auth.type === "oauth") {
      const state = oauthStates.find(({serverId}) => serverId === server.id);
      return state
        ? [{serverId: server.id, accessToken: state.tokens.access_token}]
        : [];
    }
    if (server.auth.type === "bearer") {
      const credential = bearerCredentials.find(
        ({serverId}) => serverId === server.id,
      );
      return credential ? [credential] : [];
    }
    return [];
  });
  return yield* activeTurn.start(agentId, {
    ...agentProfile,
    mcpCredentials,
    entries,
  });
}

function* publishNotification(
  topic: AgentNotificationTopic,
): restate.Operation<void> {
  yield* restate
    .sendClient(AgentNotificationsDefinition, agentKey())
    .publish(topic);
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

// The agent id is this object's key. Object handlers always have one, but read
// it through here so a missing key is a clear error, not a stray `!`.
function agentKey(): string {
  const key = restate.handlerRequest().key;
  if (!key) {
    throw new TerminalError("Agent handlers require an agent key");
  }
  return key;
}
