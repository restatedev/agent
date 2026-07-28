// Durable conversation history for one Agent virtual object. Turn lifecycle
// state and pending work belong to agent-turn.ts.
//
// The append-only transcript remains the source of truth. User messages record
// how they originally arrived; later routing decisions are separate lifecycle
// events. A rolling summary is a replaceable model-context checkpoint over an
// older prefix of that log.

import * as restate from "@restatedev/restate-sdk-gen";
import type {ConversationEntry, HistoryPage} from "./types.js";

type StoredEntry = {
  sequence: number;
  entry: ConversationEntry;
};

type ConversationSummary = {
  through: number;
  text: string;
};

export type ConversationCompactionPlan = {
  baseThrough: number;
  through: number;
};

type HistoryMeta = {
  nextSequence: number;
  compaction?: ConversationCompactionPlan;
};

type HistoryWatcher = {
  awakeableId: string;
  fromSequence: number;
};

type ConversationContext = {
  summary?: string;
  entries: ConversationEntry[];
};

export type ConversationCompactionInput = ConversationCompactionPlan & {
  previousSummary?: string;
  entries: ConversationEntry[];
};

export type ConversationCompactionResult = ConversationCompactionPlan &
  (
    | {
        status: "completed";
        summary: string;
      }
    | {
        status: "failed";
        error: string;
      }
  );

const HISTORY_META = "history/meta";
const HISTORY_SUMMARY = "history/summary";
const HISTORY_WATCHERS = "history/watchers";

const CHUNK_SIZE = 32;
const COMPACT_AFTER_MESSAGES = 32;

function chunkKey(index: number): string {
  return `history/chunk/${index}`;
}

function samePlan(
  left: ConversationCompactionPlan,
  right: ConversationCompactionPlan,
): boolean {
  return (
    left.baseThrough === right.baseThrough && left.through === right.through
  );
}

function* readMeta(): restate.Operation<HistoryMeta> {
  return (
    (yield* restate.sharedState().get<HistoryMeta>(HISTORY_META)) ?? {
      nextSequence: 1,
    }
  );
}

function* readSummary(): restate.Operation<ConversationSummary | undefined> {
  return (
    (yield* restate.sharedState().get<ConversationSummary>(HISTORY_SUMMARY)) ??
    undefined
  );
}

function* readWatchers(): restate.Operation<HistoryWatcher[]> {
  return (
    (yield* restate.sharedState().get<HistoryWatcher[]>(HISTORY_WATCHERS)) ?? []
  );
}

function storeWatchers(watchers: HistoryWatcher[]): void {
  if (watchers.length === 0) {
    restate.state().clear(HISTORY_WATCHERS);
  } else {
    restate.state().set(HISTORY_WATCHERS, watchers);
  }
}

function* notifyWatchers(nextSequence: number): restate.Operation<void> {
  const watchers = yield* readWatchers();
  const waiting = watchers.filter(
    ({fromSequence}) => fromSequence >= nextSequence,
  );
  if (waiting.length === watchers.length) {
    return;
  }

  storeWatchers(waiting);
  for (const watcher of watchers) {
    if (watcher.fromSequence < nextSequence) {
      restate.resolveAwakeable<void>(watcher.awakeableId);
    }
  }
}

// Lazily walks a stable sequence range. Only the current chunk is loaded, so a
// caller that stops reading also avoids every later state read.
function readEntries(
  meta: HistoryMeta,
  fromSequence = 1,
  throughSequence = meta.nextSequence - 1,
) {
  let sequence = Math.max(1, fromSequence);
  const through = Math.min(throughSequence, meta.nextSequence - 1);
  let chunkIndex = -1;
  let chunk: StoredEntry[] = [];

  function* next(): restate.Operation<StoredEntry | undefined> {
    if (sequence > through) {
      return undefined;
    }
    const nextChunk = Math.floor((sequence - 1) / CHUNK_SIZE);
    if (nextChunk !== chunkIndex) {
      chunk =
        (yield* restate
          .sharedState()
          .get<StoredEntry[]>(chunkKey(nextChunk))) ?? [];
      chunkIndex = nextChunk;
    }
    const entry = chunk[(sequence - 1) % CHUNK_SIZE];
    sequence += 1;
    return entry;
  }

  return {
    next,
    *collect(
      limit = Number.POSITIVE_INFINITY,
    ): restate.Operation<StoredEntry[]> {
      const result: StoredEntry[] = [];
      while (result.length < limit) {
        const entry = yield* next();
        if (!entry) {
          break;
        }
        result.push(entry);
      }
      return result;
    },
  };
}

/**
 * Handler-scoped access to conversation history for the current Agent object.
 *
 * These operations must run inside an Agent handler. The object is a namespace
 * over Restate's current context and holds no process-local state.
 */
export const history = {
  *page(fromSequence: number, limit: number): restate.Operation<HistoryPage> {
    const meta = yield* readMeta();
    if (fromSequence >= meta.nextSequence) {
      return {entries: [], nextSequence: fromSequence};
    }

    const entries = yield* readEntries(meta, fromSequence).collect(limit);
    const last = entries.at(-1);
    return {
      entries,
      nextSequence: last ? last.sequence + 1 : fromSequence,
    };
  },

  *context(): restate.Operation<ConversationContext> {
    const meta = yield* readMeta();
    const summary = yield* readSummary();
    const entries = (yield* readEntries(
      meta,
      (summary?.through ?? 0) + 1,
    ).collect()).map(({entry}) => entry);
    return {summary: summary?.text, entries};
  },

  *append(...entries: ConversationEntry[]): restate.Operation<void> {
    if (entries.length === 0) {
      return;
    }

    const meta = yield* readMeta();
    let index = Math.floor((meta.nextSequence - 1) / CHUNK_SIZE);
    let chunk =
      (yield* restate.sharedState().get<StoredEntry[]>(chunkKey(index))) ?? [];

    for (const entry of entries) {
      if (chunk.length >= CHUNK_SIZE) {
        restate.state().set(chunkKey(index), chunk);
        index += 1;
        chunk = [];
      }
      chunk.push({sequence: meta.nextSequence, entry});
      meta.nextSequence += 1;
    }

    restate.state().set(chunkKey(index), chunk);
    restate.state().set(HISTORY_META, meta);
    yield* notifyWatchers(meta.nextSequence);
  },

  /**
   * Resolves a caller-owned awakeable when `fromSequence` becomes readable.
   *
   * Registration and the cursor check run in one exclusive Agent handler, so
   * an append cannot get lost between them. Callers wait on their own
   * awakeable and then read the regular cursor API.
   */
  *watch(fromSequence: number, awakeableId: string): restate.Operation<void> {
    const meta = yield* readMeta();
    if (fromSequence < meta.nextSequence) {
      restate.resolveAwakeable<void>(awakeableId);
      return;
    }

    const watchers = yield* readWatchers();
    if (!watchers.some((watcher) => watcher.awakeableId === awakeableId)) {
      watchers.push({awakeableId, fromSequence});
      restate.state().set(HISTORY_WATCHERS, watchers);
    }
  },

  // Called after a turn outcome is appended. Once enough conversation messages
  // have accumulated, reserve the entire finished prefix.
  *beginCompaction(): restate.Operation<
    ConversationCompactionPlan | undefined
  > {
    const meta = yield* readMeta();
    if (meta.compaction) {
      return undefined;
    }

    const summary = yield* readSummary();
    const baseThrough = summary?.through ?? 0;
    const entries = readEntries(meta, baseThrough + 1);
    let remaining = COMPACT_AFTER_MESSAGES;
    while (remaining > 0) {
      const stored = yield* entries.next();
      if (!stored) {
        return undefined;
      }
      if (stored.entry.role !== "event") {
        remaining -= 1;
      }
    }

    meta.compaction = {baseThrough, through: meta.nextSequence - 1};
    restate.state().set(HISTORY_META, meta);
    return meta.compaction;
  },

  // Resolve a reserved cursor range into model input from a shared Agent
  // handler. No state is mutated here.
  *readCompaction(
    plan: ConversationCompactionPlan,
  ): restate.Operation<ConversationCompactionInput | undefined> {
    const meta = yield* readMeta();
    if (!meta.compaction || !samePlan(meta.compaction, plan)) {
      return undefined;
    }

    const summary = yield* readSummary();
    const entries = (yield* readEntries(
      meta,
      plan.baseThrough + 1,
      plan.through,
    ).collect()).map(({entry}) => entry);
    return {
      ...plan,
      previousSummary: summary?.text,
      entries,
    };
  },

  // Apply only the result for the currently reserved finished-turn prefix.
  // Newer transcript entries do not invalidate that checkpoint.
  *finishCompaction(
    result: ConversationCompactionResult,
  ): restate.Operation<boolean> {
    const meta = yield* readMeta();
    const pending = meta.compaction;
    if (!pending || !samePlan(pending, result)) {
      return false;
    }

    delete meta.compaction;
    restate.state().set(HISTORY_META, meta);
    if (result.status === "failed" || !result.summary.trim()) {
      return false;
    }

    restate.state().set(HISTORY_SUMMARY, {
      through: pending.through,
      text: result.summary.trim(),
    } satisfies ConversationSummary);
    return true;
  },
};
