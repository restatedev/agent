// Agent is the durable conversation controller. It is a Virtual Object keyed
// by agent id, so its exclusive handlers serialize every decision about the
// active turn, queued messages, persistent profile, approvals, schedules, and
// child agents. It also carries the agent's notification watermarks.
//
// It never runs turn execution itself. `ask` starts or queues work,
// `interrupt` and `steer` resolve signals on the active AgentSession
// invocation, external producers and due schedules enter those same routing
// decisions, and `onTurnEnd` accepts the invocation's high-level outcome.

import {createHash} from "node:crypto";

import type {
  AgentDelivery,
  AgentMetadata,
  AgentProfile,
  AgentTools,
  ApprovalRequest,
  AskResult,
  ChildAgent,
  ConversationEntry,
} from "@restate-agents/types";
import {AgentDefinition} from "@restate-agents/types/services";
import {CancelledError, TerminalError} from "@restatedev/restate-sdk";
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
import {configuredMcpServers, resolveMcpGrants} from "../session/mcp-config.js";
import {dynamicToolId, selected} from "../session/tool-permissions.js";
import * as agentTools from "../session/tools.js";
import * as activeTurn from "./active-turn.js";
import * as approvals from "./approval.js";
import * as memory from "./memory.js";
import * as notifications from "./notifications.js";
import * as profile from "./profile.js";
import * as schedules from "./schedules.js";
import {subAgentProfile} from "./sub-agent.js";

/** Durable per-Agent controller for turns, routing, profile, and user actions. */
export const Agent = restate.implement(AgentDefinition, {
  handlers: {
    *initialize({profile: initialProfile, ...metadata}) {
      yield* requireNotDeleted();
      const existing = yield* restate.state().get<typeof metadata>("metadata");
      if (existing && existing.parentAgentId !== metadata.parentAgentId)
        throw new TerminalError("Agent parent is immutable", {
          errorCode: 409,
        });
      if (!existing) {
        restate.state().set("metadata", metadata);
        if (initialProfile) {
          profile.setInstructions(initialProfile.instructions ?? null);
          yield* memory.apply(
            initialProfile.memories.map((entry) => ({
              operation: "set" as const,
              ...entry,
            })),
          );
          profile.setGuardrails(initialProfile.guardrails);
          profile.setTools(initialProfile.tools);
          profile.setWebSearchEnabled(initialProfile.webSearchEnabled);
        }
        yield* notifications.publish("profile");
      }
    },

    // Model-created schedules outlive their Turn, so authorize them against
    // the live Turn under this lock, like memory and sub-agent changes.
    *createSchedule({turnId, ...spec}) {
      yield* requireScheduleAccess(
        turnId,
        "createSchedule",
        "Schedule creation",
        "This agent cannot create schedules",
      );
      if ((yield* readMetadata()).parentAgentId)
        return {
          accepted: false as const,
          error: "Sub-agents cannot schedule messages",
        };
      const result = yield* schedules.upsert(agentKey(), spec);
      if (result.accepted) yield* notifications.publish("schedules");
      return result;
    },
    *cancelSchedule({turnId, scheduleId}) {
      yield* requireScheduleAccess(
        turnId,
        "cancelSchedule",
        "Schedule cancellation",
        "This agent cannot cancel schedules",
      );
      const cancelled = yield* schedules.cancel(scheduleId);
      if (cancelled) yield* notifications.publish("schedules");
      return {accepted: true as const, cancelled};
    },
    *schedules() {
      return yield* schedules.list();
    },
    /**
     * A schedule's delayed timer. A stale or duplicate firing is ignored; a
     * due schedule advances first, then routes like any external delivery.
     */
    *fire({scheduleId}) {
      if (yield* restate.state().get<boolean>("deleted")) return;
      const schedule = yield* schedules.advance(agentKey(), scheduleId);
      if (!schedule) return;
      yield* notifications.publish("schedules");
      yield* route({
        source: "schedule",
        sourceId: schedule.scheduleId,
        message: schedule.message,
        whenBusy: schedule.whenBusy,
        interruptReason: `Scheduled message "${schedule.scheduleId}" became due`,
        // Skip a run while the previous one is still queued or running.
        coalesce: true,
      });
    },
    *createSubAgent({turnId, toolCallId, ...config}) {
      yield* requireNotDeleted();
      const metadata = yield* readMetadata();
      const tools = yield* requireActiveTurnTools(turnId, "Sub-agent creation");
      if (metadata.parentAgentId || !selected(tools.builtin, "createSubAgent"))
        throw new TerminalError("This agent cannot create sub-agents", {
          errorCode: 403,
        });
      const inherited = subAgentProfile(
        yield* profile.read(),
        tools,
        config,
        agentTools.names,
      );
      const agentId = childAgentId(agentKey(), turnId, toolCallId);
      if (yield* restate.state().get<boolean>(`deleted-child:${agentId}`))
        throw new TerminalError("Child has been deleted", {errorCode: 410});
      const children = yield* readChildren();
      const existing = children.find((child) => child.agentId === agentId);
      if (existing) return existing;
      const child = {agentId, name: config.name, parentAgentId: agentKey()};
      // Child initialization never calls its parent while this lock is held.
      yield* restate.client(AgentDefinition, agentId).initialize({
        name: child.name,
        parentAgentId: agentKey(),
        profile: inherited,
      });
      restate.state().set("children", [...children, child]);
      yield* notifications.publish("profile");
      return child;
    },
    *startSubAgentTask({turnId, toolCallId, agentId, message, source}) {
      const metadata = yield* readMetadata();
      const tools = yield* requireActiveTurnTools(turnId, "Delegation");
      if (metadata.parentAgentId || !selected(tools.builtin, source))
        throw new TerminalError("This agent cannot delegate this task", {
          errorCode: 403,
        });
      if (source === "createSubAgent") {
        const expected = childAgentId(agentKey(), turnId, toolCallId);
        if (agentId !== expected)
          throw new TerminalError(
            "Creation can only start its newly created child",
            {errorCode: 403},
          );
      }
      const children = yield* readChildren();
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
    *startDelegatedTurn({parentAgentId, parentTurnId, message}) {
      const metadata = yield* readMetadata();
      if (metadata.parentAgentId !== parentAgentId)
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
      const metadata = yield* restate
        .state()
        .get<{parentAgentId?: string}>("metadata");
      if (metadata?.parentAgentId !== parentAgentId)
        throw new TerminalError("Agent is not a direct child of this parent", {
          errorCode: 403,
        });
      const current = yield* activeTurn.current();
      if (current?.id !== turnId) return;
      yield* activeTurn.interrupt(reason);
      yield* approvals.clearTurn(turnId);
    },
    *deleteSubAgent({turnId, agentId}) {
      yield* requireNotDeleted();
      const tools = yield* requireActiveTurnTools(turnId, "Sub-agent deletion");
      if (!selected(tools.builtin, "deleteSubAgent"))
        throw new TerminalError("This agent cannot delete sub-agents", {
          errorCode: 403,
        });
      const children = yield* readChildren();
      if (!children.some((child) => child.agentId === agentId)) return false;
      restate.state().set(`deleted-child:${agentId}`, true);
      restate.state().set(
        "children",
        children.filter((child) => child.agentId !== agentId),
      );
      yield* restate
        .sendClient(AgentDefinition, agentId)
        .retire({parentAgentId: agentKey()});
      yield* notifications.publish("profile");
      return true;
    },
    *listSubAgents({turnId}) {
      yield* requireNotDeleted();
      const tools = yield* requireActiveTurnTools(turnId, "Listing sub-agents");
      if (!selected(tools.builtin, "listSubAgents"))
        throw new TerminalError("This agent cannot list sub-agents", {
          errorCode: 403,
        });
      return yield* readChildren();
    },
    *retire({parentAgentId}) {
      const metadata = yield* restate.state().get<AgentMetadata>("metadata");
      if (metadata?.parentAgentId !== parentAgentId)
        throw new TerminalError("Only the parent can retire a child", {
          errorCode: 403,
        });
      if (yield* restate.state().get<boolean>("deleted")) return;
      restate.state().set("deleted", true);
      restate.state().clear("pending");
      yield* stopSubAgentTasks(undefined, "Parent deleted");
      restate.state().clear("sub-agent-tasks");
      const current = yield* activeTurn.current();
      if (current) yield* activeTurn.interrupt("Agent deleted");
      if (yield* approvals.clearAll())
        yield* notifications.publish("approvals");
      // `profile` is shared and has no deleted check; clearing is what keeps a
      // retired agent's memories and instructions from staying readable.
      // `metadata` stays so a repeated retire still sees its parent, and
      // `turn` stays until the interrupted invocation reports to onTurnEnd.
      profile.clear();
      // Do not wait for sandbox cleanup while holding Agent's lock: the active
      // turn may need this controller.
      for (const child of yield* readChildren()) {
        yield* restate
          .sendClient(AgentDefinition, child.agentId)
          .retire({parentAgentId: agentKey()});
      }
      restate.state().clear("children");
      if (yield* schedules.clearAll())
        yield* notifications.publish("schedules");
      yield* restate.sendClient(Sandbox, agentKey()).retire();
      yield* notifications.publish("profile");
    },
    *metadata() {
      return yield* readMetadata();
    },
    *children() {
      return yield* readChildren();
    },
    *deleteMemory({key}) {
      yield* requireNotDeleted();
      yield* requireTopLevelConversation();
      const present = (yield* memory.read()).some((entry) => entry.key === key);
      if (present) {
        yield* memory.apply([{operation: "delete", key}]);
        yield* notifications.publish("profile");
      }
      return present;
    },
    *setTools(tools) {
      yield* requireNotDeleted();
      yield* requireTopLevelConversation();
      profile.setTools(tools);
      yield* notifications.publish("profile");
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
        mcp: yield* configuredMcpServers(),
        dynamic: dynamic.map((tool) => ({
          name: dynamicToolId(tool),
          description: tool.description,
        })),
      };
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
      const metadata = yield* readMetadata();
      if (metadata.parentAgentId) {
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

    /** Routes a message delivered by an external producer. */
    *deliver(delivery): restate.Operation<void> {
      if (yield* restate.state().get<boolean>("deleted")) return;
      yield* requireTopLevelConversation();
      yield* route(delivery);
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
      yield* requireTopLevelConversation();
      profile.setInstructions(instructions);
      yield* notifications.publish("profile");
    },

    /**
     * Replaces the complete per-Agent guardrail list.
     *
     * Running Turns retain their initial profile snapshot; subsequent Turns
     * enforce the replacement list.
     */
    *setGuardrails({guardrails}): restate.Operation<void> {
      yield* requireNotDeleted();
      yield* requireTopLevelConversation();
      profile.setGuardrails(guardrails);
      yield* notifications.publish("profile");
    },

    /** Enables or disables built-in web search for subsequent turns. */
    *setWebSearchEnabled({enabled}): restate.Operation<void> {
      yield* requireNotDeleted();
      yield* requireTopLevelConversation();
      profile.setWebSearchEnabled(enabled);
      yield* notifications.publish("profile");
    },

    /**
     * Applies one atomic model-requested memory batch.
     *
     * Only the active, non-interrupting Turn may mutate this agent's memories.
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

      const result = yield* memory.apply(changes);
      if (result.applied) yield* notifications.publish("profile");
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
        yield* notifications.publish("approvals");
      }
      return true;
    },

    /**
     * Idempotently removes an approval request abandoned by interruption or
     * Turn failure.
     */
    *cancelApproval(request): restate.Operation<void> {
      if (yield* approvals.cancel(request)) {
        yield* notifications.publish("approvals");
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
      yield* notifications.publish("approvals");
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
        yield* notifications.publish("approvals");
      }
      const queuedMessages = finished.queuedEntries.filter(
        ({role}) => role === "user",
      ).length;
      if (
        queuedMessages > 0 &&
        !(yield* restate.state().get<boolean>("deleted"))
      ) {
        try {
          yield* startTurn(agentKey(), [
            ...finished.queuedEntries,
            {
              role: "event",
              type: "dispatch",
              queuedMessages,
            },
          ]);
        } catch (error) {
          // `finish` already cleared `turn` and `pending`, and failing here
          // would also stop AgentSession from appending this outcome. A
          // successor that cannot start (invalid MCP_SERVERS_JSON) parks its
          // input in `pending` instead; the next turn start picks it up.
          if (
            !(error instanceof TerminalError) ||
            error instanceof CancelledError
          )
            throw error;
          yield* activeTurn.enqueue(...finished.queuedEntries);
        }
      }
      return finished.outcome;
    },

    /** Advances a topic published by another owner (AgentSession history). */
    *publish(topic): restate.Operation<void> {
      yield* notifications.publish(topic);
    },
    *notifications() {
      return yield* notifications.read();
    },
    *watch({afterRevision, timeoutSeconds}) {
      return yield* notifications.watch(
        agentKey(),
        afterRevision,
        timeoutSeconds,
      );
    },
    *subscribe(subscription) {
      return yield* notifications.subscribe(subscription);
    },
    *unsubscribe({awakeableId}): restate.Operation<void> {
      yield* notifications.unsubscribe(awakeableId);
    },
  },
  options: {
    enableLazyState: true,
    handlers: {
      initialize: coordinationRetention,
      createSchedule: coordinationRetention,
      cancelSchedule: coordinationRetention,
      schedules: {shared: true, ...noRetention},
      fire: coordinationRetention,
      publish: coordinationRetention,
      notifications: {shared: true, ...coordinationRetention},
      watch: {
        shared: true,
        inactivityTimeout: {seconds: 1},
        ...coordinationRetention,
      },
      subscribe: coordinationRetention,
      unsubscribe: coordinationRetention,
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
      metadata: {shared: true, ...noRetention},
      children: {shared: true, ...noRetention},
      deleteMemory: noRetention,
      toolCatalog: {shared: true, ...noRetention},
      onTurnEnd: noRetention,
      updateMemory: noRetention,
      deliver: noRetention,
      requestApproval: coordinationRetention,
      cancelApproval: coordinationRetention,
      resolveApproval: coordinationRetention,
      approvals: {shared: true, ...noRetention},
      profile: {shared: true, ...noRetention},
    },
  },
});

// Idle Agents start a Turn. Busy Agents apply the producer's queue, steer, or
// interrupt policy using the same active-turn primitives as direct user
// interaction.
function* route(delivery: AgentDelivery): restate.Operation<void> {
  const current = yield* activeTurn.current();
  // Coalescing producers never stack: a recurring schedule firing faster
  // than the agent works would otherwise grow `pending` without bound
  // (queue) or interrupt every successor turn it caused (interrupt).
  if (
    current &&
    delivery.coalesce &&
    delivery.sourceId &&
    (yield* activeTurn.hasDelivery(delivery.source, delivery.sourceId))
  )
    return;
  if (!current) {
    yield* startTurn(agentKey(), [
      deliveryEvent(delivery, "start"),
      {role: "user", text: delivery.message, delivery: "turn"},
    ]);
    return;
  }

  if (current.interruptReason !== undefined || delivery.whenBusy === "queue") {
    yield* activeTurn.enqueue(deliveryEvent(delivery, "queue", current.id), {
      role: "user",
      text: delivery.message,
      delivery: "queued",
    });
    return;
  }

  if (delivery.whenBusy === "steer") {
    yield* activeTurn.steer(
      delivery.message,
      deliveryEvent(delivery, "steer", current.id),
    );
    return;
  }

  yield* activeTurn.enqueue(deliveryEvent(delivery, "interrupt", current.id), {
    role: "user",
    text: delivery.message,
    delivery: "queued",
  });
  yield* activeTurn.interrupt(
    delivery.interruptReason ??
      `${delivery.source} delivered a message that requested interruption`,
  );
}

function* requireNotDeleted(): restate.Operation<void> {
  if (yield* restate.state().get<boolean>("deleted"))
    throw new TerminalError("Agent has been deleted", {errorCode: 410});
}

// Tool callbacks can arrive after a turn has ended or begun interruption.
// Authorize against the controller's live snapshot, never the caller's copy.
function* requireActiveTurnTools(
  turnId: string,
  action: string,
): restate.Operation<AgentTools> {
  const current = yield* activeTurn.current();
  if (current?.id !== turnId || current.interruptReason !== undefined)
    throw new TerminalError(
      `${action} requires the active, non-interrupting Turn`,
      {errorCode: 409},
    );
  return current.tools;
}

// Turn callers are checked against the live turn's grants; direct callers
// (ingress, the UI) omit the turn ID.
function* requireScheduleAccess(
  turnId: string | undefined,
  tool: "createSchedule" | "cancelSchedule",
  action: string,
  denied: string,
): restate.Operation<void> {
  yield* requireNotDeleted();
  if (turnId === undefined) return;
  const tools = yield* requireActiveTurnTools(turnId, action);
  if (!selected(tools.builtin, tool))
    throw new TerminalError(denied, {errorCode: 403});
}

// A retried creation call names the same child; delegation can only start
// that child for the originating tool call.
function childAgentId(
  parentAgentId: string,
  turnId: string,
  toolCallId: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify(["sub-agent", parentAgentId, turnId, toolCallId]))
    .digest("hex");
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
// Child instructions, guardrails, and tool grants are fixed at creation. Its
// own turn may still update memory; direct callers cannot widen its access.
function* requireTopLevelConversation(): restate.Operation<void> {
  const metadata = yield* restate
    .state()
    .get<{parentAgentId?: string}>("metadata");
  if (metadata?.parentAgentId)
    throw new TerminalError(
      "Only a top-level agent accepts direct messages or profile changes",
      {errorCode: 403},
    );
}

// Every entry path (ask, delivery, queued successor, delegation) snapshots the
// same profile before dispatch. AgentSession owns the history those entries open.
function* startTurn(
  agentId: string,
  entries: ConversationEntry[],
): restate.Operation<string> {
  const agentProfile = yield* profile.read();
  const metadata = yield* readMetadata();
  // Read configuration before any state change: an invalid configuration
  // throws, and state written by a failed invocation is not rolled back.
  const servers = yield* configuredMcpServers();
  // Direct ask implicitly creates the agent; persist its default metadata so
  // later initialization cannot change its parent.
  if (!(yield* restate.state().get("metadata")))
    restate.state().set("metadata", metadata);
  // Normally empty while idle. It holds a successor's input that onTurnEnd
  // could not start, which must open the next turn ahead of the new input.
  const parked = yield* activeTurn.drainPending();
  const tools = resolveMcpGrants(agentProfile.tools, servers);
  return yield* activeTurn.start(agentId, {
    ...agentProfile,
    agentName: metadata.name,
    tools,
    mcpServers: servers.filter((server) =>
      tools.mcp.some(
        (grant) =>
          grant.connectionId === server.id &&
          (grant.tools.mode === "all" || grant.tools.names.length > 0),
      ),
    ),
    entries: [...parked, ...entries],
  });
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

function* readMetadata(): restate.Operation<AgentMetadata> {
  yield* requireNotDeleted();
  return (
    (yield* restate.sharedState().get<AgentMetadata>("metadata")) ?? {
      name: agentKey(),
    }
  );
}
function* readChildren(): restate.Operation<ChildAgent[]> {
  return (yield* restate.sharedState().get<ChildAgent[]>("children")) ?? [];
}
