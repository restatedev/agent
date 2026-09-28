// Sub-agents: children this agent created, the delegated tasks it is
// waiting on, and the attenuated profile a child inherits.
//
// A child is an ordinary Agent whose metadata names its parent. Its profile
// is fixed at creation and can only narrow the parent's access; only the
// parent may start, interrupt or retire its turns.

import {createHash} from "node:crypto";

import type {
  AgentConfig,
  AgentTools,
  ChildAgent,
  SubAgentConfig,
  ToolSelection,
} from "@restate-agents/types";
import {AgentDefinition} from "@restate-agents/types/services";
import {TerminalError} from "@restatedev/restate-sdk";
import * as restate from "@restatedev/restate-sdk-gen";

import * as agentTools from "../session/tools.js";
import {listState, objectKey} from "../state.js";
import * as activeTurn from "./active-turn.js";
import * as approvals from "./approvals.js";
import {
  type AgentHandlers,
  forbidden,
  readMetadata,
  requireLive,
  requireTurnTool,
} from "./guards.js";
import * as notifications from "./notifications.js";
import * as profile from "./profile.js";
import {startTurn} from "./turns.js";

/** A delegated child turn a parent tool call is waiting on. */
type SubAgentTask = {
  turnId: string;
  toolCallId: string;
  agentId: string;
  childTurnId: string;
};

const children = listState<ChildAgent>("children");
const tasks = listState<SubAgentTask>("sub-agent-tasks");
const tombstone = (agentId: string) => `deleted-child:${agentId}`;

export const handlers: AgentHandlers<
  | "createSubAgent"
  | "startSubAgentTask"
  | "finishSubAgentTask"
  | "deleteSubAgent"
  | "listSubAgents"
  | "children"
  | "startDelegatedTurn"
  | "interruptDelegatedTurn"
> = {
  // Parent side. Each is a tool callback authorized against the live turn.

  *createSubAgent({turnId, toolCallId, ...config}) {
    yield* requireLive();
    const tools = yield* requireTurnTool(
      turnId,
      "createSubAgent",
      "This agent cannot create sub-agents",
    );
    if ((yield* readMetadata()).parentAgentId)
      throw forbidden("This agent cannot create sub-agents");
    const inherited = subAgentProfile(
      yield* profile.read(),
      tools,
      config,
      agentTools.names,
    );
    const agentId = childAgentId(turnId, toolCallId);
    if (yield* restate.state().get<boolean>(tombstone(agentId)))
      throw new TerminalError("Child has been deleted", {errorCode: 410});
    const existing = (yield* children.get()).find((c) => c.agentId === agentId);
    if (existing) return existing;
    const child = {agentId, name: config.name, parentAgentId: objectKey()};
    // Child initialization never calls its parent while this lock is held.
    yield* restate.client(AgentDefinition, agentId).initialize({
      name: child.name,
      parentAgentId: objectKey(),
      profile: inherited,
    });
    yield* children.update((all) => [...all, child]);
    yield* notifications.publish("profile");
    return child;
  },

  *startSubAgentTask({turnId, toolCallId, agentId, message, source}) {
    yield* requireLive();
    yield* requireTurnTool(
      turnId,
      source,
      "This agent cannot delegate this task",
    );
    if ((yield* readMetadata()).parentAgentId)
      throw forbidden("This agent cannot delegate this task");
    if (
      source === "createSubAgent" &&
      agentId !== childAgentId(turnId, toolCallId)
    )
      throw forbidden("Creation can only start its newly created child");
    if (!(yield* children.get()).some((c) => c.agentId === agentId))
      throw forbidden("Agent is not a direct child of this parent");
    const all = yield* tasks.get();
    const existing = all.find(
      (t) => t.turnId === turnId && t.toolCallId === toolCallId,
    );
    if (existing) return {turnId: existing.childTurnId};
    const child = yield* restate
      .client(AgentDefinition, agentId)
      .startDelegatedTurn({
        parentAgentId: objectKey(),
        parentTurnId: turnId,
        message,
      });
    tasks.set([
      ...all,
      {turnId, toolCallId, agentId, childTurnId: child.turnId},
    ]);
    return child;
  },

  // Also covers abandoned PTC branches and interrupted parent waits. The
  // child checks the exact turn ID, so a late cleanup cannot stop a follow-up.
  *finishSubAgentTask({turnId, toolCallId}) {
    yield* stopTasks(
      (t) => t.turnId === turnId && t.toolCallId === toolCallId,
      "Parent stopped waiting for this task",
    );
  },

  *deleteSubAgent({turnId, agentId}) {
    yield* requireLive();
    yield* requireTurnTool(
      turnId,
      "deleteSubAgent",
      "This agent cannot delete sub-agents",
    );
    const all = yield* children.get();
    if (!all.some((c) => c.agentId === agentId)) return false;
    restate.state().set(tombstone(agentId), true);
    children.set(all.filter((c) => c.agentId !== agentId));
    yield* retire(agentId);
    yield* notifications.publish("profile");
    return true;
  },

  *listSubAgents({turnId}) {
    yield* requireLive();
    yield* requireTurnTool(
      turnId,
      "listSubAgents",
      "This agent cannot list sub-agents",
    );
    return yield* children.get();
  },

  *children() {
    return yield* children.get();
  },

  // Child side. Only the owning parent may drive a child's turns.

  *startDelegatedTurn({parentAgentId, parentTurnId, message}) {
    yield* requireLive();
    if ((yield* readMetadata()).parentAgentId !== parentAgentId)
      throw forbidden("Only the owning parent can submit a child task");
    if (yield* activeTurn.current())
      throw new TerminalError(
        "Sub-agent is busy; wait for its current task before sending a follow-up",
        {errorCode: 400},
      );
    const turnId = yield* startTurn([
      {
        role: "user",
        text: message,
        delegatedBy: {agentId: parentAgentId, turnId: parentTurnId},
        delivery: "turn",
      },
    ]);
    return {turnId};
  },

  *interruptDelegatedTurn({parentAgentId, turnId, reason}) {
    if ((yield* readMetadata()).parentAgentId !== parentAgentId)
      throw forbidden("Agent is not a direct child of this parent");
    if ((yield* activeTurn.current())?.id !== turnId) return;
    yield* activeTurn.interrupt(reason);
    yield* approvals.clearTurn(turnId);
  },
};

/** Interrupts the child turns started by `turnId`, or by every turn. */
export function* stopTasksOf(
  turnId: string | undefined,
  reason: string,
): restate.Operation<void> {
  yield* stopTasks((t) => turnId === undefined || t.turnId === turnId, reason);
}

/** Retires every child of a retiring parent. */
export function* retireAll(): restate.Operation<void> {
  for (const child of yield* children.get()) yield* retire(child.agentId);
  children.clear();
}

function* stopTasks(
  match: (task: SubAgentTask) => boolean,
  reason: string,
): restate.Operation<void> {
  const all = yield* tasks.get();
  for (const task of all.filter(match))
    yield* restate
      .sendClient(AgentDefinition, task.agentId)
      .interruptDelegatedTurn({
        parentAgentId: objectKey(),
        turnId: task.childTurnId,
        reason,
      });
  tasks.set(all.filter((task) => !match(task)));
}

function* retire(agentId: string): restate.Operation<void> {
  yield* restate
    .sendClient(AgentDefinition, agentId)
    .retire({parentAgentId: objectKey()});
}

// A retried creation call names the same child; delegation can only start
// that child for the originating tool call.
function childAgentId(turnId: string, toolCallId: string): string {
  return createHash("sha256")
    .update(JSON.stringify(["sub-agent", objectKey(), turnId, toolCallId]))
    .digest("hex");
}

function subset(requested: ToolSelection, allowed: ToolSelection): boolean {
  return (
    allowed.mode === "all" ||
    (requested.mode === "selected" &&
      requested.names.every((name) => allowed.names.includes(name)))
  );
}

// A child has no children of its own and no independent scheduled turns.
const PARENT_ONLY_TOOLS = new Set([
  "createSubAgent",
  "messageSubAgent",
  "listSubAgents",
  "deleteSubAgent",
  "createSchedule",
  "listSchedules",
  "cancelSchedule",
]);

/**
 * Copy creation-time configuration, with runtime-enforced attenuation. Memories
 * are not inherited: a child starts with an empty memory of its own.
 */
export function subAgentProfile(
  parent: AgentConfig,
  grants: AgentTools,
  config: SubAgentConfig,
  builtins: readonly string[],
): AgentConfig {
  const tools = structuredClone(config.tools ?? grants);
  let denied: string | undefined;
  if (!subset(tools.builtin, grants.builtin)) {
    denied = "builtin selection";
  } else if (!subset(tools.dynamic, grants.dynamic)) {
    denied = "dynamic selection";
  } else {
    const invalidMcp = tools.mcp.find((grant) => {
      const allowed = grants.mcp.find(
        (item) => item.serverId === grant.serverId,
      );
      return !allowed || !subset(grant.tools, allowed.tools);
    });
    if (invalidMcp)
      denied = `MCP server ${JSON.stringify(invalidMcp.serverId)} or its tool selection`;
  }
  if (denied)
    throw new TerminalError(
      "Sub-agent tools cannot exceed the parent's current access: " +
        `${denied} is not permitted.` +
        " Built-in tools such as webSearch belong in builtin; dynamic names are service/handler IDs. Correct the selection, or use tools: null to inherit current access if no narrower restriction is needed.",
      {errorCode: 403},
    );
  // Remove inapplicable tools from both direct and PTC discovery. The child's
  // immutable grants should describe what it can actually do.
  tools.builtin = {
    mode: "selected",
    names: (tools.builtin.mode === "all"
      ? [...builtins]
      : tools.builtin.names
    ).filter((name) => !PARENT_ONLY_TOOLS.has(name)),
  };
  tools.mcpDefault = "disabled";
  const guardrails = structuredClone(parent.guardrails);
  for (const addition of config.guardrails ?? []) {
    const existing = guardrails.find((g) => g.id === addition.id);
    if (existing && existing.rule !== addition.rule)
      throw new TerminalError(
        "Sub-agent guardrails cannot replace inherited guardrails",
        {errorCode: 403},
      );
    if (!existing) guardrails.push(addition);
  }
  if (config.webSearchEnabled === true && !parent.webSearchEnabled)
    throw new TerminalError(
      "Sub-agent cannot enable web search when the parent has disabled it",
      {errorCode: 403},
    );
  const instructions = [
    parent.instructions,
    config.instructions
      ? `[Sub-agent task instructions]\n${config.instructions}`
      : undefined,
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    ...(instructions ? {instructions} : {}),
    guardrails,
    tools,
    webSearchEnabled: config.webSearchEnabled ?? parent.webSearchEnabled,
  };
}
