// Durable prompt context for one Agent virtual object. Instructions and
// guardrails are user-managed configuration; memories are a bounded keyed
// collection managed by the model through an Agent handler.

import type {
  AgentProfile,
  Guardrail,
  MemoryChange,
  MemoryEntry,
} from "@restate-agents/types";
import * as restate from "@restatedev/restate-sdk-gen";
import type {MemoryUpdateResult} from "../internal-types.js";

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
  *read(): restate.Operation<AgentProfile> {
    const [instructions, memories, guardrails] = yield* restate.all([
      restate.sharedState().get<string>(INSTRUCTIONS),
      restate.sharedState().get<MemoryEntry[]>(MEMORIES),
      restate.sharedState().get<Guardrail[]>(GUARDRAILS),
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
      restate.state().set(INSTRUCTIONS, value);
    } else {
      restate.state().clear(INSTRUCTIONS);
    }
  },

  setGuardrails(guardrails: Guardrail[]): void {
    if (guardrails.length > 0) {
      restate.state().set(GUARDRAILS, guardrails);
    } else {
      restate.state().clear(GUARDRAILS);
    }
  },

  *applyMemory(changes: MemoryChange[]): restate.Operation<MemoryUpdateResult> {
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
  },
};
