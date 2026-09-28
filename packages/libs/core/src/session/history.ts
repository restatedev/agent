// Durable conversation history for one AgentSession virtual object. Active
// invocation state and pending input belong to Agent's active-turn module.
//
// The append-only transcript remains the source of truth. User messages record
// how they originally arrived; later routing decisions are separate lifecycle
// events. A rolling summary is a replaceable model-context checkpoint over an
// older prefix of that log. The most recent exchanges are never summarized, so
// the model always sees them verbatim.

import type {
  ConversationCompactionPlan,
  ConversationCompactionResult,
  ConversationEntry,
  HistoryPage,
} from "@restate-agents/types";
import {AgentDefinition} from "@restate-agents/types/services";
import * as restate from "@restatedev/restate-sdk-gen";

import type {ConversationCompactionInput} from "../internal-types.js";
import {objectKey} from "../state.js";

type StoredEntry = {
  sequence: number;
  entry: ConversationEntry;
};

type ConversationSummary = {
  through: number;
  text: string;
};

type HistoryMeta = {
  nextSequence: number;
  compaction?: ConversationCompactionPlan;
};

type ConversationContext = {
  summary?: string;
  entries: ConversationEntry[];
};

/** Invocation-local access to an AgentSession's append-only transcript. */
export type TurnHistory = {
  /**
   * Returns the summary and uncompacted entries loaded when this Turn began.
   * Derived status events are included; `buildModelContext` drops them.
   */
  context(): ConversationContext;
  /** Appends entries using the invocation-local sequence and tail chunk. */
  append(...entries: ConversationEntry[]): restate.Operation<void>;
  /**
   * Reserves the finished prefix, minus the recent exchanges, when the local
   * message count reaches the threshold.
   */
  beginCompaction(): restate.Operation<ConversationCompactionPlan | undefined>;
};

const HISTORY_META = "history/meta";
const HISTORY_SUMMARY = "history/summary";
const CHUNK_SIZE = 32;
const COMPACT_AFTER_MESSAGES = 32;
// At least this many of the newest messages stay out of the summary.
const KEEP_RECENT_MESSAGES = 8;

/**
 * Handler-scoped access to conversation history for the current AgentSession.
 *
 * These functions must run inside an AgentSession handler. They use Restate's
 * current context and hold no process-local state.
 */
export function* page(
  fromSequence: number,
  limit: number,
): restate.Operation<HistoryPage> {
  const meta = yield* readMeta();
  if (fromSequence >= meta.nextSequence) {
    return {entries: [], nextSequence: fromSequence};
  }

  const entries = yield* readEntries(meta, fromSequence, undefined, limit);
  const last = entries.at(-1);
  return {
    entries,
    nextSequence: last ? last.sequence + 1 : fromSequence,
  };
}

/**
 * Loads the transcript state needed by one Turn exactly once.
 *
 * The returned writer owns an invocation-local cursor, tail chunk, and
 * uncompacted prefix. Appending and checking compaction therefore only emit
 * state writes for the remainder of the Turn.
 */
export function* openTurn(): restate.Operation<TurnHistory> {
  const meta = yield* readMeta();
  const summary = yield* readSummary();
  const uncompacted = yield* readEntries(meta, (summary?.through ?? 0) + 1);
  // The tail chunk receives this turn's appends. A full chunk is closed, so
  // appending starts a new one.
  let index = Math.floor((meta.nextSequence - 1) / CHUNK_SIZE);
  let chunk: StoredEntry[] = [];
  if ((meta.nextSequence - 1) % CHUNK_SIZE !== 0) {
    const first = index * CHUNK_SIZE + 1;
    if ((summary?.through ?? 0) < first) {
      // The walk above already loaded every entry of the tail chunk.
      chunk = uncompacted.filter(({sequence}) => sequence >= first);
    } else {
      chunk = yield* readEntries(meta, first);
    }
  }
  const agentId = objectKey();

  return {
    context(): ConversationContext {
      return {
        summary: summary?.text,
        entries: uncompacted.map(({entry}) => entry),
      };
    },

    *append(...entries: ConversationEntry[]): restate.Operation<void> {
      if (entries.length === 0) {
        return;
      }

      for (const entry of entries) {
        if (chunk.length >= CHUNK_SIZE) {
          restate.state().set(chunkKey(index), chunk);
          index += 1;
          chunk = [];
        }
        const stored = {sequence: meta.nextSequence, entry};
        chunk.push(stored);
        uncompacted.push(stored);
        meta.nextSequence += 1;
      }

      restate.state().set(chunkKey(index), chunk);
      restate.state().set(HISTORY_META, meta);
      // One notification per append keeps followers live during long tool
      // batches. Callers batch entries that land together into one append.
      yield* restate.sendClient(AgentDefinition, agentId).publish("history");
    },

    *beginCompaction(): restate.Operation<
      ConversationCompactionPlan | undefined
    > {
      if (messagesAfter(uncompacted, 0) < COMPACT_AFTER_MESSAGES) {
        return undefined;
      }
      // A reservation normally finishes during the next turn. One that has
      // fallen a whole threshold behind lost its applyCompaction (the
      // one-way compact call was cancelled or failed), so replace it rather
      // than blocking compaction forever; a late result for it no longer
      // matches the plan and is ignored. The messages after a reservation
      // include the verbatim tail it left out, so that tail is not counted
      // as falling behind.
      const reserved = meta.compaction;
      const staleAfter = COMPACT_AFTER_MESSAGES + KEEP_RECENT_MESSAGES;
      if (
        reserved &&
        messagesAfter(uncompacted, reserved.through) < staleAfter
      ) {
        return undefined;
      }

      const baseThrough = summary?.through ?? 0;
      const through = recentTailBoundary(uncompacted);
      if (through === undefined || through <= baseThrough) {
        return undefined;
      }

      meta.compaction = {baseThrough, through};
      restate.state().set(HISTORY_META, meta);
      return meta.compaction;
    },
  };
}

/** Resolves a reserved transcript prefix into compactor input without mutation. */
export function* readCompaction(
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
  )).map(({entry}) => entry);
  return {
    ...plan,
    previousSummary: summary?.text,
    entries,
  };
}

/** Applies a summary only to the finished-turn prefix that reserved it. */
export function* finishCompaction(
  result: ConversationCompactionResult,
): restate.Operation<boolean> {
  const meta = yield* readMeta();
  const pending = meta.compaction;
  if (!pending || !samePlan(pending, result)) {
    return false;
  }

  delete meta.compaction;
  restate.state().set(HISTORY_META, meta);
  if (result.status === "failed") {
    return false;
  }

  // ConversationCompactionResultSchema already trims the summary and
  // rejects an empty one at the applyCompaction handler boundary.
  restate.state().set(HISTORY_SUMMARY, {
    through: pending.through,
    text: result.summary,
  } satisfies ConversationSummary);
  return true;
}

/** Counts conversation messages (not events) after `sequence`. */
function messagesAfter(entries: StoredEntry[], sequence: number): number {
  return entries.filter(
    (stored) => stored.sequence > sequence && stored.entry.role !== "event",
  ).length;
}

/**
 * The last sequence before the verbatim tail. The tail holds at least
 * KEEP_RECENT_MESSAGES messages and starts at a user message, so the model
 * never sees a reply whose request was summarized away. Returns undefined when
 * no user message starts such a tail.
 */
function recentTailBoundary(entries: StoredEntry[]): number | undefined {
  let kept = 0;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const {sequence, entry} = entries[i];
    if (entry.role === "event") {
      continue;
    }
    kept += 1;
    if (kept >= KEEP_RECENT_MESSAGES && entry.role === "user") {
      return sequence - 1;
    }
  }
  return undefined;
}

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

// Reads up to `limit` entries of a stable sequence range, one chunk at a time,
// so a short page never reads the chunks after it.
function* readEntries(
  meta: HistoryMeta,
  fromSequence = 1,
  throughSequence = meta.nextSequence - 1,
  limit = Number.POSITIVE_INFINITY,
): restate.Operation<StoredEntry[]> {
  const through = Math.min(throughSequence, meta.nextSequence - 1);
  const result: StoredEntry[] = [];
  let chunkIndex = -1;
  let chunk: StoredEntry[] = [];
  for (
    let sequence = Math.max(1, fromSequence);
    sequence <= through && result.length < limit;
    sequence += 1
  ) {
    const index = Math.floor((sequence - 1) / CHUNK_SIZE);
    if (index !== chunkIndex) {
      chunk =
        (yield* restate.sharedState().get<StoredEntry[]>(chunkKey(index))) ??
        [];
      chunkIndex = index;
    }
    result.push(chunk[(sequence - 1) % CHUNK_SIZE]);
  }
  return result;
}
