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
} from "@restatedev/restate-sdk-gen";
import {z} from "zod";
import {agentState} from "./agent-state.js";
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

// Keep the Turn invocation payload bounded as the durable transcript grows.
// Turn applies the tighter model-specific filter/window after receiving it.
const MAX_TURN_HISTORY_ENTRIES = 80;
const ROUTER_CONTEXT_ENTRIES = 8;

const activeTurn = {
  // Append a batch of user messages and start one turn for the resulting
  // history. The guard preserves the one-turn-at-a-time invariant.
  *start(
    agentId: string,
    messages: string[],
    delivery: Extract<UserMessageDelivery, "turn" | "queued">,
  ): Operation<void> {
    if (messages.length === 0 || (yield* agentState.getTurn())) {
      return;
    }
    yield* agentState.appendHistory(
      ...messages.map(
        (text): ConversationEntry => ({role: "user", text, delivery}),
      ),
    );
    const history = (yield* agentState.getHistory()).slice(
      -MAX_TURN_HISTORY_ENTRIES,
    );
    const turnId = yield* startTurn({agentId, history});
    yield* agentState.setTurn({
      id: turnId,
      interrupting: false,
      sentSteering: 0,
    });
  },

  // Resolving the signal only starts wind-down. Agent.append retires the turn
  // after its terminal outcome arrives, keeping the next turn from racing it.
  *interrupt(reason: string): Operation<boolean> {
    const turn = yield* agentState.getTurn();
    if (!turn || turn.interrupting) {
      return false;
    }
    yield* agentState.appendHistory({
      role: "event",
      type: "interrupt",
      turnId: turn.id,
      reason,
    });
    interruptTurn(turn.id, reason);
    yield* agentState.setTurn({...turn, interrupting: true});
    return true;
  },

  // Returns false without recording anything when no turn is still listening;
  // the caller then decides whether to queue the message instead.
  *steer(message: string): Operation<boolean> {
    const turn = yield* agentState.getTurn();
    if (!turn || turn.interrupting) {
      return false;
    }
    yield* agentState.appendHistory({
      role: "user",
      text: message,
      delivery: "steer",
    });
    yield* agentState.setTurn({
      ...turn,
      sentSteering: turn.sentSteering + 1,
    });
    steerTurn(turn.id, message);
    return true;
  },

  // Routing is advisory. A classifier outage must not lose an accepted user
  // message, so any non-cancellation failure falls back to the pending queue.
  *route(message: string): Operation<MessageRoute> {
    try {
      const recent = (yield* agentState.getHistory())
        .slice(-ROUTER_CONTEXT_ENTRIES)
        .map((entry) => {
          if (entry.role === "user") {
            return `user${entry.delivery ? ` (${entry.delivery})` : ""}: ${entry.text}`;
          }
          return entry.role === "assistant"
            ? `assistant (${entry.status}): ${entry.text}`
            : `event (${entry.type}): ${entry.reason}`;
        });
      return yield* routeMessage(message, recent);
    } catch (error) {
      if (error instanceof CancelledError) {
        throw error;
      }
      return "queue";
    }
  },
};

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

        const turn = yield* agentState.getTurn();
        if (!turn) {
          yield* activeTurn.start(agentId, [message], "turn");
          return;
        }

        // A winding-down turn no longer consumes steering signals, so there is
        // no useful routing decision to make; preserve the message for next.
        if (turn.interrupting) {
          yield* agentState.enqueue(message);
          return;
        }

        switch (yield* activeTurn.route(message)) {
          case "interrupt":
            yield* activeTurn.interrupt(message);
            break;
          case "steer":
            if (!(yield* activeTurn.steer(message))) {
              yield* agentState.enqueue(message);
            }
            break;
          case "queue":
            yield* agentState.enqueue(message);
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
        return yield* activeTurn.interrupt(reason);
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
        return yield* activeTurn.steer(message);
      },
    ),

    // Read-only view of the general conversation. Includes queued-but-not-yet-
    // started messages (as user entries) so an accepted message is visible
    // immediately, even before its turn begins.
    history: schemas(
      {input: z.void(), output: z.array(ConversationEntrySchema)},
      function* (): Operation<ConversationEntry[]> {
        const history = yield* agentState.getHistory();
        const pending = yield* agentState.getPending();
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
        const turn = yield* agentState.getTurn();

        if (turn?.id !== turnId) {
          return; // not the active turn — a superseded or duplicate report
        }

        // Interrupt is authoritative and discards outstanding steering. On any
        // other ending, carry steering that the Turn never consumed into one
        // follow-up turn instead of leaving it dead-lettered in history.
        const unconsumedSteering =
          status === "interrupted"
            ? []
            : yield* agentState.takeLatestSteering(
                Math.max(0, turn.sentSteering - consumedSteering),
              );

        yield* agentState.appendHistory({
          role: "assistant",
          text,
          turnId,
          status,
        });
        yield* agentState.clearTurn();

        yield* activeTurn.start(
          agentId,
          [...unconsumedSteering, ...(yield* agentState.drainPending())],
          "queued",
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
