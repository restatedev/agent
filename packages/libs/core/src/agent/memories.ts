// The agent's memories: an index in one state key and each memory's content
// in a key of its own. Agent runs with lazy state, so a handler loads only
// the keys it reads. A turn is told only how many memories exist; the model
// finds relevant ones with searchMemories and reads them with readMemories.
//
// The index holds `{nextId, entries}`. IDs are `mem0`, `mem1`, … and are
// never reused, so a deleted memory's ID cannot come back meaning something
// else.

import type {
  Memory,
  MemoryChange,
  MemoryIndexEntry,
  MemoryUpdateResult,
} from "@restate-agents/types";
import * as restate from "@restatedev/restate-sdk-gen";
import MiniSearch from "minisearch";

import {rankedIds, words} from "../text-search.js";
import * as activeTurn from "./active-turn.js";
import {type AgentHandlers, requireDirectAccess} from "./guards.js";
import * as notifications from "./notifications.js";

const INDEX = "memory/index";

type MemoryIndex = {
  nextId: number;
  entries: MemoryIndexEntry[];
};

const EMPTY_INDEX: MemoryIndex = {nextId: 0, entries: []};
const SEARCH_LIMIT = 10;

function contentKey(id: string): string {
  return `memory/${id}`;
}

export const handlers: AgentHandlers<
  "searchMemories" | "readMemories" | "deleteMemory" | "updateMemory"
> = {
  /**
   * The index entries that best match `query`. A shared handler, so it reads
   * only the index key and never waits for the controller's lock.
   */
  *searchMemories({query}) {
    const {entries} = yield* readIndex();
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const index = new MiniSearch({
      fields: ["description"],
      searchOptions: {prefix: true},
    });
    index.addAll(
      entries.map(({id, description}) => ({
        id,
        description: words(description),
      })),
    );
    const found: MemoryIndexEntry[] = [];
    for (const id of rankedIds(index, query).slice(0, SEARCH_LIMIT)) {
      const entry = byId.get(id);
      if (entry) found.push(entry);
    }
    return found;
  },

  /** Full memories for the given IDs, in index order; unknown IDs are skipped. */
  *readMemories({ids}) {
    const wanted = new Set(ids);
    const entries = (yield* readIndex()).entries.filter(({id}) =>
      wanted.has(id),
    );
    const contents = yield* restate.all(
      entries.map(({id}) => restate.sharedState().get<string>(contentKey(id))),
    );
    const found: Memory[] = [];
    entries.forEach((entry, i) => {
      const content = contents[i];
      if (content) found.push({...entry, content});
    });
    return found;
  },

  *deleteMemory({id}) {
    yield* requireDirectAccess();
    const index = yield* readIndex();
    if (!index.entries.some((entry) => entry.id === id)) return false;
    yield* apply([{operation: "delete", id}]);
    return true;
  },

  /** Applies one atomic batch requested by the active, non-interrupting turn. */
  *updateMemory({turnId, changes}) {
    if (!(yield* activeTurn.accepting(turnId)))
      return {
        applied: false,
        error: "memory update rejected because its Turn is no longer active",
      };
    return yield* apply(changes);
  },
};

/** The memory index; the only memory key a turn snapshot reads. */
export function* index(): restate.Operation<MemoryIndexEntry[]> {
  return (yield* readIndex()).entries;
}

/** Removes every memory and the index, for a retired agent. */
export function* clear(): restate.Operation<void> {
  const {entries} = yield* readIndex();
  for (const {id} of entries) restate.state().clear(contentKey(id));
  restate.state().clear(INDEX);
}

function* readIndex(): restate.Operation<MemoryIndex> {
  return (yield* restate.sharedState().get<MemoryIndex>(INDEX)) ?? EMPTY_INDEX;
}

/**
 * Validates the whole batch against the index before writing anything, so a
 * batch that names an unknown memory changes nothing.
 */
function* apply(
  changes: MemoryChange[],
): restate.Operation<MemoryUpdateResult> {
  const index = yield* readIndex();
  const entries = [...index.entries];
  let nextId = index.nextId;
  const ids: string[] = [];
  const writes = new Map<string, string | undefined>();

  for (const change of changes) {
    if (change.operation === "create") {
      const id = `mem${nextId}`;
      nextId += 1;
      entries.push({id, description: change.description});
      writes.set(id, change.content);
      ids.push(id);
      continue;
    }
    const position = entries.findIndex(({id}) => id === change.id);
    if (position < 0)
      return {applied: false, error: `memory ${change.id} does not exist`};
    if (change.operation === "update") {
      entries[position] = {id: change.id, description: change.description};
      writes.set(change.id, change.content);
    } else {
      entries.splice(position, 1);
      writes.set(change.id, undefined);
    }
    ids.push(change.id);
  }

  const state = restate.state();
  for (const [id, content] of writes) {
    if (content === undefined) state.clear(contentKey(id));
    else state.set(contentKey(id), content);
  }
  state.set(INDEX, {nextId, entries} satisfies MemoryIndex);
  yield* notifications.publish("profile");
  return {applied: true, ids};
}
