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
import {history} from "./agent-history.js";
import {type MessageRoute, routeMessage} from "./model.js";
import {interruptTurn, startTurn, steerTurn} from "./turn.js";
import {
  type ConversationEntry,
  ConversationEntrySchema,
  type TurnOutcome,
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

type ActiveTurnState = {
  id: string;
  interrupting: boolean;
  sentSteering: number;
};

// The previous revision stored the steering messages themselves. Normalize
// that short-lived state shape when an active turn is read.
type StoredActiveTurn = Omit<ActiveTurnState, "sentSteering"> & {
  sentSteering?: number | string[];
};

const activeTurn = {
  *get(): Operation<ActiveTurnState | undefined> {
    const current = yield* sharedState().get<StoredActiveTurn>("turn");
    if (!current) {
      return undefined;
    }
    return {
      ...current,
      sentSteering: Array.isArray(current.sentSteering)
        ? current.sentSteering.length
        : (current.sentSteering ?? 0),
    };
  },

  // Append a batch of user messages and start one turn for the resulting
  // history. The guard preserves the one-turn-at-a-time invariant.
  *start(
    agentId: string,
    messages: string[],
    delivery: Extract<UserMessageDelivery, "turn" | "queued">,
  ): Operation<void> {
    if (messages.length === 0 || (yield* this.get())) {
      return;
    }
    yield* history.append(
      ...messages.map(
        (text): ConversationEntry => ({role: "user", text, delivery}),
      ),
    );
    const recentHistory = (yield* history.read()).slice(
      -MAX_TURN_HISTORY_ENTRIES,
    );
    const turnId = yield* startTurn({agentId, history: recentHistory});
    state().set("turn", {
      id: turnId,
      interrupting: false,
      sentSteering: 0,
    });
  },

  // Accept one conversational message. Routing is inlined here because it is
  // used only for messages that arrive while this turn is active.
  *ask(agentId: string, message: string): Operation<void> {
    const current = yield* this.get();
    if (!current) {
      yield* this.start(agentId, [message], "turn");
      return;
    }

    let route: MessageRoute = "queue";
    if (!current.interrupting) {
      try {
        const recent = (yield* history.read())
          .slice(-ROUTER_CONTEXT_ENTRIES)
          .map((entry) => {
            if (entry.role === "user") {
              return `user${entry.delivery ? ` (${entry.delivery})` : ""}: ${entry.text}`;
            }
            return entry.role === "assistant"
              ? `assistant (${entry.status}): ${entry.text}`
              : `event (${entry.type}): ${entry.reason}`;
          });
        route = yield* routeMessage(message, recent);
      } catch (error) {
        if (error instanceof CancelledError) {
          throw error;
        }
      }
    }

    if (route === "interrupt") {
      yield* this.interrupt(message);
      return;
    }
    if (route === "steer") {
      yield* this.steer(message);
      return;
    }

    const pending = (yield* sharedState().get<string[]>("pending")) ?? [];
    pending.push(message);
    state().set("pending", pending);
  },

  // Resolving the signal only starts wind-down. Agent.append retires the turn
  // after its terminal outcome arrives, keeping the next turn from racing it.
  *interrupt(reason: string): Operation<boolean> {
    const current = yield* this.get();
    if (!current || current.interrupting) {
      return false;
    }
    yield* history.append({
      role: "event",
      type: "interrupt",
      turnId: current.id,
      reason,
    });
    interruptTurn(current.id, reason);
    state().set("turn", {...current, interrupting: true});
    return true;
  },

  // Returns false without recording anything when no turn is still listening;
  // the caller then decides whether to queue the message instead.
  *steer(message: string): Operation<boolean> {
    const current = yield* this.get();
    if (!current || current.interrupting) {
      return false;
    }
    yield* history.append({
      role: "user",
      text: message,
      delivery: "steer",
    });
    state().set("turn", {
      ...current,
      sentSteering: current.sentSteering + 1,
    });
    steerTurn(current.id, message);
    return true;
  },

  *pending(): Operation<string[]> {
    return (yield* sharedState().get<string[]>("pending")) ?? [];
  },

  // Reconcile one terminal outcome, retire its state, and start a follow-up
  // turn for steering or messages that were not consumed.
  *finish(agentId: string, outcome: TurnOutcome): Operation<void> {
    const current = yield* this.get();
    if (current?.id !== outcome.turnId) {
      return;
    }

    const unconsumedSteering =
      outcome.status === "interrupted"
        ? []
        : yield* history.takeLatestSteering(
            Math.max(0, current.sentSteering - outcome.consumedSteering),
          );

    yield* history.append({
      role: "assistant",
      text: outcome.text,
      turnId: outcome.turnId,
      status: outcome.status,
    });
    state().clear("turn");

    const pending = (yield* sharedState().get<string[]>("pending")) ?? [];
    if (pending.length > 0) {
      state().clear("pending");
    }
    yield* this.start(agentId, [...unconsumedSteering, ...pending], "queued");
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
        yield* activeTurn.ask(agentKey(), message);
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
        const entries = yield* history.read();
        const pending = yield* activeTurn.pending();
        return [
          ...entries,
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
      function* (outcome): Operation<void> {
        yield* activeTurn.finish(agentKey(), outcome);
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
