// Durable conversation history for one AgentSession virtual object. Active
// invocation state and pending input belong to Agent's active-turn module.
//
// The append-only transcript remains the source of truth. User messages record
// how they originally arrived; later routing decisions are separate lifecycle
// events. A rolling summary is a replaceable model-context checkpoint over an
// older prefix of that log.

import type {
  ConversationCompactionPlan,
  ConversationCompactionResult,
  ConversationEntry,
  HistoryPage,
} from "@restate-agents/types";
import {AgentNotificationsDefinition} from "@restate-agents/types/services";
import {TerminalError} from "@restatedev/restate-sdk";
import * as restate from "@restatedev/restate-sdk-gen";
import {
  type ConversationCompactionInput,
  isDerivedConversationEvent,
} from "../internal-types.js";

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
  /** Returns model context from the state loaded when this Turn began. */
  context(): ConversationContext;
  /** Appends entries using the invocation-local sequence and tail chunk. */
  append(...entries: ConversationEntry[]): restate.Operation<void>;
  /** Reserves the finished prefix when the local message count reaches the threshold. */
  beginCompaction(): restate.Operation<ConversationCompactionPlan | undefined>;
};

const HISTORY_META = "history/meta";
const HISTORY_SUMMARY = "history/summary";
const CHUNK_SIZE = 32;
const COMPACT_AFTER_MESSAGES = 32;

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

  const entries = yield* readEntries(meta, fromSequence).collect(limit);
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
  const uncompacted = yield* readEntries(
    meta,
    (summary?.through ?? 0) + 1,
  ).collect();
  let index = Math.floor((meta.nextSequence - 1) / CHUNK_SIZE);
  let chunk: StoredEntry[] = [];
  if ((meta.nextSequence - 1) % CHUNK_SIZE !== 0) {
    chunk =
      (yield* restate.sharedState().get<StoredEntry[]>(chunkKey(index))) ?? [];
  }
  const agentId = restate.handlerRequest().key;
  if (!agentId) {
    throw new TerminalError("history writers require an AgentSession key");
  }

  return {
    context(): ConversationContext {
      return {
        summary: summary?.text,
        entries: uncompacted.flatMap(({entry}): ConversationEntry[] =>
          isDerivedConversationEvent(entry) ? [] : [entry],
        ),
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
      yield* restate
        .sendClient(AgentNotificationsDefinition, agentId)
        .publish("history");
    },

    *beginCompaction(): restate.Operation<
      ConversationCompactionPlan | undefined
    > {
      if (
        meta.compaction ||
        uncompacted.filter(({entry}) => entry.role !== "event").length <
          COMPACT_AFTER_MESSAGES
      ) {
        return undefined;
      }

      meta.compaction = {
        baseThrough: summary?.through ?? 0,
        through: meta.nextSequence - 1,
      };
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
  ).collect()).map(({entry}) => entry);
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
