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
// `state()` (only valid in an exclusive handler). The keys are `turnId`
// (string), `history` (ConversationEntry[]), and `pending` (string[]).

function* readTurnId(): Operation<string | undefined> {
  return (yield* sharedState().get<string>("turnId")) ?? undefined;
}

function* saveTurnId(turnId: string): Operation<void> {
  state().set("turnId", turnId);
}

function* clearTurnId(): Operation<void> {
  state().clear("turnId");
}

function* readHistory(): Operation<ConversationEntry[]> {
  return (yield* sharedState().get<ConversationEntry[]>("history")) ?? [];
}

function* appendEntry(entry: ConversationEntry): Operation<void> {
  const history = yield* readHistory();
  history.push(entry);
  state().set("history", history);
}

function* readPending(): Operation<string[]> {
  return (yield* sharedState().get<string[]>("pending")) ?? [];
}

function* enqueuePending(message: string): Operation<void> {
  const pending = yield* readPending();
  pending.push(message);
  state().set("pending", pending);
}

function* dequeuePending(): Operation<string | undefined> {
  const pending = yield* readPending();
  const next = pending.shift();
  if (next !== undefined) {
    state().set("pending", pending);
  }
  return next;
}

// Begin a turn for `message`. Guards the one-turn-at-a-time invariant in one
// place: it never starts a turn while one is already running, so an in-flight
// turn can't be orphaned. Callers begin only when idle (ask when no turn is
// running; recordSummary after clearing the finished turn).
function* beginTurn(conversationId: string, message: string): Operation<void> {
  if (yield* readTurnId()) {
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
    // The single entry point for the user. When idle, the message starts a turn.
    // When a turn is already running, decide what to do with the message:
    //   - contains "interrupt"      -> stop the running turn (message = reason)
    //   - contains "steer"          -> redirect the running turn with the message
    //   - otherwise (incl. "queue") -> run it as its own turn afterward
    //
    // The keyword match is a DEMO shortcut — it even trips on "how do interrupts
    // work?". A real agent would classify the message's intent instead, e.g. with
    // a cheap, fast model deciding "redirect, cancel, or just queue this?".
    ask: schemas(
      {input: z.string(), output: z.void()},
      function* (message: string): Operation<void> {
        const conversationId = conversationKey();
        const turnId = yield* readTurnId();

        if (!turnId) {
          yield* beginTurn(conversationId, message);
          return;
        }

        const text = message.toLowerCase();
        if (text.includes("interrupt")) {
          interruptTurn(turnId, message);
        } else if (text.includes("steer")) {
          // Record the steer as a conversation event, then redirect the turn.
          yield* appendEntry({role: "user", text: message});
          steerTurn(turnId, message);
        } else {
          // Default (including an explicit "queue"): run it as its own turn once
          // the active one finishes. Visible via history() (which merges pending).
          yield* enqueuePending(message);
        }
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
          yield* beginTurn(conversationId, next);
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
