// Agent is the durable conversation controller. It is a Virtual Object keyed
// by agent id, so its exclusive handlers serialize every decision about the
// active turn, queued messages, persistent profile, approvals, and private MCP
// authorization state.
//
// It never runs turn execution itself. `ask` starts or queues work,
// `interrupt` and `steer` resolve signals on the active AgentSession
// invocation, external producers use `deliver` to enter those same routing
// decisions, and `onTurnEnd` accepts the invocation's high-level outcome.

import {createHash} from "node:crypto";
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
  AgentSchedulerDefinition,
  UserDefinition,
} from "@restate-agents/types/services";
import {TerminalError} from "@restatedev/restate-sdk";
import * as restate from "@restatedev/restate-sdk-gen";
import type {
  AgentTurnOutcome,
  MemoryUpdate,
  MemoryUpdateResult,
} from "../internal-types.js";
import {
  askRetention,
  coordinationRetention,
  interactionRetention,
  noRetention,
} from "../retention.js";
import {Sandbox} from "../sandbox/index.js";
import {discoverAgentTools} from "../session/dynamic-tools.js";
import {dynamicToolId, selected} from "../session/tool-permissions.js";
import * as agentTools from "../session/tools.js";
import * as activeTurn from "./active-turn.js";
import * as approvals from "./approval.js";
import * as mcpAuthorization from "./mcp-authorization.js";
import * as profile from "./profile.js";
import {subAgentProfile} from "./sub-agent.js";

/** Durable per-Agent controller for turns, routing, profile, and user actions. */
export const Agent = restate.implement(AgentDefinition, {
  handlers: {
    *initialize({profile: initialProfile, ...owner}) {
      yield* requireNotDeleted();
      const existing = yield* restate.state().get<typeof owner>("ownership");
      if (
        existing &&
        (existing.ownerUserId !== owner.ownerUserId ||
          existing.parentAgentId !== owner.parentAgentId)
      )
        throw new TerminalError("Agent ownership is immutable", {
          errorCode: 409,
        });
      if (!existing) {
        restate.state().set("ownership", owner);
        if (initialProfile) {
          profile.setInstructions(initialProfile.instructions ?? null);
          profile.setGuardrails(initialProfile.guardrails);
          profile.setTools(initialProfile.tools);
          profile.setWebSearchEnabled(initialProfile.webSearchEnabled);
        }
      }
    },
    *createSubAgent({turnId, toolCallId, ...config}) {
      yield* requireNotDeleted();
      const owner = yield* requireOwner();
      const current = yield* activeTurn.current();
      if (current?.id !== turnId || current.interruptReason !== undefined)
        throw new TerminalError(
          "Sub-agent creation requires the active, non-interrupting Turn",
          {errorCode: 409},
        );
      if (
        owner.parentAgentId ||
        !selected(current.tools.builtin, "createSubAgent")
      )
        throw new TerminalError("This agent cannot create sub-agents", {
          errorCode: 403,
        });
      const inherited = subAgentProfile(
        yield* profile.read(),
        current.tools,
        config,
        agentTools.names,
      );
      const agentId = createHash("sha256")
        .update(
          JSON.stringify([
            "sub-agent",
            owner.ownerUserId,
            agentKey(),
            turnId,
            toolCallId,
          ]),
        )
        .digest("hex");
      return yield* restate
        .client(UserDefinition, owner.ownerUserId)
        .createSubAgent({
          agent: {agentId, name: config.name, parentAgentId: agentKey()},
          profile: inherited,
        });
    },
    *startSubAgentTask({turnId, toolCallId, agentId, message, source}) {
      const owner = yield* requireOwner();
      const current = yield* activeTurn.current();
      if (current?.id !== turnId || current.interruptReason !== undefined)
        throw new TerminalError(
          "Delegation requires the active, non-interrupting Turn",
          {errorCode: 409},
        );
      if (owner.parentAgentId || !selected(current.tools.builtin, source))
        throw new TerminalError("This agent cannot delegate this task", {
          errorCode: 403,
        });
      if (source === "createSubAgent") {
        const expected = createHash("sha256")
          .update(
            JSON.stringify([
              "sub-agent",
              owner.ownerUserId,
              agentKey(),
              turnId,
              toolCallId,
            ]),
          )
          .digest("hex");
        if (agentId !== expected)
          throw new TerminalError(
            "Creation can only start its newly created child",
            {errorCode: 403},
          );
      }
      const children = yield* restate
        .client(UserDefinition, owner.ownerUserId)
        .listSubAgents({parentAgentId: agentKey()});
      if (!children.some((child) => child.agentId === agentId))
        throw new TerminalError("Agent is not a direct child of this parent", {
          errorCode: 403,
        });
      const tasks = yield* subAgentTasks();
      const existing = tasks.find(
        (task) => task.turnId === turnId && task.toolCallId === toolCallId,
      );
      if (existing) return {turnId: existing.childTurnId};
      const child = yield* restate
        .client(AgentDefinition, agentId)
        .startDelegatedTurn({
          ownerUserId: owner.ownerUserId,
          parentAgentId: agentKey(),
          parentTurnId: turnId,
          message,
        });
      restate
        .state()
        .set("sub-agent-tasks", [
          ...tasks,
          {turnId, toolCallId, agentId, childTurnId: child.turnId},
        ]);
      return child;
    },
    *startDelegatedTurn({ownerUserId, parentAgentId, parentTurnId, message}) {
      const owner = yield* requireOwner();
      if (
        owner.ownerUserId !== ownerUserId ||
        owner.parentAgentId !== parentAgentId
      )
        throw new TerminalError(
          "Only the owning parent can submit a child task",
          {errorCode: 403},
        );
      if (yield* activeTurn.current())
        throw new TerminalError(
          "Sub-agent is busy; wait for its current task before sending a follow-up",
          {errorCode: 400},
        );
      const turnId = yield* startTurn(agentKey(), [
        {
          role: "user",
          text: message,
          delegatedBy: {agentId: parentAgentId, turnId: parentTurnId},
          delivery: "turn",
        },
      ]);
      return {turnId};
    },
    *finishSubAgentTask({turnId, toolCallId}) {
      const tasks = yield* subAgentTasks();
      const task = tasks.find(
        (task) => task.turnId === turnId && task.toolCallId === toolCallId,
      );
      if (!task) return;
      // Also covers abandoned PTC branches and interrupted parent waits. The
      // child checks the exact turn ID, so a late cleanup cannot stop a follow-up.
      yield* stopSubAgentTask(task, "Parent stopped waiting for this task");
      restate.state().set(
        "sub-agent-tasks",
        tasks.filter((item) => item !== task),
      );
    },
    *interruptDelegatedTurn({parentAgentId, turnId, reason}) {
      const owner = yield* restate
        .state()
        .get<{parentAgentId?: string}>("ownership");
      if (owner?.parentAgentId !== parentAgentId)
        throw new TerminalError("Agent is not a direct child of this parent", {
          errorCode: 403,
        });
      const current = yield* activeTurn.current();
      if (current?.id !== turnId) return;
      yield* activeTurn.interrupt(reason);
      yield* mcpAuthorization.cancelTurn(turnId, reason);
      yield* approvals.clearTurn(turnId);
    },
    *deleteSubAgent({turnId, agentId}) {
      const owner = yield* requireOwner();
      const current = yield* activeTurn.current();
      if (current?.id !== turnId || current.interruptReason !== undefined)
        throw new TerminalError(
          "Sub-agent deletion requires the active, non-interrupting Turn",
          {errorCode: 409},
        );
      if (!selected(current.tools.builtin, "deleteSubAgent"))
        throw new TerminalError("This agent cannot delete sub-agents", {
          errorCode: 403,
        });
      return yield* restate
        .client(UserDefinition, owner.ownerUserId)
        .deleteSubAgent({parentAgentId: agentKey(), agentId});
    },
    *listSubAgents({turnId}) {
      const owner = yield* requireOwner();
      const current = yield* activeTurn.current();
      if (current?.id !== turnId || current.interruptReason !== undefined)
        throw new TerminalError(
          "Listing sub-agents requires the active, non-interrupting Turn",
          {errorCode: 409},
        );
      if (!selected(current.tools.builtin, "listSubAgents"))
        throw new TerminalError("This agent cannot list sub-agents", {
          errorCode: 403,
        });
      return yield* restate
        .client(UserDefinition, owner.ownerUserId)
        .listSubAgents({parentAgentId: agentKey()});
    },
    *retire({ownerUserId}) {
      const owner = yield* restate
        .state()
        .get<{ownerUserId: string}>("ownership");
      if (!owner || owner.ownerUserId !== ownerUserId)
        throw new TerminalError("Agent does not belong to this user", {
          errorCode: 403,
        });
      restate.state().set("deleted", true);
      restate.state().clear("pending");
      yield* stopSubAgentTasks(undefined, "Parent deleted");
      const current = yield* activeTurn.current();
      if (current) {
        yield* activeTurn.interrupt("Agent deleted");
        yield* mcpAuthorization.cancelTurn(current.id, "Agent deleted");
        yield* approvals.clearTurn(current.id);
      }
      // Neither cleanup call may hold Agent's lock while waiting for a caller
      // (a schedule delivery or the active turn) to finish.
      yield* restate.sendClient(AgentSchedulerDefinition, agentKey()).retire();
      yield* restate.sendClient(Sandbox, agentKey()).retire();
      yield* publishNotification("profile");
    },
    *ownership() {
      return (
        (yield* restate
          .sharedState()
          .get<{ownerUserId: string; name: string; parentAgentId?: string}>(
            "ownership",
          )) ?? null
      );
    },
    *setTools(tools) {
      const owner = yield* requireOwner();
      const connections = yield* restate
        .client(UserDefinition, owner.ownerUserId)
        .connections();
      if (
        tools.mcp.some(
          (grant) =>
            !connections.some((c) => c.server.id === grant.connectionId),
        )
      )
        throw new TerminalError("Unknown user connection", {errorCode: 400});
      profile.setTools(tools);
      yield* publishNotification("profile");
    },
    *toolCatalog() {
      const dynamic = yield* discoverAgentTools(agentTools.names);
      return {
        builtin: agentTools
          .manifests([], [], {
            webSearchEnabled: true,
            permissions: {
              builtin: {mode: "all"},
              dynamic: {mode: "selected", names: []},
              mcp: [],
            },
          })
          .map(({name, description}) => ({name, description})),
        dynamic: dynamic.map((tool) => ({
          name: dynamicToolId(tool),
          description: tool.description,
        })),
      };
    },
    *resolveMcpAuthorization(input) {
      const current = yield* activeTurn.current();
      if (
        yield* mcpAuthorization.resolve(
          input,
          current?.interruptReason === undefined ? current?.id : undefined,
        )
      )
        yield* publishNotification("mcpAuth");
    },
    /**
     * Accepts a user message, starting a Turn while idle or appending it to the
     * next-Turn queue while another Turn is active.
     *
     * Clients use `steer` or `interrupt` when they want to affect active work.
     *
     * @returns The routing decision, relevant Turn ID, and queue statistics.
     */
    *ask({message}): restate.Operation<AskResult> {
      yield* requireNotDeleted();
      yield* requireTopLevelConversation();
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
      yield* requireNotDeleted();
      const owner = yield* requireOwner();
      if (owner.parentAgentId) {
        if (message !== undefined)
          throw new TerminalError(
            "Sub-agent conversations are read-only; only interrupt is allowed",
            {errorCode: 403},
          );
        reason = "Interrupted by the user";
      }
      const current = yield* activeTurn.current();
      const requested = yield* activeTurn.interrupt(reason);
      if (requested === undefined || current === undefined) {
        return false;
      }
      yield* stopSubAgentTasks(current.id, reason);

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
      yield* requireNotDeleted();
      yield* requireTopLevelConversation();
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
      if (yield* restate.state().get<boolean>("deleted")) return;
      yield* requireTopLevelConversation();
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
     * Returns the durable instructions, guardrails, and tool grants
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
      yield* requireNotDeleted();
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
      yield* requireNotDeleted();
      profile.setGuardrails(guardrails);
      yield* publishNotification("profile");
    },

    /** Enables or disables built-in web search for subsequent turns. */
    *setWebSearchEnabled({enabled}): restate.Operation<void> {
      yield* requireNotDeleted();
      profile.setWebSearchEnabled(enabled);
      yield* publishNotification("profile");
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
      const owner = yield* requireOwner();
      const grant = current.tools.mcp.find(
        (g) => g.connectionId === request.serverId,
      );
      if (
        !grant ||
        (grant.tools.mode === "selected" && grant.tools.names.length === 0)
      )
        return null;
      const existing = (yield* mcpAuthorization.requests()).find(
        (r) => r.turnId === request.turnId && r.serverId === request.serverId,
      );
      if (existing) return existing;
      const registered = yield* restate
        .client(UserDefinition, owner.ownerUserId)
        .requestMcpAuthorization({agentId: agentKey(), request});
      if (!registered) return null;
      yield* mcpAuthorization.register(registered);
      yield* publishNotification("mcpAuth");
      return registered;
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

    /**
     * Applies one atomic model-requested memory batch.
     *
     * Only the active, non-interrupting Turn may mutate its owner's memories.
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

      const owner = yield* requireOwner();
      return yield* restate
        .client(UserDefinition, owner.ownerUserId)
        .updateMemory({
          agentId: agentKey(),
          changes,
        });
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
      yield* stopSubAgentTasks(finished.outcome.turnId, "Parent turn ended");
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
      if (
        queuedMessages > 0 &&
        !(yield* restate.state().get<boolean>("deleted"))
      ) {
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
      initialize: coordinationRetention,
      createSubAgent: coordinationRetention,
      startSubAgentTask: coordinationRetention,
      startDelegatedTurn: coordinationRetention,
      finishSubAgentTask: coordinationRetention,
      interruptDelegatedTurn: coordinationRetention,
      deleteSubAgent: coordinationRetention,
      retire: coordinationRetention,
      listSubAgents: noRetention,
      ask: askRetention,
      interrupt: interactionRetention,
      steer: interactionRetention,
      setTools: noRetention,
      setInstructions: noRetention,
      setGuardrails: noRetention,
      setWebSearchEnabled: noRetention,
      ownership: {shared: true, ...noRetention},
      toolCatalog: {shared: true, ...noRetention},
      resolveMcpAuthorization: coordinationRetention,
      onTurnEnd: noRetention,
      updateMemory: noRetention,
      requestMcpAuthorization: coordinationRetention,
      cancelMcpAuthorization: coordinationRetention,
      mcpAuthorizations: {shared: true, ...noRetention},
      deliver: noRetention,
      requestApproval: coordinationRetention,
      cancelApproval: coordinationRetention,
      resolveApproval: coordinationRetention,
      approvals: {shared: true, ...noRetention},
      profile: {shared: true, ...noRetention},
    },
  },
});

function* requireNotDeleted(): restate.Operation<void> {
  if (yield* restate.state().get<boolean>("deleted"))
    throw new TerminalError("Agent has been deleted", {errorCode: 410});
}

type SubAgentTask = {
  turnId: string;
  toolCallId: string;
  agentId: string;
  childTurnId: string;
};
function* subAgentTasks(): restate.Operation<SubAgentTask[]> {
  return (yield* restate.state().get<SubAgentTask[]>("sub-agent-tasks")) ?? [];
}
function* stopSubAgentTask(
  task: SubAgentTask,
  reason: string,
): restate.Operation<void> {
  yield* restate
    .sendClient(AgentDefinition, task.agentId)
    .interruptDelegatedTurn({
      parentAgentId: agentKey(),
      turnId: task.childTurnId,
      reason,
    });
}
function* stopSubAgentTasks(
  turnId: string | undefined,
  reason: string,
): restate.Operation<void> {
  const tasks = yield* subAgentTasks();
  for (const task of tasks) {
    if (turnId === undefined || task.turnId === turnId)
      yield* stopSubAgentTask(task, reason);
  }
  restate.state().set(
    "sub-agent-tasks",
    tasks.filter((task) => turnId !== undefined && task.turnId !== turnId),
  );
}
function* requireTopLevelConversation(): restate.Operation<void> {
  const owner = yield* restate
    .state()
    .get<{parentAgentId?: string}>("ownership");
  if (owner?.parentAgentId)
    throw new TerminalError(
      "Only the parent agent can send messages to a sub-agent",
      {errorCode: 403},
    );
}

// Cross-component coordination belongs here: snapshot the Agent profile and
// let AgentSession append the entries that open the turn.
function* startTurn(
  agentId: string,
  entries: ConversationEntry[],
): restate.Operation<string> {
  const agentProfile = yield* profile.read();
  const owner = yield* requireOwner();
  const snapshot = yield* restate
    .client(UserDefinition, owner.ownerUserId)
    .snapshot({agentId, tools: agentProfile.tools});
  return yield* activeTurn.start(agentId, {
    ...agentProfile,
    agentName: owner.name,
    tools: snapshot.tools,
    ownerUserId: owner.ownerUserId,
    memories: snapshot.memories,
    mcpServers: snapshot.servers,
    mcpCredentials: snapshot.credentials,
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

function* requireOwner(): restate.Operation<{
  ownerUserId: string;
  name: string;
  parentAgentId?: string;
}> {
  yield* requireNotDeleted();
  const owner = yield* restate
    .sharedState()
    .get<{ownerUserId: string; name: string; parentAgentId?: string}>(
      "ownership",
    );
  if (!owner)
    throw new TerminalError(
      "Create this agent through its user account first",
      {errorCode: 409},
    );
  return owner;
}
