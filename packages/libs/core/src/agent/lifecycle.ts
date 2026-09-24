// Agent creation and retirement.

import type {AgentMetadata} from "@restate-agents/types";
import {AgentSessionDefinition} from "@restate-agents/types/services";
import * as restate from "@restatedev/restate-sdk-gen";

import {objectKey} from "../state.js";
import * as activeTurn from "./active-turn.js";
import * as approvals from "./approvals.js";
import {
  type AgentHandlers,
  conflict,
  forbidden,
  isDeleted,
  readMetadata,
  requireLive,
} from "./guards.js";
import * as notifications from "./notifications.js";
import * as profile from "./profile.js";
import * as schedules from "./schedules.js";
import * as subAgents from "./sub-agents.js";

export const handlers: AgentHandlers<"initialize" | "retire" | "metadata"> = {
  /** Creates the agent once. A retry is a no-op; the parent is immutable. */
  *initialize({profile: initial, ...metadata}) {
    yield* requireLive();
    const existing = yield* restate.state().get<AgentMetadata>("metadata");
    if (existing) {
      if (existing.parentAgentId !== metadata.parentAgentId)
        throw conflict("Agent parent is immutable");
      return;
    }
    restate.state().set("metadata", metadata);
    if (initial) {
      yield* profile.applyMemory(
        initial.memories.map((entry) => ({
          operation: "set" as const,
          ...entry,
        })),
      );
      yield* profile.write({
        instructions: initial.instructions ?? null,
        guardrails: initial.guardrails,
        tools: initial.tools,
        webSearchEnabled: initial.webSearchEnabled,
      });
    } else {
      yield* notifications.publish("profile");
    }
  },

  /**
   * Deletes the agent and, recursively, its children. Only the parent may
   * retire a child; a top-level agent is retired by a direct call.
   */
  *retire({parentAgentId}) {
    if ((yield* readMetadata()).parentAgentId !== parentAgentId)
      throw forbidden("Only the parent can retire a child");
    if (yield* isDeleted()) return;
    restate.state().set("deleted", true);
    activeTurn.clearPending();
    yield* subAgents.stopTasksOf(undefined, "Parent deleted");
    yield* activeTurn.interrupt("Agent deleted");
    yield* approvals.clearAll();
    yield* schedules.clearAll();
    // `profile` is a shared handler with no deleted check; clearing is what
    // keeps a retired agent's memories and instructions from staying
    // readable. `metadata` stays so a repeated retire still sees its parent,
    // and `turn` stays until the interrupted invocation reports to onTurnEnd.
    profile.clear();
    yield* subAgents.retireAll();
    // One-way: AgentSession.retire queues behind the interrupted turn, which
    // still needs this controller's lock to report its outcome.
    yield* restate.sendClient(AgentSessionDefinition, objectKey()).retire();
    yield* notifications.publish("profile");
  },

  *metadata() {
    yield* requireLive();
    return yield* readMetadata();
  },
};
