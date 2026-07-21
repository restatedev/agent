// Agent is the durable conversation controller. It is a Virtual Object keyed
// by agent id, so its exclusive handlers serialize every decision about the
// active turn, queued messages, and user-facing history.
//
// It never runs the agent loop itself. `ask` starts a stateless Turn service
// with a one-way send, `interrupt` and `steer` resolve signals on that
// invocation, and `append` accepts the Turn's single high-level outcome.

import {CancelledError, TerminalError} from "@restatedev/restate-sdk";
import {
  handlerRequest,
  type Operation,
  object,
  schemas,
  sharedState,
  state,
} from "@restatedev/restate-sdk-gen";
import {z} from "zod";
import {type MessageRoute, routeMessage} from "./model.js";
import {interruptTurn, startTurn, steerTurn} from "./turn.js";
import {
  type ConversationEntry,
  ConversationEntrySchema,
  TurnOutcomeSchema,
  type UserMessageDelivery,
} from "./types.js";

// The agent id is this object's key. Object handlers always have one, but read
// it through here so a missing key is a clear error, not a stray `!`.
function agentKey(): string {
  const key = handlerRequest().key;
  if (!key) {
    throw new TerminalError("Agent handlers require an agent key");
  }
  return key;
}

// --- State access -----------------------------------------------------------
// Encapsulate every read/write behind a named Operation, so the handlers read
// as intent ("read the active turn", "append an entry") rather than key strings.
// Reads use `sharedState()` (read-only, usable from any handler); writes use
// `state()` (only valid in an exclusive handler). The keys are `turn`
// (ActiveTurn), `history` (ConversationEntry[]), and `pending` (string[]).

// The active turn as this object tracks it. `id` is the turn's invocation id
// and the signal target. `sentSteering` is the FIFO sequence resolved on that
// invocation; it remains optional so state written by older deployments can be
// read safely. `interrupting` marks the
// wind-down window: we have asked the turn to stop, but its terminal summary
// (which is what retires the turn, see append) has not arrived yet.
// Control decisions need that window to be visible — a turn that is winding
// down has stopped selecting signals, so steering it is futile and
// re-interrupting it is a no-op.
type ActiveTurn = {
  id: string;
  interrupting: boolean;
  sentSteering?: string[];
};

// Keep the Turn invocation payload bounded as the durable transcript grows.
// Turn applies the tighter model-specific filter/window after receiving it.
const MAX_TURN_HISTORY_ENTRIES = 80;
const ROUTER_CONTEXT_ENTRIES = 8;

function* readTurn(): Operation<ActiveTurn | undefined> {
  return (yield* sharedState().get<ActiveTurn>("turn")) ?? undefined;
}

function* saveTurn(turn: ActiveTurn): Operation<void> {
  state().set("turn", turn);
}

function* clearTurn(): Operation<void> {
  state().clear("turn");
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

// Take every queued message at once. The queue drains as one batch: messages
// sent while a turn was running were all typed against the same conversation
// state, so one turn seeing all of them produces one coherent answer — instead
// of a cascade of turns each answering one fragment with near-identical
// context, at a full model loop apiece.
function* drainPending(): Operation<string[]> {
  const pending = yield* readPending();
  if (pending.length > 0) {
    state().clear("pending");
  }
  return pending;
}

// Remove the latest `count` steering entries from a model-history snapshot.
// They remain in the durable user-facing history, but `beginTurn` passes them
// separately so the Turn can place unconsumed steering after the answer that
// raced with it instead of presenting the instruction twice.
function omitLatestSteering(
  history: ConversationEntry[],
  count: number,
): ConversationEntry[] {
  let remaining = count;
  return history
    .toReversed()
    .filter((entry) => {
      if (
        remaining > 0 &&
        entry.role === "user" &&
        entry.delivery === "steer"
      ) {
        remaining -= 1;
        return false;
      }
      return true;
    })
    .toReversed();
}

// Begin a turn for new `messages` and/or steering that the previous turn did
// not consume. New messages are appended to the transcript; replayed steering
// already exists there and is moved to the end of the model context only.
// Guards the one-turn-at-a-time invariant in one place, so an in-flight turn
// cannot be orphaned.
function* beginTurn(
  agentId: string,
  messages: string[],
  delivery: Extract<UserMessageDelivery, "turn" | "queued">,
  replayedSteering: string[] = [],
): Operation<void> {
  if (
    (messages.length === 0 && replayedSteering.length === 0) ||
    (yield* readTurn())
  ) {
    return;
  }
  for (const message of messages) {
    yield* appendEntry({role: "user", text: message, delivery});
  }
  const history = omitLatestSteering(
    yield* readHistory(),
    replayedSteering.length,
  ).slice(-MAX_TURN_HISTORY_ENTRIES);
  const turnId = yield* startTurn({agentId, history, replayedSteering});
  yield* saveTurn({id: turnId, interrupting: false, sentSteering: []});
}

// Ask the active turn to stop, with `reason`. Fire-and-forget BY DESIGN: this
// resolves the signal and returns — the turn is NOT finished yet. It winds
// down on its own (aborts in-flight model I/O, joins its task) and then reports
// its summary like any other ending; only that report (append) retires
// the turn. Starting the next turn therefore never waits on an interrupt
// explicitly: beginTurn is gated on the active turn, and messages arriving
// during the wind-down queue as pending. Blocking here until the turn died
// would be worse, not safer — this runs in an exclusive handler, so it would
// freeze the whole conversation for the duration of the wind-down.
//
// Explicit `interrupt` calls keep the reason only in the turn summary. An
// `ask` classified as interrupt opts into recording the original user message
// with delivery "interrupt", because every accepted `ask` belongs in history.
//
// Returns false when there is nothing to stop: the conversation is idle, or
// the turn is already winding down (the signal is single-shot; a second
// resolve would be a silent no-op, so report it as one honestly). The inherent
// completion race stands: true means the signal was sent — a turn finishing at
// that same instant may still report "completed", and the transcript records
// what actually happened.
function* interruptActive(
  reason: string,
  recordUserMessage = false,
): Operation<boolean> {
  const turn = yield* readTurn();
  if (!turn || turn.interrupting) {
    return false;
  }
  if (recordUserMessage) {
    yield* appendEntry({role: "user", text: reason, delivery: "interrupt"});
  }
  interruptTurn(turn.id, reason);
  yield* saveTurn({...turn, interrupting: true});
  return true;
}

// Steer the active turn to `message`, if one is running AND still listening.
// The steer is recorded as a user entry, so the transcript shows what
// redirected the turn.
//
// Returns false — with NO side effects — when no turn will act on the steer:
// the conversation is idle, or the turn is winding down after an interrupt.
// The wind-down case matters: the turn's loop has already stopped selecting
// steering signals, so resolving one would strand the message in a signal
// nobody reads, while its transcript entry pretended it was heard. The caller
// owns the fallback (ask() queues the message for the next turn; an external
// caller re-sends via ask).
function* steerActive(message: string): Operation<boolean> {
  const turn = yield* readTurn();
  if (!turn || turn.interrupting) {
    return false;
  }
  yield* appendEntry({role: "user", text: message, delivery: "steer"});
  yield* saveTurn({
    ...turn,
    sentSteering: [...(turn.sentSteering ?? []), message],
  });
  steerTurn(turn.id, message);
  return true;
}

// Routing is advisory. A classifier outage must not lose an accepted user
// message, so any non-cancellation failure falls back to the pending queue.
function* classify(message: string): Operation<MessageRoute> {
  try {
    const recent = (yield* readHistory())
      .slice(-ROUTER_CONTEXT_ENTRIES)
      .map((entry) =>
        entry.role === "user"
          ? `user${entry.delivery ? ` (${entry.delivery})` : ""}: ${entry.text}`
          : `assistant (${entry.status}): ${entry.text}`,
      );
    return yield* routeMessage(message, recent);
  } catch (error) {
    if (error instanceof CancelledError) {
      throw error;
    }
    return "queue";
  }
}

export const Agent = object({
  name: "Agent",
  handlers: {
    // The plain-text entry point for the user. When idle, the message starts a
    // turn. When a turn is already running, a fast model classifies it as a
    // steer, interrupt, or queued follow-up. Clients with explicit stop/edit UI
    // should still call the handlers below and skip classification entirely.
    ask: schemas(
      {input: z.string(), output: z.void()},
      function* (message): Operation<void> {
        const agentId = agentKey();

        const turn = yield* readTurn();
        if (!turn) {
          yield* beginTurn(agentId, [message], "turn");
          return;
        }

        // A winding-down turn no longer consumes steering signals, so there is
        // no useful routing decision to make; preserve the message for next.
        if (turn.interrupting) {
          yield* enqueuePending(message);
          return;
        }

        switch (yield* classify(message)) {
          case "interrupt":
            yield* interruptActive(message, true);
            break;
          case "steer":
            if (!(yield* steerActive(message))) {
              yield* enqueuePending(message);
            }
            break;
          case "queue":
            yield* enqueuePending(message);
            break;
        }
      },
    ),

    // Explicitly stop the active turn; the input is the reason. No intent
    // guessing — this is the API a stop button calls. Returns whether the stop
    // was requested; false means there was nothing to stop (idle, or already
    // winding down from an earlier interrupt) and nothing happened.
    interrupt: schemas(
      {input: z.string(), output: z.boolean()},
      function* (reason): Operation<boolean> {
        return yield* interruptActive(reason);
      },
    ),

    // Explicitly redirect the active turn with a new instruction. Returns
    // whether a turn will act on it; false means no turn is listening (idle,
    // or winding down after an interrupt) and nothing was recorded — the
    // caller decides the fallback (typically sending the message via `ask`,
    // which queues it for the next turn).
    steer: schemas(
      {input: z.string(), output: z.boolean()},
      function* (message): Operation<boolean> {
        return yield* steerActive(message);
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
          ...pending.map(
            (text): ConversationEntry => ({
              role: "user",
              text,
              delivery: "queued",
            }),
          ),
        ];
      },
    ),

    // The active Turn sends exactly one structured outcome here. Verify it
    // belongs to the active turn, append the user-facing assistant entry,
    // retire the turn, and start one batch turn for anything queued meanwhile.
    // This is intentionally high-level: detailed tool/model activity belongs
    // in Restate's invocation logs and observability, not conversation state.
    append: schemas(
      {input: TurnOutcomeSchema, output: z.void()},
      function* ({turnId, status, text, consumedSteering}): Operation<void> {
        const agentId = agentKey();
        const turn = yield* readTurn();

        if (turn?.id !== turnId) {
          return; // not the active turn — a superseded or duplicate report
        }

        // Interrupt is authoritative and discards outstanding steering. On any
        // other ending, carry steering that the Turn never consumed into one
        // follow-up turn instead of leaving it dead-lettered in history.
        const replayedSteering =
          status === "interrupted"
            ? []
            : (turn.sentSteering ?? []).slice(consumedSteering);

        yield* appendEntry({
          role: "assistant",
          text,
          turnId,
          status,
        });
        yield* clearTurn();

        yield* beginTurn(
          agentId,
          yield* drainPending(),
          "queued",
          replayedSteering,
        );
      },
    ),
  },
  options: {
    handlers: {
      append: {
        ingressPrivate: true,
        idempotencyRetention: 0,
        journalRetention: 0,
      },
      history: {shared: true, idempotencyRetention: 0, journalRetention: 0},
    },
  },
});
