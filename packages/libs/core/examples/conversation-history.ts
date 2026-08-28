/**
 * Standalone example: lazy conversation history with cold-prefix offload.
 *
 * ## What is stored
 *
 * Metadata and message segments are stored as independent values. `append`
 * and `offloadPrefix` opt into lazy state because they touch only selected
 * segments; `applyOffload` and `history` use eager state:
 *
 * - `history/meta` holds `messageSequence`, `headSegment`, `tailSegment`, and
 *   an optional `PendingOffload`. `messageSequence` is `0` for an empty
 *   history and otherwise identifies the latest append.
 * - `history/segment/<n>` holds one `{messages: string[]}` value. Only the tail
 *   is mutable. Filling it advances `tailSegment`, making the full segment
 *   immutable and eligible for offload.
 * - `<archive prefix>/<zero-padded segment>.json` is one cold object containing
 *   that segment's message array. The object body needs no pointer, sequence,
 *   or segment metadata because its key supplies identity and ordering.
 *
 * The application owns the archive bucket and root prefix as process-level
 * configuration. A conversation's full prefix is derived from its Virtual
 * Object key, so no archive location is stored per conversation. The segment
 * capacity is also an internal storage detail and is not part of the read
 * contract.
 *
 * ## Offload protocol
 *
 * ```text
 * append (exclusive)
 *   ├─ append to the mutable tail
 *   ├─ advance messageSequence
 *   ├─ when full, advance the tail
 *   └─ reserve an immutable range and send offloadPrefix
 *                                      │
 *                                      ▼
 * offloadPrefix (shared)
 *   ├─ derive the conversation archive prefix from the object key
 *   ├─ read the reserved immutable segments
 *   ├─ restate.run(upload one object per segment)
 *   └─ send applyOffload
 *                 │
 *                 ▼
 * applyOffload (exclusive)
 *   ├─ advance the committed cold/hot boundary
 *   └─ clear the archived local segment keys
 * ```
 *
 * The upload runs in a shared handler, so exclusive appends can continue while
 * it is in flight. `PendingOffload` reserves a stable, sealed range and prevents
 * overlapping uploads. If several segments accumulate, one `restate.run`
 * uploads multiple objects—still one object per segment. Deterministic keys
 * make a partially completed batch safe to retry.
 *
 * The example's object-store boundary only logs the bucket, key, and complete
 * JSON body. Replacing that log with an S3 `PutObject` call does not change the
 * Restate protocol around it.
 *
 * ## Read contract
 *
 * `history()` does not download cold objects. It returns:
 *
 * - `archive: null` until the first offload commits, otherwise the derived
 *   `{bucket, prefix}` plus `messageCount`, the number of committed archived
 *   messages computed as `messageSequence - recent.length`; and
 * - `recent`, the flattened suffix read from `headSegment..tailSegment` in
 *   Restate state.
 *
 * To reconstruct the complete conversation, a reader lists and paginates the
 * returned prefix, concatenates objects in key order until it has read
 * `archive.messageCount` messages, and finally appends `recent`.
 *
 * A settled conversation with three archived and eight live segments looks
 * like this:
 *
 * ```text
 * archive  000000000000.json  000000000001.json  000000000002.json
 *             segment 0           segment 1           segment 2
 *
 * Restate              segment 3 ... segment 10
 * meta       { messageSequence: 321, head: 3, tail: 10, offload: null }
 * response   { archive: { messageCount: 96 }, recent: messages 97..321 }
 * ```
 *
 * ## Try it
 *
 * With a local Restate server already running, start this endpoint in one
 * terminal:
 *
 * ```shell
 * pnpm --filter @restate-agents/core example:conversation-history
 * ```
 *
 * In a second terminal, register it and populate a fresh Virtual Object key:
 *
 * ```shell
 * restate deployments register http://localhost:9080
 *
 * for i in {1..321}; do
 *   curl -s http://localhost:8080/ConversationHistoryExample/archive-listing-demo/append \
 *     -H 'content-type: application/json' \
 *     -d "\"Berlin itinerary note $i\""
 * done
 *
 * curl -s -X POST \
 *   http://localhost:8080/ConversationHistoryExample/archive-listing-demo/history
 * ```
 *
 * Abbreviated `history()` output:
 *
 * ```json
 * {
 *   "archive": {
 *     "bucket": "example-history-bucket",
 *     "prefix": "conversation-history/YXJjaGl2ZS1saXN0aW5nLWRlbW8/",
 *     "messageCount": 96
 *   },
 *   "recent": ["Berlin itinerary note 97", "...", "Berlin itinerary note 321"]
 * }
 * ```
 *
 * The endpoint process logs three uploads. Each array is abbreviated below but
 * contains 32 complete messages in the actual output:
 *
 * ```text
 * uploading history segment example-history-bucket .../000000000000.json ["... note 1", ..., "... note 32"]
 * uploading history segment example-history-bucket .../000000000001.json ["... note 33", ..., "... note 64"]
 * uploading history segment example-history-bucket .../000000000002.json ["... note 65", ..., "... note 96"]
 * ```
 */

import * as restate from "@restatedev/restate-sdk-gen";
import {serve} from "@restatedev/restate-sdk";

const MESSAGES_PER_SEGMENT = 32;
const LOCAL_SEGMENTS_TO_KEEP = 8;
const META_KEY = "history/meta";
// Application-owned archive configuration; no location is stored in VO state.
const ARCHIVE_BUCKET =
  process.env.HISTORY_S3_BUCKET ?? "example-history-bucket";
const ARCHIVE_ROOT = "conversation-history";

// ---------------------------------------------------------------------------
// Explicit wire and state types. The generator SDK's default JSON serde is
// sufficient for this example, so these do not need runtime schemas.
// ---------------------------------------------------------------------------

/** One independently loaded conversation segment in Restate lazy state. */
export type HistorySegment = {
  messages: string[];
};

/** Durable reservation for a range being copied to the cold archive. */
export type PendingOffload = {
  firstSegment: number;
  lastSegment: number;
};

/** Small routing record; archive location is derived rather than persisted. */
export type HistoryMeta = {
  /** Sequence assigned to the latest append, or zero before the first one. */
  messageSequence: number;
  headSegment: number;
  tailSegment: number;
  offload: PendingOffload | null;
};

/** Derived archive location, committed message count, and recent suffix. */
export type HistoryView = {
  archive: {
    bucket: string;
    prefix: string;
    messageCount: number;
  } | null;
  recent: string[];
};

/** Lazy, segmented conversation-history Virtual Object. */
export const ConversationHistory = restate.object({
  name: "ConversationHistoryExample",
  handlers: {
    /** Appends one message and starts an offload when the suffix is large. */
    *append(message: string): restate.Operation<void> {
      const meta = yield* readMeta();
      const tail = yield* readSegment(meta.tailSegment);
      tail.messages.push(message);
      meta.messageSequence += 1;

      // Every append changes the tail and its conversation-wide sequence.
      // Segment routing changes only on rollover.
      writeSegment(meta.tailSegment, tail);
      if (tail.messages.length < MESSAGES_PER_SEGMENT) {
        restate.state().set(META_KEY, meta);
        return;
      }

      meta.tailSegment += 1;
      if (!needsOffload(meta)) {
        restate.state().set(META_KEY, meta);
        return;
      }
      const id = conversationKey();
      const offload = planOffload(meta);
      // Persist the reservation before the shared offload handler can observe
      // it.
      meta.offload = offload;
      restate.state().set(META_KEY, meta);
      restate
        .sendClient(ConversationHistory, id)
        .offloadPrefix(offload);
    },

    /**
     * Reads a sealed range and uploads one deterministic object per segment.
     *
     * This shared handler derives the same archive prefix as `history()` and
     * cannot mutate VO state. After the external upload, it durably sends the
     * reserved range to the exclusive commit handler.
     */
    *offloadPrefix(offload: PendingOffload): restate.Operation<void> {
      const id = conversationKey();
      const meta = yield* readMeta();
      // A stale or superseded invocation must not upload another prefix.
      if (!sameOffload(meta.offload, offload)) {
        return;
      }

      const segments: string[][] = [];
      // The reserved range excludes the mutable tail, so these values are
      // stable.
      for (
        let index = offload.firstSegment;
        index <= offload.lastSegment;
        index += 1
      ) {
        const segment = yield* readSegment(index);
        segments.push(segment.messages);
      }

      yield* restate.run(
        ({signal}) =>
          putArchivedSegments(
            archivePrefix(id),
            offload.firstSegment,
            segments,
            signal,
          ),
        {name: "put-history-segments"},
      );

      yield* restate
        .sendClient(ConversationHistory, id)
        .applyOffload(offload);
    },

    /** Commits an uploaded range and reclaims its local segment keys. */
    *applyOffload(offload: PendingOffload): restate.Operation<void> {
      const meta = yield* readMeta();
      // Only the completion for the current durable reservation may reclaim
      // data.
      if (!sameOffload(meta.offload, offload)) {
        return;
      }

      // This exclusive handler commits the new cold/hot boundary and local
      // state reclamation together.
      for (
        let index = offload.firstSegment;
        index <= offload.lastSegment;
        index += 1
      ) {
        restate.state().clear(segmentKey(index));
      }
      meta.headSegment = offload.lastSegment + 1;
      meta.offload = null;
      restate.state().set(META_KEY, meta);
    },

    /** Returns committed archive metadata and the recent Restate-held suffix. */
    *history(): restate.Operation<HistoryView> {
      const id = conversationKey();
      const meta = yield* readMeta();
      const recent: string[] = [];
      for (
        let index = meta.headSegment;
        index <= meta.tailSegment;
        index += 1
      ) {
        recent.push(...(yield* readSegment(index)).messages);
      }

      // Uploaded objects can become visible before applyOffload runs. The
      // exclusive commit advances headSegment only after every object in the
      // range is durable. Subtracting the still-local recent suffix from the
      // latest sequence therefore yields the committed archive size.
      const archivedMessageCount = meta.messageSequence - recent.length;
      const archive =
        archivedMessageCount > 0
          ? {
              bucket: ARCHIVE_BUCKET,
              prefix: archivePrefix(id),
              messageCount: archivedMessageCount,
            }
          : null;
      return {archive, recent};
    },
  },
  options: {
    handlers: {
      append: {enableLazyState: true},
      offloadPrefix: {shared: true, enableLazyState: true},
      history: {shared: true},
    },
  },
});

// This example is its own deployable endpoint rather than part of the agent
// runtime endpoint, so it can be launched and explored independently.
serve({services: [ConversationHistory]});

// ---------------------------------------------------------------------------
// Lazy state mechanics
// ---------------------------------------------------------------------------

function* readMeta(): restate.Operation<HistoryMeta> {
  // Lazy state has no physical metadata value before the first append.
  return (
    (yield* restate.sharedState().get<HistoryMeta>(META_KEY)) ?? {
      messageSequence: 0,
      headSegment: 0,
      tailSegment: 0,
      offload: null,
    }
  );
}

function* readSegment(index: number): restate.Operation<HistorySegment> {
  // A newly advanced tail is represented by an absent key until its first append.
  return (
    (yield* restate
      .sharedState()
      .get<HistorySegment>(segmentKey(index))) ?? {messages: []}
  );
}

function writeSegment(index: number, segment: HistorySegment): void {
  restate.state().set(segmentKey(index), segment);
}

function segmentKey(index: number): string {
  return `history/segment/${index}`;
}

/** Whether another immutable range must be moved out of local state. */
function needsOffload(meta: HistoryMeta): boolean {
  const localSegments = meta.tailSegment - meta.headSegment + 1;
  return !meta.offload && localSegments > LOCAL_SEGMENTS_TO_KEEP;
}

/** Plans an offload of all excess sealed segments, but never the mutable tail. */
function planOffload(meta: HistoryMeta): PendingOffload {
  const lastSegment = meta.tailSegment - LOCAL_SEGMENTS_TO_KEEP;
  return {
    firstSegment: meta.headSegment,
    lastSegment,
  };
}

function sameOffload(
  current: PendingOffload | null,
  candidate: PendingOffload,
): boolean {
  return (
    current?.firstSegment === candidate.firstSegment &&
    current.lastSegment === candidate.lastSegment
  );
}

// ---------------------------------------------------------------------------
// Mock object-store boundary
// ---------------------------------------------------------------------------
async function putArchivedSegments(
  prefix: string,
  firstSegment: number,
  segments: string[][],
  signal: AbortSignal,
): Promise<void> {
  for (const [offset, messages] of segments.entries()) {
    signal.throwIfAborted();
    const segment = firstSegment + offset;
    const key = `${prefix}${segment.toString().padStart(12, "0")}.json`;
    const blob = JSON.stringify(messages);
    // await putObject(
    //   {
    //     bucket: ARCHIVE_BUCKET,
    //     key,
    //     body: blob,
    //     contentType: "application/json",
    //   },
    //   signal,
    // );
    console.log("uploading history segment", ARCHIVE_BUCKET, key, blob);
  }
}

/** Reconstructs the stable archive prefix from application config and VO key. */
function archivePrefix(conversationId: string): string {
  const id = Buffer.from(conversationId).toString("base64url");
  return `${ARCHIVE_ROOT}/${id}/`;
}

function conversationKey(): string {
  const key = restate.handlerRequest().key;
  return key!;
}
