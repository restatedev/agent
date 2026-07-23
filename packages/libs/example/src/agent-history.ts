// Durable conversation history for one Agent virtual object. Turn lifecycle
// state and pending work belong to agent-turn.ts.
//
// The complete transcript remains the source of truth. A rolling summary is a
// replaceable model-context checkpoint over an immutable prefix of that log.

import {
  all,
  type Operation,
  sharedState,
  state,
} from "@restatedev/restate-sdk-gen";
import type {ConversationEntry} from "./types.js";

type StoredEntry = {
  sequence: number;
  entry: ConversationEntry;
};

type LocatedEntry = StoredEntry & {
  chunk: number;
};

type HistoryCursor = {
  sequence: number;
  chunk: number;
};

type ConversationSummary = {
  through: HistoryCursor;
  text: string;
};

export type ConversationCompactionPlan = {
  baseThrough: HistoryCursor;
  through: HistoryCursor;
};

type HistoryMeta = {
  lastChunk: number;
  nextSequence: number;
  compaction?: ConversationCompactionPlan;
};

export type ConversationContext = {
  summary?: string;
  entries: ConversationEntry[];
};

export type ConversationCompactionInput = ConversationCompactionPlan & {
  previousSummary?: string;
  entries: ConversationEntry[];
};

export type ConversationCompactionResult =
  | {
      status: "completed";
      baseThrough: HistoryCursor;
      through: HistoryCursor;
      summary: string;
    }
  | {
      status: "failed";
      baseThrough: HistoryCursor;
      through: HistoryCursor;
      error: string;
    };

const HISTORY_META = "history/meta";
const HISTORY_SUMMARY = "history/summary";
const HISTORY_CHUNK_PREFIX = "history/chunk/";

const CHUNK_SIZE = 32;
const COMPACT_AFTER_MESSAGES = 32;
const START = {sequence: 0, chunk: 0};

function chunkKey(index: number): string {
  return `${HISTORY_CHUNK_PREFIX}${index}`;
}

function sameCursor(left: HistoryCursor, right: HistoryCursor): boolean {
  return left.sequence === right.sequence && left.chunk === right.chunk;
}

function samePlan(
  left: ConversationCompactionPlan,
  right: ConversationCompactionPlan,
): boolean {
  return (
    sameCursor(left.baseThrough, right.baseThrough) &&
    sameCursor(left.through, right.through)
  );
}

function* readMeta(): Operation<HistoryMeta | undefined> {
  return (yield* sharedState().get<HistoryMeta>(HISTORY_META)) ?? undefined;
}

function* ensureMeta(): Operation<HistoryMeta> {
  const existing = yield* readMeta();
  if (existing) {
    return existing;
  }

  const meta = {
    lastChunk: 0,
    nextSequence: 1,
  };
  state().set(HISTORY_META, meta);
  return meta;
}

function* readLocated(
  meta: HistoryMeta,
  fromChunk = 0,
  throughChunk = meta.lastChunk,
): Operation<LocatedEntry[]> {
  const indexes = Array.from(
    {length: throughChunk - fromChunk + 1},
    (_, index) => fromChunk + index,
  );
  const chunks = yield* all(
    indexes.map((index) => sharedState().get<StoredEntry[]>(chunkKey(index))),
  );
  return chunks.flatMap((chunk, index) =>
    (chunk ?? []).map((stored) => ({
      ...stored,
      chunk: indexes[index],
    })),
  );
}

function isModelVisible(entry: ConversationEntry): boolean {
  return (
    entry.role === "user" ||
    (entry.role === "assistant" && entry.status === "completed")
  );
}

export const history = {
  *read(): Operation<ConversationEntry[]> {
    const meta = yield* readMeta();
    if (!meta) {
      return [];
    }
    return (yield* readLocated(meta)).map(({entry}) => entry);
  },

  *recent(limit: number): Operation<ConversationEntry[]> {
    if (limit <= 0) {
      return [];
    }

    const meta = yield* readMeta();
    if (!meta) {
      return [];
    }

    const recent: ConversationEntry[] = [];
    for (
      let index = meta.lastChunk;
      index >= 0 && recent.length < limit;
      index--
    ) {
      const chunk =
        (yield* sharedState().get<StoredEntry[]>(chunkKey(index))) ?? [];
      recent.unshift(
        ...chunk.slice(-(limit - recent.length)).map(({entry}) => entry),
      );
    }
    return recent;
  },

  *context(): Operation<ConversationContext> {
    const meta = yield* readMeta();
    if (!meta) {
      return {entries: []};
    }

    const summary =
      (yield* sharedState().get<ConversationSummary>(HISTORY_SUMMARY)) ??
      undefined;
    const through = summary?.through ?? START;
    const entries = (yield* readLocated(meta, through.chunk))
      .filter(({sequence}) => sequence > through.sequence)
      .map(({entry}) => entry);
    return {summary: summary?.text, entries};
  },

  *append(...entries: ConversationEntry[]): Operation<void> {
    if (entries.length === 0) {
      return;
    }

    const meta = yield* ensureMeta();
    let index = meta.lastChunk;
    let chunk =
      (yield* sharedState().get<StoredEntry[]>(chunkKey(index))) ?? [];

    for (const entry of entries) {
      if (chunk.length >= CHUNK_SIZE) {
        state().set(chunkKey(index), chunk);
        index += 1;
        chunk = [];
      }
      chunk.push({sequence: meta.nextSequence, entry});
      meta.nextSequence += 1;
    }

    state().set(chunkKey(index), chunk);
    meta.lastChunk = index;
    state().set(HISTORY_META, meta);
  },

  // Remove steering that lost a completion race so the Agent coordinator can
  // append it again after that outcome as normal queued input.
  *takeLatestSteering(count: number): Operation<string[]> {
    if (count === 0) {
      return [];
    }

    const meta = yield* ensureMeta();
    const messages: string[] = [];
    for (
      let index = meta.lastChunk;
      index >= 0 && messages.length < count;
      index--
    ) {
      const chunk =
        (yield* sharedState().get<StoredEntry[]>(chunkKey(index))) ?? [];
      let changed = false;
      for (
        let entryIndex = chunk.length - 1;
        entryIndex >= 0 && messages.length < count;
        entryIndex--
      ) {
        const entry = chunk[entryIndex].entry;
        if (entry.role === "user" && entry.delivery === "steer") {
          messages.push(entry.text);
          chunk.splice(entryIndex, 1);
          changed = true;
        }
      }
      if (changed) {
        state().set(chunkKey(index), chunk);
      }
    }
    return messages.reverse();
  },

  // Called after a turn outcome is appended. Once enough model-visible
  // messages have accumulated, reserve the entire finished prefix.
  *beginCompaction(): Operation<ConversationCompactionPlan | undefined> {
    const meta = yield* ensureMeta();
    if (meta.compaction) {
      return undefined;
    }

    const summary =
      (yield* sharedState().get<ConversationSummary>(HISTORY_SUMMARY)) ??
      undefined;
    const baseThrough = summary?.through ?? START;
    const uncompacted = (yield* readLocated(meta, baseThrough.chunk)).filter(
      ({sequence}) => sequence > baseThrough.sequence,
    );
    const messageCount = uncompacted.filter(({entry}) =>
      isModelVisible(entry),
    ).length;
    if (messageCount < COMPACT_AFTER_MESSAGES) {
      return undefined;
    }

    const last = uncompacted.at(-1);
    if (!last) {
      return undefined;
    }

    const through = {sequence: last.sequence, chunk: last.chunk};
    meta.compaction = {baseThrough, through};
    state().set(HISTORY_META, meta);
    return meta.compaction;
  },

  // Resolve a reserved cursor range into model input from a shared Agent
  // handler. No state is mutated here.
  *readCompaction(
    plan: ConversationCompactionPlan,
  ): Operation<ConversationCompactionInput | undefined> {
    const meta = yield* readMeta();
    if (!meta?.compaction || !samePlan(meta.compaction, plan)) {
      return undefined;
    }

    const summary =
      (yield* sharedState().get<ConversationSummary>(HISTORY_SUMMARY)) ??
      undefined;
    const entries = (yield* readLocated(
      meta,
      plan.baseThrough.chunk,
      plan.through.chunk,
    ))
      .filter(
        ({sequence, entry}) =>
          sequence > plan.baseThrough.sequence &&
          sequence <= plan.through.sequence &&
          isModelVisible(entry),
      )
      .map(({entry}) => entry);
    return {
      ...plan,
      previousSummary: summary?.text,
      entries,
    };
  },

  // Apply only the result for the currently reserved finished-turn prefix.
  // Newer transcript entries do not invalidate that checkpoint.
  *finishCompaction(result: ConversationCompactionResult): Operation<boolean> {
    const meta = yield* ensureMeta();
    const pending = meta.compaction;
    if (!pending || !samePlan(pending, result)) {
      return false;
    }

    delete meta.compaction;
    state().set(HISTORY_META, meta);
    if (result.status === "failed" || !result.summary.trim()) {
      return false;
    }

    state().set(HISTORY_SUMMARY, {
      through: pending.through,
      text: result.summary.trim(),
    } satisfies ConversationSummary);
    return true;
  },
};
