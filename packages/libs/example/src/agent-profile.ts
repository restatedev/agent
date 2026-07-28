// Durable prompt context for one Agent virtual object. Instructions and
// guardrails are user-managed configuration; memories are a bounded keyed
// collection managed by the model through an Agent handler.

import {
  all,
  type Operation,
  sharedState,
  state,
} from "@restatedev/restate-sdk-gen";
import type {
  AgentProfile,
  Guardrail,
  MemoryChange,
  MemoryEntry,
  MemoryUpdateResult,
} from "./types.js";

const INSTRUCTIONS = "profile/instructions";
const MEMORIES = "profile/memories";
const GUARDRAILS = "profile/guardrails";
const MAX_MEMORIES = 32;

/**
 * Handler-scoped access to persistent prompt context for the current Agent.
 *
 * Mutations rely on exclusive Agent handler serialization. A Turn receives a
 * snapshot and never reads this state directly.
 */
export const profile = {
  *read(): Operation<AgentProfile> {
    const [instructions, memories, guardrails] = yield* all([
      sharedState().get<string>(INSTRUCTIONS),
      sharedState().get<MemoryEntry[]>(MEMORIES),
      sharedState().get<Guardrail[]>(GUARDRAILS),
    ]);
    return {
      ...(instructions ? {instructions} : {}),
      memories: memories ?? [],
      guardrails: guardrails ?? [],
    };
  },

  setInstructions(instructions: string | null): void {
    const value = instructions?.trim();
    if (value) {
      state().set(INSTRUCTIONS, value);
    } else {
      state().clear(INSTRUCTIONS);
    }
  },

  setGuardrails(guardrails: Guardrail[]): void {
    if (guardrails.length > 0) {
      state().set(GUARDRAILS, guardrails);
    } else {
      state().clear(GUARDRAILS);
    }
  },

  *applyMemory(changes: MemoryChange[]): Operation<MemoryUpdateResult> {
    const memories = (yield* sharedState().get<MemoryEntry[]>(MEMORIES)) ?? [];
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
      state().set(MEMORIES, updated);
    } else {
      state().clear(MEMORIES);
    }
    return {applied: true, memoryCount: updated.length};
  },
};
