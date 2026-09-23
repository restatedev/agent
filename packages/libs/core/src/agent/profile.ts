// Durable profile for one Agent virtual object. Instructions, guardrails, and
// tool grants, web search, and memories belong to this agent.

import type {AgentProfile, AgentTools, Guardrail} from "@restate-agents/types";
import {DEFAULT_AGENT_TOOLS} from "@restate-agents/types";
import * as restate from "@restatedev/restate-sdk-gen";

import * as memory from "./memory.js";

const INSTRUCTIONS = "profile/instructions";
const GUARDRAILS = "profile/guardrails";
const TOOLS = "profile/tools";
const WEB_SEARCH_ENABLED = "profile/web-search-enabled";

/**
 * Handler-scoped access to persistent profile state for the current Agent.
 *
 * Mutations rely on exclusive Agent handler serialization. A Turn receives a
 * snapshot and never reads this state directly.
 */
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
    memories: yield* memory.read(),
    tools: tools ?? structuredClone(DEFAULT_AGENT_TOOLS),
    webSearchEnabled: webSearchEnabled ?? true,
  };
}

/** Controls the built-in web search capability for future turns. */
export function setWebSearchEnabled(enabled: boolean): void {
  restate.state().set(WEB_SEARCH_ENABLED, enabled);
}

/** Replaces or clears the persistent user-authored instructions. */
export function setInstructions(instructions: string | null): void {
  const value = instructions?.trim();
  if (value) {
    restate.state().set(INSTRUCTIONS, value);
  } else {
    restate.state().clear(INSTRUCTIONS);
  }
}

/** Replaces the complete user-authored natural-language policy set. */
export function setGuardrails(guardrails: Guardrail[]): void {
  if (guardrails.length > 0) {
    restate.state().set(GUARDRAILS, guardrails);
  } else {
    restate.state().clear(GUARDRAILS);
  }
}

/** Replaces explicit per-agent capabilities for subsequent turns. */
export function setTools(tools: AgentTools): void {
  restate.state().set(TOOLS, tools);
}
