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
  lastChunk: number;
  nextSequence: number;
  compaction?: ConversationCompactionPlan;
};

type EntryRange = {
  fromSequence?: number;
  throughSequence?: number;
};

type EntryReader = {
  next(): restate.Operation<StoredEntry | undefined>;
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
const HISTORY_CHUNK_PREFIX = "history/chunk/";

const CHUNK_SIZE = 32;
const COMPACT_AFTER_MESSAGES = 32;
const START = 0;

function chunkKey(index: number): string {
  return `${HISTORY_CHUNK_PREFIX}${index}`;
}

function samePlan(
  left: ConversationCompactionPlan,
  right: ConversationCompactionPlan,
): boolean {
  return (
    left.baseThrough === right.baseThrough && left.through === right.through
  );
}

function* readMeta(): restate.Operation<HistoryMeta | undefined> {
  return (
    (yield* restate.sharedState().get<HistoryMeta>(HISTORY_META)) ?? undefined
  );
}

function* ensureMeta(): restate.Operation<HistoryMeta> {
  const existing = yield* readMeta();
  if (existing) {
    return existing;
  }

  const meta = {
    lastChunk: 0,
    nextSequence: 1,
  };
  restate.state().set(HISTORY_META, meta);
  return meta;
}

// Lazily walks a stable sequence range. Only the current chunk is loaded, so a
// caller that stops reading also avoids every later state read.
function createEntryReader(
  meta: HistoryMeta,
  {fromSequence = 1, throughSequence = meta.nextSequence - 1}: EntryRange = {},
): EntryReader {
  const from = Math.max(1, fromSequence);
  const through = Math.min(throughSequence, meta.nextSequence - 1);
  let nextChunk = Math.floor((from - 1) / CHUNK_SIZE);
  const lastChunk =
    from <= through ? Math.floor((through - 1) / CHUNK_SIZE) : -1;
  let chunk: StoredEntry[] = [];
  let offset = 0;

  return {
    *next(): restate.Operation<StoredEntry | undefined> {
      while (true) {
        while (offset < chunk.length) {
          const stored = chunk[offset++];
          if (stored.sequence >= from && stored.sequence <= through) {
            return stored;
          }
        }

        if (nextChunk > lastChunk) {
          return undefined;
        }

        chunk =
          (yield* restate
            .sharedState()
            .get<StoredEntry[]>(chunkKey(nextChunk))) ?? [];
        nextChunk += 1;
        offset = 0;
      }
    },
  };
}

function* collectEntries(
  reader: EntryReader,
  limit = Number.POSITIVE_INFINITY,
): restate.Operation<StoredEntry[]> {
  const entries: StoredEntry[] = [];
  while (entries.length < limit) {
    const entry = yield* reader.next();
    if (!entry) {
      break;
    }
    entries.push(entry);
  }
  return entries;
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
    if (!meta || fromSequence >= meta.nextSequence) {
      return {entries: [], nextSequence: fromSequence};
    }

    const entries = (yield* collectEntries(
      createEntryReader(meta, {fromSequence}),
      limit,
    )).map(({sequence, entry}) => ({sequence, entry}));
    const last = entries.at(-1);
    return {
      entries,
      nextSequence: last ? last.sequence + 1 : fromSequence,
    };
  },

  *context(): restate.Operation<ConversationContext> {
    const meta = yield* readMeta();
    if (!meta) {
      return {entries: []};
    }

    const summary =
      (yield* restate
        .sharedState()
        .get<ConversationSummary>(HISTORY_SUMMARY)) ?? undefined;
    const through = summary?.through ?? START;
    const entries = (yield* collectEntries(
      createEntryReader(meta, {fromSequence: through + 1}),
    )).map(({entry}) => entry);
    return {summary: summary?.text, entries};
  },

  *append(...entries: ConversationEntry[]): restate.Operation<void> {
    if (entries.length === 0) {
      return;
    }

    const meta = yield* ensureMeta();
    let index = meta.lastChunk;
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
    meta.lastChunk = index;
    restate.state().set(HISTORY_META, meta);
  },

  // Called after a turn outcome is appended. Once enough conversation messages
  // have accumulated, reserve the entire finished prefix.
  *beginCompaction(): restate.Operation<
    ConversationCompactionPlan | undefined
  > {
    const meta = yield* ensureMeta();
    if (meta.compaction) {
      return undefined;
    }

    const summary =
      (yield* restate
        .sharedState()
        .get<ConversationSummary>(HISTORY_SUMMARY)) ?? undefined;
    const baseThrough = summary?.through ?? START;
    const entries = createEntryReader(meta, {
      fromSequence: baseThrough + 1,
    });
    let messageCount = 0;
    while (messageCount < COMPACT_AFTER_MESSAGES) {
      const stored = yield* entries.next();
      if (!stored) {
        return undefined;
      }
      if (stored.entry.role !== "event") {
        messageCount += 1;
      }
    }

    const through = meta.nextSequence - 1;
    meta.compaction = {baseThrough, through};
    restate.state().set(HISTORY_META, meta);
    return meta.compaction;
  },

  // Resolve a reserved cursor range into model input from a shared Agent
  // handler. No state is mutated here.
  *readCompaction(
    plan: ConversationCompactionPlan,
  ): restate.Operation<ConversationCompactionInput | undefined> {
    const meta = yield* readMeta();
    if (!meta?.compaction || !samePlan(meta.compaction, plan)) {
      return undefined;
    }

    const summary =
      (yield* restate
        .sharedState()
        .get<ConversationSummary>(HISTORY_SUMMARY)) ?? undefined;
    const entries = (yield* collectEntries(
      createEntryReader(meta, {
        fromSequence: plan.baseThrough + 1,
        throughSequence: plan.through,
      }),
    )).map(({entry}) => entry);
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
    const meta = yield* ensureMeta();
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
