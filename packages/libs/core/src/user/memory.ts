// Shared semantic memory for one user, serialized by the User VO.
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

/** Atomic keyed changes avoid replacing another agent's unrelated memories. */
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
      error: `user memory is limited to ${MAX_MEMORIES} entries`,
    };
  if (updated.length) restate.state().set(MEMORIES, updated);
  else restate.state().clear(MEMORIES);
  return {applied: true, memoryCount: updated.length};
}
