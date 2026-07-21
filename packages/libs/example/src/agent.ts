// Agent is the general conversation: a VirtualObject keyed by conversation id
// that owns the user-facing thread (user messages + one assistant summary per
// turn) and the active turn's invocation id. It never runs the turn itself — it
// starts one (see ./turn) with a one-way send and returns.
//
// Detailed step output does not live here; it goes to the per-turn conversation
// (see ./turn-conversation). This object stays a clean, readable transcript.

import {TerminalError} from "@restatedev/restate-sdk";
import {
  handlerRequest,
  type Operation,
  object,
  schemas,
  sharedState,
  state,
} from "@restatedev/restate-sdk-gen";
import {z} from "zod";
import {interruptTurn, startTurn, steerTurn} from "./turn";
import {
  type ConversationEntry,
  ConversationEntrySchema,
  type ConversationState,
  type TurnOutcome,
  TurnOutcomeSchema,
} from "./types";

// The conversation id is this object's key. Object handlers always have one, but
// read it through here so a missing key is a clear error, not a stray `!`.
function conversationKey(): string {
  const key = handlerRequest().key;
  if (!key) {
    throw new TerminalError("Agent handlers require a conversation key");
  }
  return key;
}

// --- State access -----------------------------------------------------------
// Encapsulate every read/write behind a named Operation, so the handlers read
// as intent ("read the active turn", "append an entry") rather than key strings.
// Reads use `sharedState()` (read-only, usable from any handler); writes use
// `state()` (only valid in an exclusive handler).

function* readTurnId(): Operation<string | undefined> {
  return (yield* sharedState<ConversationState>().get("turnId")) ?? undefined;
}
function* saveTurnId(turnId: string): Operation<void> {
  state<ConversationState>().set("turnId", turnId);
}
function* clearTurnId(): Operation<void> {
  state<ConversationState>().clear("turnId");
}

function* readHistory(): Operation<ConversationEntry[]> {
  return (yield* sharedState<ConversationState>().get("history")) ?? [];
}
function* appendEntry(entry: ConversationEntry): Operation<void> {
  const history = yield* readHistory();
  history.push(entry);
  state<ConversationState>().set("history", history);
}

function* readPending(): Operation<string[]> {
  return (yield* sharedState<ConversationState>().get("pending")) ?? [];
}
function* enqueuePending(message: string): Operation<void> {
  const pending = yield* readPending();
  pending.push(message);
  state<ConversationState>().set("pending", pending);
}
function* dequeuePending(): Operation<string | undefined> {
  const pending = yield* readPending();
  const next = pending.shift();
  if (next !== undefined) {
    state<ConversationState>().set("pending", pending);
  }
  return next;
}

// Start a turn for `message` if the conversation is idle; otherwise queue it to
// run after the active turn finishes. Guarding here (rather than in the callers)
// keeps the one-turn-at-a-time invariant in one place: this never overwrites an
// in-flight turn's id.
function* startOrQueue(
  conversationId: string,
  message: string,
): Operation<void> {
  if (yield* readTurnId()) {
    // A turn is running: queue the message. It stays out of the committed
    // history until its own turn starts, but is visible via history() below.
    yield* enqueuePending(message);
    return;
  }
  yield* appendEntry({role: "user", text: message});
  const history = yield* readHistory();
  const turnId = yield* startTurn({conversationId, history});
  yield* saveTurnId(turnId);
}

export const Agent = object({
  name: "Agent",
  handlers: {
    // The single entry point for the user. Delegates to startOrQueue, which
    // starts a turn when idle or queues the message when one is running.
    // (Control is a separate, explicit API: the interrupt/steer handlers below.)
    ask: schemas(
      {input: z.string(), output: z.void()},
      function* (message: string): Operation<void> {
        const conversationId = conversationKey();
        yield* startOrQueue(conversationId, message);
      },
    ),

    // Read-only view of the general conversation. Includes queued-but-not-yet-
    // started messages (as user entries) so an accepted message is visible
    // immediately, even before its turn begins.
    history: schemas(
      {input: z.void(), output: z.array(ConversationEntrySchema)},
      function* (): Operation<ConversationEntry[]> {
        const history = yield* readHistory();
        const pending = yield* readPending();
        return [
          ...history,
          ...pending.map((text): ConversationEntry => ({role: "user", text})),
        ];
      },
    ),

    // The active turn reports its single outcome here. Verify it belongs to the
    // active turn (a stale/foreign report is ignored), record it as the turn's
    // assistant entry — carrying turnId + status so a client can find and read
    // the detailed conversation — clear the active turn, then start the next
    // queued message (if any).
    recordSummary: schemas(
      {input: TurnOutcomeSchema, output: z.void()},
      function* (outcome: TurnOutcome): Operation<void> {
        const conversationId = conversationKey();

        if ((yield* readTurnId()) !== outcome.turnId) {
          return; // not the active turn — a superseded or duplicate report
        }

        yield* appendEntry({
          role: "assistant",
          text: outcome.text,
          turnId: outcome.turnId,
          status: outcome.status,
        });
        yield* clearTurnId();

        const next = yield* dequeuePending();
        if (next !== undefined) {
          yield* startOrQueue(conversationId, next);
        }
      },
    ),

    // Direct control API: signal the active turn, if one is running. When no
    // message is passed, the literal word "interrupt"/"steer" is sent.
    //
    // Exclusive (not shared): a shared control handler could run between
    // startOrQueue starting a turn and committing `turnId`, observe no active
    // turn, and drop the command. Handlers never await the turn, so exclusivity
    // stays responsive.
    interrupt: schemas(
      {input: z.string().optional(), output: z.void()},
      function* (reason?: string): Operation<void> {
        const turnId = yield* readTurnId();
        if (turnId) {
          interruptTurn(turnId, reason ?? "interrupt");
        }
      },
    ),
    steer: schemas(
      {input: z.string().optional(), output: z.void()},
      function* (message?: string): Operation<void> {
        const turnId = yield* readTurnId();
        if (turnId) {
          const steer = message ?? "steer";
          // Persist the steer as a conversation event so it's durable and
          // visible to later turns, then redirect the running turn.
          yield* appendEntry({role: "user", text: steer});
          steerTurn(turnId, steer);
        }
      },
    ),
  },
  options: {
    handlers: {
      history: {shared: true},
    },
  },
});
