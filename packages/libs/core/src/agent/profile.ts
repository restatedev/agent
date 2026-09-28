// The agent's durable profile: instructions, guardrails, tool grants and web
// search, plus the memory index (memories.ts). A turn receives a snapshot
// when it starts and never reads this state directly, so changes apply from
// the next turn.

import {
  type AgentProfile,
  type AgentTools,
  DEFAULT_AGENT_TOOLS,
  type Guardrail,
  type ProfileUpdate,
} from "@restate-agents/types";
import * as restate from "@restatedev/restate-sdk-gen";

import {discoverAgentTools} from "../session/dynamic-tools.js";
import {configuredMcpServers} from "../session/mcp-config.js";
import {dynamicToolId} from "../session/tool-permissions.js";
import * as agentTools from "../session/tools.js";
import {type AgentHandlers, requireDirectAccess} from "./guards.js";
import * as memories from "./memories.js";
import * as notifications from "./notifications.js";

const INSTRUCTIONS = "profile/instructions";
const GUARDRAILS = "profile/guardrails";
const TOOLS = "profile/tools";
const WEB_SEARCH_ENABLED = "profile/web-search-enabled";

export const handlers: AgentHandlers<
  "profile" | "updateProfile" | "toolCatalog"
> = {
  *profile() {
    return yield* read();
  },

  *updateProfile(update) {
    yield* requireDirectAccess();
    yield* write(update);
  },

  /** Every tool an operator can grant, for the tool-permission UI. */
  *toolCatalog() {
    const dynamic = yield* discoverAgentTools(agentTools.names);
    return {
      builtin: agentTools.builtinCatalog,
      mcp: yield* configuredMcpServers(),
      dynamic: dynamic.map((tool) => ({
        name: dynamicToolId(tool),
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
    memories: yield* memories.index(),
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

/** Removes the whole profile, memories included, from a retired agent. */
export function* clear(): restate.Operation<void> {
  for (const key of [INSTRUCTIONS, GUARDRAILS, TOOLS, WEB_SEARCH_ENABLED])
    restate.state().clear(key);
  yield* memories.clear();
}
