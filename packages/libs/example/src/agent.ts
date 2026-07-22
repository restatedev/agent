// Agent is the durable conversation controller. It is a Virtual Object keyed
// by agent id, so its exclusive handlers serialize every decision about the
// active turn, queued messages, and user-facing history.
//
// It never runs the agent loop itself. `ask` starts a stateless Turn service
// with a one-way send, `interrupt` and `steer` resolve signals on that
// invocation, and `append` accepts the Turn's single high-level outcome.

import {TerminalError} from "@restatedev/restate-sdk";
import {
  handlerRequest,
  type Operation,
  object,
  schemas,
} from "@restatedev/restate-sdk-gen";
import {z} from "zod";
import {history} from "./agent-history.js";
import {activeTurn} from "./agent-turn.js";
import {type MessageRoute, routeMessage} from "./model.js";
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

// Cross-component coordination belongs here: record the input, prepare the
// Turn request, then ask activeTurn to own its lifecycle.
function* dispatchTurn(
  agentId: string,
  messages: string[],
  delivery: Extract<UserMessageDelivery, "turn" | "queued">,
): Operation<void> {
  if (messages.length === 0 || (yield* activeTurn.current())) {
    return;
  }
  yield* history.append(
    ...messages.map(
      (text): ConversationEntry => ({role: "user", text, delivery}),
    ),
  );
  yield* activeTurn.start({
    agentId,
    history: yield* history.recent(MAX_TURN_HISTORY_ENTRIES),
  });
}

function* requestInterrupt(reason: string): Operation<boolean> {
  const turnId = yield* activeTurn.interrupt(reason);
  if (!turnId) {
    return false;
  }
  yield* history.append({
    role: "event",
    type: "interrupt",
    turnId,
    reason,
  });
  return true;
}

function* requestSteer(message: string): Operation<boolean> {
  if (!(yield* activeTurn.steer(message))) {
    return false;
  }
  yield* history.append({role: "user", text: message, delivery: "steer"});
  return true;
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
        const current = yield* activeTurn.current();
        if (!current) {
          yield* dispatchTurn(agentId, [message], "turn");
          return;
        }

        // A turn winding down no longer consumes steering, so skip routing and
        // preserve the accepted message for the next turn.
        let route: MessageRoute = "queue";
        if (!current.interrupting) {
          const recent = (yield* history.recent(ROUTER_CONTEXT_ENTRIES)).map(
            (entry) => {
              if (entry.role === "user") {
                return `user${entry.delivery ? ` (${entry.delivery})` : ""}: ${entry.text}`;
              }
              return entry.role === "assistant"
                ? `assistant (${entry.status}): ${entry.text}`
                : `event (${entry.type}): ${entry.reason}`;
            },
          );
          route = yield* routeMessage(message, recent);
        }

        if (route === "interrupt") {
          if (!(yield* requestInterrupt(message))) {
            yield* activeTurn.enqueue(message);
          }
          return;
        }
        if (route === "steer") {
          if (!(yield* requestSteer(message))) {
            yield* activeTurn.enqueue(message);
          }
          return;
        }
        yield* activeTurn.enqueue(message);
      },
    ),

    // Explicitly stop the active turn; the input is the reason. No intent
    // guessing — this is the API a stop button calls. Returns whether the stop
    // was requested; false means there was nothing to stop (idle, or already
    // winding down from an earlier interrupt) and nothing happened.
    interrupt: schemas(
      {input: z.string(), output: z.boolean()},
      function* (reason): Operation<boolean> {
        return yield* requestInterrupt(reason);
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
        return yield* requestSteer(message);
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
        const finished = yield* activeTurn.finish(outcome);
        if (!finished) {
          return;
        }

        const unconsumedSteering = yield* history.takeLatestSteering(
          finished.missedSteering,
        );
        yield* history.append({
          role: "assistant",
          text: outcome.text,
          turnId: outcome.turnId,
          status: outcome.status,
        });
        yield* dispatchTurn(
          agentKey(),
          [...unconsumedSteering, ...finished.pending],
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
