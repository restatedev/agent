// Semantic memory for one agent, serialized by its controller.
import type {
  MemoryChange,
  MemoryEntry,
  MemoryUpdateResult,
} from "@restate-agents/types";
import * as restate from "@restatedev/restate-sdk-gen";

const MEMORIES = "memories";
const MAX_MEMORIES = 32;

export function* read(): restate.Operation<MemoryEntry[]> {
  return (yield* restate.sharedState().get<MemoryEntry[]>(MEMORIES)) ?? [];
}

/** Atomic keyed changes avoid replacing unrelated memory entries. */
export function* apply(
  changes: MemoryChange[],
): restate.Operation<MemoryUpdateResult> {
  const updated = [...(yield* read())];
  for (const change of changes) {
    const index = updated.findIndex(({key}) => key === change.key);
    if (change.operation === "delete") {
      if (index >= 0) updated.splice(index, 1);
    } else if (index >= 0) {
      updated[index] = {key: change.key, content: change.content};
    } else {
      updated.push({key: change.key, content: change.content});
    }
  }
  if (updated.length > MAX_MEMORIES)
    return {
      applied: false,
      error: `agent memory is limited to ${MAX_MEMORIES} entries`,
    };
  if (updated.length) restate.state().set(MEMORIES, updated);
  else restate.state().clear(MEMORIES);
  return {applied: true, memoryCount: updated.length};
}

export function clear(): void {
  restate.state().clear(MEMORIES);
}
