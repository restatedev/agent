// The agent's durable profile: instructions, guardrails, tool grants, web
// search and memories. A turn receives a snapshot when it starts and never
// reads this state directly, so changes apply from the next turn.

import {
  type AgentProfile,
  type AgentTools,
  DEFAULT_AGENT_TOOLS,
  type Guardrail,
  type MemoryChange,
  type MemoryEntry,
  type ProfileUpdate,
} from "@restate-agents/types";
import * as restate from "@restatedev/restate-sdk-gen";

import {configuredMcpServers} from "../session/mcp-config.js";
import {discoverRestateTools} from "../session/restate-tools.js";
import * as agentTools from "../session/tools.js";
import {listState} from "../state.js";
import * as activeTurn from "./active-turn.js";
import {type AgentHandlers, requireDirectAccess} from "./guards.js";
import * as notifications from "./notifications.js";

const INSTRUCTIONS = "profile/instructions";
const GUARDRAILS = "profile/guardrails";
const TOOLS = "profile/tools";
const WEB_SEARCH_ENABLED = "profile/web-search-enabled";
const memories = listState<MemoryEntry>("memories");
const MAX_MEMORIES = 32;

export const handlers: AgentHandlers<
  "profile" | "updateProfile" | "deleteMemory" | "updateMemory" | "toolCatalog"
> = {
  *profile() {
    return yield* read();
  },

  *updateProfile(update) {
    yield* requireDirectAccess();
    yield* write(update);
  },

  *deleteMemory({key}) {
    yield* requireDirectAccess();
    const all = yield* memories.get();
    if (!all.some((entry) => entry.key === key)) return false;
    yield* applyMemory([{operation: "delete", key}]);
    return true;
  },

  /** Applies one atomic batch requested by the active, non-interrupting turn. */
  *updateMemory({turnId, changes}) {
    if (!(yield* activeTurn.accepting(turnId)))
      return {
        applied: false,
        error: "memory update rejected because its Turn is no longer active",
      };
    return yield* applyMemory(changes);
  },

  /** Every tool an operator can grant, for the tool-permission UI. */
  *toolCatalog() {
    const dynamic = yield* discoverRestateTools(() => true);
    return {
      builtin: agentTools.builtinCatalog(),
      mcp: yield* configuredMcpServers(),
      dynamic: Object.values(dynamic).map(({id, tool}) => ({
        name: id,
        description: tool.description,
      })),
    };
  },
};

export function* read(): restate.Operation<AgentProfile> {
  const [instructions, guardrails, tools, webSearchEnabled] =
    yield* restate.all([
      restate.sharedState().get<string>(INSTRUCTIONS),
      restate.sharedState().get<Guardrail[]>(GUARDRAILS),
      restate.sharedState().get<AgentTools>(TOOLS),
      restate.sharedState().get<boolean>(WEB_SEARCH_ENABLED),
    ]);
  return {
    ...(instructions ? {instructions} : {}),
    guardrails: guardrails ?? [],
    memories: yield* memories.get(),
    tools: tools ?? structuredClone(DEFAULT_AGENT_TOOLS),
    webSearchEnabled: webSearchEnabled ?? true,
  };
}

/** Replaces each given field and publishes the change. */
export function* write(update: ProfileUpdate): restate.Operation<void> {
  const state = restate.state();
  if (update.instructions !== undefined) {
    const value = update.instructions?.trim();
    if (value) state.set(INSTRUCTIONS, value);
    else state.clear(INSTRUCTIONS);
  }
  if (update.guardrails)
    if (update.guardrails.length > 0) state.set(GUARDRAILS, update.guardrails);
    else state.clear(GUARDRAILS);
  if (update.tools) state.set(TOOLS, update.tools);
  if (update.webSearchEnabled !== undefined)
    state.set(WEB_SEARCH_ENABLED, update.webSearchEnabled);
  yield* notifications.publish("profile");
}

/** Keyed changes applied atomically, so unrelated entries are never replaced. */
export function* applyMemory(changes: MemoryChange[]) {
  const updated = [...(yield* memories.get())];
  for (const change of changes) {
    const index = updated.findIndex(({key}) => key === change.key);
    if (change.operation === "delete") {
      if (index >= 0) updated.splice(index, 1);
    } else {
      const entry = {key: change.key, content: change.content};
      if (index >= 0) updated[index] = entry;
      else updated.push(entry);
    }
  }
  if (updated.length > MAX_MEMORIES)
    return {
      applied: false as const,
      error: `agent memory is limited to ${MAX_MEMORIES} entries`,
    };
  memories.set(updated);
  yield* notifications.publish("profile");
  return {applied: true as const, memoryCount: updated.length};
}

/** Removes the whole profile, memories included, from a retired agent. */
export function clear(): void {
  for (const key of [INSTRUCTIONS, GUARDRAILS, TOOLS, WEB_SEARCH_ENABLED])
    restate.state().clear(key);
  memories.clear();
}
