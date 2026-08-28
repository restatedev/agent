/**
 * Standalone example: lazy conversation history with cold-prefix offload.
 *
 * This Virtual Object is intentionally not registered by the application. It
 * demonstrates a storage protocol close to AgentSession without depending on
 * the rest of the agent runtime:
 *
 * - `append` adds messages to one mutable tail-segment key;
 * - every segment before the tail is immutable;
 * - shared `offloadPrefix` copies a reserved immutable prefix to an S3-shaped
 *   boundary inside `restate.run`; and
 * - exclusive `applyOffload` installs the returned pointer before clearing the
 *   corresponding local keys.
 *
 * With three hot segments retained, the state transition is:
 *
 * ```text
 * before: meta { head: s0, tail: s6, snapshot: null }
 *         state  s0 s1 s2 s3 s4 s5 s6
 *
 * after:  meta { head: s4, tail: s6, snapshot: s0..s3 }
 *         state              s4 s5 s6
 *         S3     [s0 s1 s2 s3] <- snapshot pointer
 * ```
 */

import {createHash} from "node:crypto";
import {TerminalError} from "@restatedev/restate-sdk";
import * as restate from "@restatedev/restate-sdk-gen";

// Deliberately tiny so the rollover is easy to observe in the Restate UI.
const MESSAGES_PER_SEGMENT = 4;
const LOCAL_SEGMENTS_TO_KEEP = 3;
const META_KEY = "history/meta";

// ---------------------------------------------------------------------------
// Explicit wire and state types. The generator SDK's default JSON serde is
// sufficient for this example, so these do not need runtime schemas.
// ---------------------------------------------------------------------------

export type ConversationMessage = {
  role: "user" | "assistant";
  content: string;
};

export type StoredMessage = {
  sequence: number;
  message: ConversationMessage;
};

/** Required pointer from the hot suffix to one immutable cold block. */
export type SnapshotPointer = {
  bucket: string;
  key: string;
  etag: string;
  fromSequence: number;
  throughSequence: number;
};

/** One Restate state value. Only the segment at meta.tailSegment is mutable. */
export type HistorySegment = {
  index: number;
  messages: StoredMessage[];
};

/** Stable prefix selected by an exclusive handler for one shared offload. */
export type OffloadPlan = {
  fromSegment: number;
  throughSegment: number;
  fromSequence: number;
  throughSequence: number;
  previousSnapshot: SnapshotPointer | null;
  target: {bucket: string; key: string};
};

/** Small, always-read routing record stored separately from message data. */
export type HistoryMeta = {
  nextSequence: number;
  headSegment: number;
  tailSegment: number;
  snapshot: SnapshotPointer | null;
  offload: OffloadPlan | null;
};

/** Hot history response. `snapshot` locates every message before `local`. */
export type HistoryView = {
  snapshot: SnapshotPointer | null;
  local: StoredMessage[];
};

export type OffloadResult = {
  plan: OffloadPlan;
  snapshot: SnapshotPointer;
};

/** Lazy, segmented conversation-history Virtual Object. */
export const ConversationHistory = restate.object({
  name: "ConversationHistoryExample",
  handlers: {
    /** Appends one message and starts an offload when the suffix is large. */
    *append(message: ConversationMessage): restate.Operation<HistoryMeta> {
      const id = conversationKey();
      const meta = yield* readMeta();
      let tail = yield* readSegment(meta.tailSegment);

      if (tail.messages.length === MESSAGES_PER_SEGMENT) {
        writeSegment(tail);
        tail = emptySegment(++meta.tailSegment);
      }
      tail.messages.push({sequence: meta.nextSequence++, message});

      writeSegment(tail);
      const plan = reservePrefix(meta, id);
      restate.state().set(META_KEY, meta);
      if (plan) {
        yield* sendOffload(id, plan);
      }
      return meta;
    },

    /** Returns the S3 pointer and the complete suffix still held by Restate. */
    *history(): restate.Operation<HistoryView> {
      const meta = yield* readMeta();
      const local: StoredMessage[] = [];
      for (
        let index = meta.headSegment;
        index <= meta.tailSegment;
        index += 1
      ) {
        local.push(...(yield* readSegment(index)).messages);
      }
      return {snapshot: meta.snapshot, local};
    },

    /**
     * Reads a sealed prefix and performs the slow external upload.
     *
     * This is a shared handler, so it cannot mutate VO state. Its only
     * output is a durable one-way call to the exclusive commit handler.
     */
    *offloadPrefix(plan: OffloadPlan): restate.Operation<void> {
      const id = conversationKey();
      const meta = yield* readMeta();
      if (!samePlan(meta.offload, plan)) {
        return;
      }

      const messages: StoredMessage[] = [];
      for (
        let index = plan.fromSegment;
        index <= plan.throughSegment;
        index += 1
      ) {
        const segment = yield* readSegment(index);
        if (segment.messages.length !== MESSAGES_PER_SEGMENT) {
          throw new TerminalError(`segment ${index} is not sealed`);
        }
        messages.push(...segment.messages);
      }
      if (
        messages[0]?.sequence !== plan.fromSequence ||
        messages.at(-1)?.sequence !== plan.throughSequence
      ) {
        throw new TerminalError("offload plan does not match local history");
      }

      const blob = JSON.stringify({previous: plan.previousSnapshot, messages});
      const snapshot = yield* restate.run(
        ({signal}) => putSnapshot(plan, blob, signal),
        {name: "put-history-snapshot"},
      );

      yield* restate
        .sendClient(ConversationHistory, id)
        .applyOffload({plan, snapshot});
    },

    /** Installs a valid pointer, then reclaims its local segment keys. */
    *applyOffload({plan, snapshot}: OffloadResult): restate.Operation<boolean> {
      const id = conversationKey();
      const meta = yield* readMeta();
      if (!samePlan(meta.offload, plan)) {
        return false;
      }
      if (
        snapshot.bucket !== plan.target.bucket ||
        snapshot.key !== plan.target.key ||
        snapshot.fromSequence !== plan.fromSequence ||
        snapshot.throughSequence !== plan.throughSequence
      ) {
        throw new TerminalError("snapshot does not match its offload plan");
      }

      for (
        let index = plan.fromSegment;
        index <= plan.throughSegment;
        index += 1
      ) {
        restate.state().clear(segmentKey(index));
      }
      meta.headSegment = plan.throughSegment + 1;
      meta.snapshot = snapshot;
      meta.offload = null;

      // Appends may have advanced the tail while the shared upload ran.
      const next = reservePrefix(meta, id);
      restate.state().set(META_KEY, meta);
      if (next) {
        yield* sendOffload(id, next);
      }
      return true;
    },
  },
  options: {
    enableLazyState: true,
    handlers: {
      history: {shared: true},
      offloadPrefix: {shared: true},
    },
  },
});

// ---------------------------------------------------------------------------
// Lazy state mechanics
// ---------------------------------------------------------------------------

function* readMeta(): restate.Operation<HistoryMeta> {
  return (
    (yield* restate.sharedState().get<HistoryMeta>(META_KEY)) ?? {
      nextSequence: 1,
      headSegment: 0,
      tailSegment: 0,
      snapshot: null,
      offload: null,
    }
  );
}

function* readSegment(index: number): restate.Operation<HistorySegment> {
  return (
    (yield* restate
      .sharedState()
      .get<HistorySegment>(segmentKey(index))) ?? emptySegment(index)
  );
}

function writeSegment(segment: HistorySegment): void {
  restate.state().set(segmentKey(segment.index), segment);
}

function emptySegment(index: number): HistorySegment {
  return {index, messages: []};
}

function segmentKey(index: number): string {
  return `history/segment/${index}`;
}

function segmentFirstSequence(index: number): number {
  return index * MESSAGES_PER_SEGMENT + 1;
}

/** Reserves all excess sealed segments, but never the mutable tail. */
function reservePrefix(
  meta: HistoryMeta,
  conversationId: string,
): OffloadPlan | undefined {
  const localSegments = meta.tailSegment - meta.headSegment + 1;
  if (meta.offload || localSegments <= LOCAL_SEGMENTS_TO_KEEP) {
    return undefined;
  }

  const throughSegment = meta.tailSegment - LOCAL_SEGMENTS_TO_KEEP;
  const fromSequence = segmentFirstSequence(meta.headSegment);
  const throughSequence = segmentFirstSequence(throughSegment + 1) - 1;
  const bucket = process.env.HISTORY_S3_BUCKET ?? "example-history-bucket";
  const plan: OffloadPlan = {
    fromSegment: meta.headSegment,
    throughSegment,
    fromSequence,
    throughSequence,
    previousSnapshot: meta.snapshot,
    target: {
      bucket,
      key: snapshotKey(conversationId, fromSequence, throughSequence),
    },
  };
  meta.offload = plan;
  return plan;
}

function* sendOffload(
  conversationId: string,
  plan: OffloadPlan,
): restate.Operation<void> {
  yield* restate
    .sendClient(ConversationHistory, conversationId)
    .offloadPrefix(plan);
}

function samePlan(
  current: OffloadPlan | null,
  candidate: OffloadPlan,
): boolean {
  return (
    current?.fromSegment === candidate.fromSegment &&
    current.throughSegment === candidate.throughSegment &&
    current.target.bucket === candidate.target.bucket &&
    current.target.key === candidate.target.key
  );
}

// ---------------------------------------------------------------------------
// Superficially realistic S3 boundary
// ---------------------------------------------------------------------------

type PutObjectRequest = {
  bucket: string;
  key: string;
  body: string;
  contentType: "application/json";
};

async function putSnapshot(
  plan: OffloadPlan,
  blob: string,
  signal: AbortSignal,
): Promise<SnapshotPointer> {
  const {etag} = await putObject(
    {
      bucket: plan.target.bucket,
      key: plan.target.key,
      body: blob,
      contentType: "application/json",
    },
    signal,
  );
  return {
    ...plan.target,
    etag,
    fromSequence: plan.fromSequence,
    throughSequence: plan.throughSequence,
  };
}

/**
 * Replace this body with S3 `PutObject` in a real application.
 *
 * The surrounding durable run, deterministic key, pointer, and commit
 * protocol remain the same. This stub only produces an S3-like ETag.
 */
async function putObject(
  request: PutObjectRequest,
  signal: AbortSignal,
): Promise<{etag: string}> {
  signal.throwIfAborted();
  await Promise.resolve();
  signal.throwIfAborted();
  return {
    etag: `"${createHash("md5").update(request.body).digest("hex")}"`,
  };
}

function snapshotKey(
  conversationId: string,
  fromSequence: number,
  throughSequence: number,
): string {
  const id = Buffer.from(conversationId).toString("base64url");
  return `conversation-history/${id}/${fromSequence}-${throughSequence}.json`;
}

function conversationKey(): string {
  const key = restate.handlerRequest().key;
  if (!key) {
    throw new TerminalError("conversation history requires an object key");
  }
  return key;
}
