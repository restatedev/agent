// Agent is the general conversation: a VirtualObject keyed by conversation id
// that owns everything durable about the conversation — the user-facing thread
// (user messages + one assistant summary per turn), the per-turn detailed
// traces, and the active turn's id. It never runs the turn itself — it starts
// one (see ./turn, a stateless service) with a one-way send and returns.
//
// Two views, one owner. `history` is the clean transcript; `trace(turnId)` is
// the "inside the run" detail a summary entry points into. Both live here
// because both are conversation data: one object to query, one object's state
// to delete when the conversation goes.

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
  type Message,
  MessageSchema,
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
// `state()` (only valid in an exclusive handler). The keys are `turn`
// (ActiveTurn), `history` (ConversationEntry[]), `pending` (string[]), and one
// `trace/<turnId>` (Message[]) per turn.

// The active turn as this object tracks it. `id` is the turn's invocation id —
// its identity, its trace key, and the signal target. `interrupting` marks the
// wind-down window: we have asked the turn to stop, but its terminal summary
// (which is what retires the turn, see recordSummary) has not arrived yet.
// Control decisions need that window to be visible — a turn that is winding
// down has stopped selecting signals, so steering it is futile and
// re-interrupting it is a no-op.
type ActiveTurn = {id: string; interrupting: boolean};

function* readTurn(): Operation<ActiveTurn | undefined> {
  return (yield* sharedState().get<ActiveTurn>("turn")) ?? undefined;
}

function* saveTurn(turn: ActiveTurn): Operation<void> {
  state().set("turn", turn);
}

function* clearTurn(): Operation<void> {
  state().clear("turn");
}

// Per-turn traces live under their own state keys, one per turn, so reading or
// growing one turn's trace never touches another's. This pair is the only
// place that knows the key format.
function traceKey(turnId: string): string {
  return `trace/${turnId}`;
}

function* readTrace(turnId: string): Operation<Message[]> {
  return (yield* sharedState().get<Message[]>(traceKey(turnId))) ?? [];
}

function* appendTraceEntry(turnId: string, entry: Message): Operation<void> {
  const trace = yield* readTrace(turnId);
  trace.push(entry);
  state().set(traceKey(turnId), trace);
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

// Begin a turn for `messages` (one or more user messages; all are appended to
// the transcript, so the turn's context ends with the whole batch). Guards the
// one-turn-at-a-time invariant in one place: it never starts a turn while one
// is already running, so an in-flight turn can't be orphaned. Callers begin
// only when idle (ask when no turn is running; recordSummary after clearing
// the finished turn). An empty batch is a no-op.
function* beginTurn(
  conversationId: string,
  messages: string[],
): Operation<void> {
  if (messages.length === 0 || (yield* readTurn())) {
    return;
  }
  for (const message of messages) {
    yield* appendEntry({role: "user", text: message});
  }
  const history = yield* readHistory();
  const turnId = yield* startTurn({conversationId, history});
  yield* saveTurn({id: turnId, interrupting: false});
}

// Ask the active turn to stop, with `reason`. Fire-and-forget BY DESIGN: this
// resolves the signal and returns — the turn is NOT finished yet. It winds
// down on its own (aborts the model stream, joins its task) and then reports
// its summary like any other ending; only that report (recordSummary) retires
// the turn. Starting the next turn therefore never waits on an interrupt
// explicitly: beginTurn is gated on the active turn, and messages arriving
// during the wind-down queue as pending. Blocking here until the turn died
// would be worse, not safer — this runs in an exclusive handler, so it would
// freeze the whole conversation for the duration of the wind-down.
//
// The reason is not appended to the transcript — it comes back as the turn's
// summary text (status "interrupted"), so recording it now would double it.
//
// Returns false when there is nothing to stop: the conversation is idle, or
// the turn is already winding down (the signal is single-shot; a second
// resolve would be a silent no-op, so report it as one honestly). The inherent
// completion race stands: true means the signal was sent — a turn finishing at
// that same instant may still report "completed", and the transcript records
// what actually happened.
function* interruptActive(reason: string): Operation<boolean> {
  const turn = yield* readTurn();
  if (!turn || turn.interrupting) {
    return false;
  }
  interruptTurn(turn.id, reason);
  yield* saveTurn({...turn, interrupting: true});
  return true;
}

// Steer the active turn to `message`, if one is running AND still listening.
// The steer is recorded as a user entry (the turn also records it in its own
// trace), so the transcript shows what redirected the turn.
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
  yield* appendEntry({role: "user", text: message});
  steerTurn(turn.id, message);
  return true;
}

export const Agent = object({
  name: "Agent",
  handlers: {
    // The plain-text entry point for the user. When idle, the message starts a
    // turn. When a turn is already running, decide what to do with the message:
    //   - contains "interrupt"      -> stop the running turn (message = reason)
    //   - contains "steer"          -> redirect the running turn with the message
    //   - otherwise (incl. "queue") -> run it as its own turn afterward
    //
    // The keyword match is a DEMO shortcut — it even trips on "how do interrupts
    // work?". A real agent would classify the message's intent instead, e.g. with
    // a cheap, fast model deciding "redirect, cancel, or just queue this?". A
    // client with real affordances (a stop button, an edit-and-resend box)
    // shouldn't route through this guessing at all — it calls the explicit
    // `interrupt`/`steer` handlers below.
    ask: schemas(
      {input: z.string(), output: z.void()},
      function* (message): Operation<void> {
        const conversationId = conversationKey();

        if (!(yield* readTurn())) {
          yield* beginTurn(conversationId, [message]);
          return;
        }

        const text = message.toLowerCase();
        if (text.includes("interrupt")) {
          // If this returns false the turn is already winding down — the
          // extra stop request has nothing left to do; drop it.
          yield* interruptActive(message);
        } else if (text.includes("steer")) {
          // A steer that can't be honored (the turn is winding down after an
          // interrupt) still carries the user's words — queue it for the next
          // turn instead of dropping it.
          if (!(yield* steerActive(message))) {
            yield* enqueuePending(message);
          }
        } else {
          // Default (including an explicit "queue"): hold it for the next turn.
          // The whole queue drains into one batch turn when the active one
          // finishes. Visible via history() (which merges pending).
          yield* enqueuePending(message);
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
          ...pending.map((text): ConversationEntry => ({role: "user", text})),
        ];
      },
    ),

    // Read one turn's detailed trace — the "inside the run" record a summary
    // entry's turnId points into. Shared, so it serves concurrently with a
    // running turn: poll it mid-turn to watch the trace grow.
    trace: schemas(
      {input: z.string(), output: z.array(MessageSchema)},
      function* (turnId): Operation<Message[]> {
        return yield* readTrace(turnId);
      },
    ),

    // The running turn reports each detailed step here (streamed text, tool
    // calls/results, steers). The entry does not say which turn it belongs to
    // — it can't: this object already knows its active turn and files the
    // entry under it, so addressing another turn's trace is not even
    // expressible. Send ordering makes the attribution exact, not
    // approximate: Restate delivers sends from one invocation to one object
    // key in submission order, so a turn's appends are all processed while it
    // is still the active turn — its own recordSummary (sent last) is what
    // retires it. An append arriving with no active turn is foreign or
    // spoofed: drop it, there is nothing it could legitimately belong to.
    appendTrace: schemas(
      {input: MessageSchema, output: z.void()},
      function* (entry: Message): Operation<void> {
        const turn = yield* readTurn();
        if (!turn) {
          return;
        }
        // Note: a turn that is winding down (interrupting) still attributes
        // correctly — its id is unchanged until its summary retires it.
        yield* appendTraceEntry(turn.id, entry);
      },
    ),

    // The active turn reports its single outcome here. Verify it belongs to the
    // active turn (a stale/foreign report is ignored), record it as the turn's
    // assistant entry — carrying turnId + status so a client can find and read
    // the detailed trace — clear the active turn, then drain the queue into the
    // next turn (if anything is queued).
    recordSummary: schemas(
      {input: TurnOutcomeSchema, output: z.void()},
      function* ({turnId, status, text}): Operation<void> {
        const conversationId = conversationKey();

        if ((yield* readTurn())?.id !== turnId) {
          return; // not the active turn — a superseded or duplicate report
        }

        yield* appendEntry({
          role: "assistant",
          text,
          turnId,
          status,
        });
        yield* clearTurn();

        yield* beginTurn(conversationId, yield* drainPending());
      },
    ),
  },
  options: {
    handlers: {
      history: {shared: true},
      trace: {shared: true},
    },
  },
});
