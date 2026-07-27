// Durable conversation history for one Agent virtual object. Turn lifecycle
// state and pending work belong to agent-turn.ts.
//
// The complete transcript remains the source of truth. Its sequence is stable;
// routing metadata can change when queued messages are promoted or requeued. A
// rolling summary is a replaceable model-context checkpoint over an older
// prefix of that log.

import {
  all,
  type Operation,
  sharedState,
  state,
} from "@restatedev/restate-sdk-gen";
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

function* readEntries(
  meta: HistoryMeta,
  fromChunk = 0,
  throughChunk = meta.lastChunk,
): Operation<StoredEntry[]> {
  const indexes = Array.from(
    {length: throughChunk - fromChunk + 1},
    (_, index) => fromChunk + index,
  );
  const chunks = yield* all(
    indexes.map((index) => sharedState().get<StoredEntry[]>(chunkKey(index))),
  );
  return chunks.flatMap((chunk) => chunk ?? []);
}

function* rewriteLatestDelivery(
  messageCount: number,
  from: "queued" | "steer",
  to: "queued" | "steer",
): Operation<void> {
  if (messageCount === 0) {
    return;
  }

  const meta = yield* ensureMeta();
  let remaining = messageCount;
  for (let index = meta.lastChunk; index >= 0 && remaining > 0; index--) {
    const chunk =
      (yield* sharedState().get<StoredEntry[]>(chunkKey(index))) ?? [];
    let changed = false;
    for (
      let entryIndex = chunk.length - 1;
      entryIndex >= 0 && remaining > 0;
      entryIndex--
    ) {
      const stored = chunk[entryIndex];
      if (stored.entry.role === "user" && stored.entry.delivery === from) {
        chunk[entryIndex] = {
          ...stored,
          entry: {...stored.entry, delivery: to},
        };
        remaining -= 1;
        changed = true;
      }
    }
    if (changed) {
      state().set(chunkKey(index), chunk);
    }
  }
}

/**
 * Handler-scoped access to conversation history for the current Agent object.
 *
 * These operations must run inside an Agent handler. The object is a namespace
 * over Restate's current context and holds no process-local state.
 */
export const history = {
  *page(fromSequence: number, limit: number): Operation<HistoryPage> {
    const meta = yield* readMeta();
    if (!meta || fromSequence >= meta.nextSequence) {
      return {entries: [], nextSequence: fromSequence};
    }

    const fromChunk = Math.floor((fromSequence - 1) / CHUNK_SIZE);
    const offset = (fromSequence - 1) % CHUNK_SIZE;
    const chunksNeeded = Math.ceil((offset + limit) / CHUNK_SIZE);
    const throughChunk = Math.min(meta.lastChunk, fromChunk + chunksNeeded - 1);
    const entries = (yield* readEntries(meta, fromChunk, throughChunk))
      .filter(({sequence}) => sequence >= fromSequence)
      .slice(0, limit)
      .map(({sequence, entry}) => ({sequence, entry}));
    const last = entries.at(-1);
    return {
      entries,
      nextSequence: last ? last.sequence + 1 : fromSequence,
    };
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
    const entries = (yield* readEntries(meta, Math.floor(through / CHUNK_SIZE)))
      .filter(({sequence}) => sequence > through)
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

  // Keep accepted messages at their original transcript positions while their
  // execution route changes.
  *promoteLatestQueued(messageCount: number): Operation<void> {
    yield* rewriteLatestDelivery(messageCount, "queued", "steer");
  },

  // Steering that lost a completion race becomes input for the next Turn, but
  // remains ordered where the Agent originally observed it.
  *requeueLatestSteering(messageCount: number): Operation<void> {
    yield* rewriteLatestDelivery(messageCount, "steer", "queued");
  },

  // Called after a turn outcome is appended. Once enough conversation messages
  // have accumulated, reserve the entire finished prefix.
  *beginCompaction(): Operation<ConversationCompactionPlan | undefined> {
    const meta = yield* ensureMeta();
    if (meta.compaction) {
      return undefined;
    }

    const summary =
      (yield* sharedState().get<ConversationSummary>(HISTORY_SUMMARY)) ??
      undefined;
    const baseThrough = summary?.through ?? START;
    const uncompacted = (yield* readEntries(
      meta,
      Math.floor(baseThrough / CHUNK_SIZE),
    )).filter(({sequence}) => sequence > baseThrough);
    const messageCount = uncompacted.filter(
      ({entry}) => entry.role !== "event",
    ).length;
    if (messageCount < COMPACT_AFTER_MESSAGES) {
      return undefined;
    }

    const last = uncompacted.at(-1);
    if (!last) {
      return undefined;
    }

    const through = last.sequence;
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
    const entries = (yield* readEntries(
      meta,
      Math.floor(plan.baseThrough / CHUNK_SIZE),
      Math.floor((plan.through - 1) / CHUNK_SIZE),
    ))
      .filter(
        ({sequence}) => sequence > plan.baseThrough && sequence <= plan.through,
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
