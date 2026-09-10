// Durable profile for one Agent virtual object. Instructions, guardrails, and
// Tool grants and web search are user-managed configuration; memories are a
// bounded keyed collection managed by the model through an Agent handler.

import type {
  AgentProfile,
  AgentTools,
  Guardrail,
  MemoryChange,
  MemoryEntry,
} from "@restate-agents/types";
import {DEFAULT_AGENT_TOOLS} from "@restate-agents/types";
import * as restate from "@restatedev/restate-sdk-gen";
import type {MemoryUpdateResult} from "../internal-types.js";

const INSTRUCTIONS = "profile/instructions";
const MEMORIES = "profile/memories";
const GUARDRAILS = "profile/guardrails";
const TOOLS = "profile/tools";
const WEB_SEARCH_ENABLED = "profile/web-search-enabled";
const MAX_MEMORIES = 32;

/**
 * Handler-scoped access to persistent profile state for the current Agent.
 *
 * Mutations rely on exclusive Agent handler serialization. A Turn receives a
 * snapshot and never reads this state directly.
 */
export function* read(): restate.Operation<AgentProfile> {
  const [instructions, memories, guardrails, tools, webSearchEnabled] =
    yield* restate.all([
      restate.sharedState().get<string>(INSTRUCTIONS),
      restate.sharedState().get<MemoryEntry[]>(MEMORIES),
      restate.sharedState().get<Guardrail[]>(GUARDRAILS),
      restate.sharedState().get<AgentTools>(TOOLS),
      restate.sharedState().get<boolean>(WEB_SEARCH_ENABLED),
    ]);
  return {
    ...(instructions ? {instructions} : {}),
    memories: memories ?? [],
    guardrails: guardrails ?? [],
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

/** Atomically applies model-requested changes to the bounded Agent memory. */
export function* applyMemory(
  changes: MemoryChange[],
): restate.Operation<MemoryUpdateResult> {
  const memories =
    (yield* restate.sharedState().get<MemoryEntry[]>(MEMORIES)) ?? [];
  const updated = [...memories];

  for (const change of changes) {
    const index = updated.findIndex(({key}) => key === change.key);
    if (change.operation === "delete") {
      if (index >= 0) {
        updated.splice(index, 1);
      }
    } else if (index >= 0) {
      updated[index] = {key: change.key, content: change.content};
    } else {
      updated.push({key: change.key, content: change.content});
    }
  }

  if (updated.length > MAX_MEMORIES) {
    return {
      applied: false,
      error: `memory is limited to ${MAX_MEMORIES} entries`,
    };
  }

  if (updated.length > 0) {
    restate.state().set(MEMORIES, updated);
  } else {
    restate.state().clear(MEMORIES);
  }
  return {applied: true, memoryCount: updated.length};
}
