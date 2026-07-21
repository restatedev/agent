// Agent is the general conversation: a VirtualObject keyed by conversation id
// that owns the user-facing thread (one `user` message per ask, one `assistant`
// summary per turn) and the active turn's invocation id. It never runs the turn
// itself — it starts one (see ./turn) with a one-way send and returns.
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
  type ConversationState,
  type Message,
  MessageSchema,
  type Summary,
  SummarySchema,
} from "./types";

// Append `message` as a user turn and start a turn for it, remembering the
// turn's invocation id. The turn is handed the whole history so far as context.
function* startNextTurn(
  conversationId: string,
  message: string,
): Operation<void> {
  const history = (yield* state<ConversationState>().get("history")) ?? [];
  history.push({role: "user", text: message});
  state<ConversationState>().set("history", history);

  const turnId = yield* startTurn({conversationId, history});
  state<ConversationState>().set("turnId", turnId);
}

export const Agent = object({
  name: "Agent",
  handlers: {
    // The single entry point for the user. If no turn is running, start one for
    // this message. If a turn is running, queue the message — it runs as its own
    // turn once the active one finishes, so messages are never dropped. (Control
    // is a separate, explicit API: the interrupt/steer handlers below.)
    ask: schemas(
      {input: z.string(), output: z.void()},
      function* (message: string): Operation<void> {
        const conversationId = handlerRequest().key;
        if (!conversationId) {
          throw new TerminalError("Agent.ask requires a conversation key");
        }

        const turnId = yield* state<ConversationState>().get("turnId");
        if (turnId) {
          // A turn is running: queue this message for after it finishes.
          const pending =
            (yield* state<ConversationState>().get("pending")) ?? [];
          pending.push(message);
          state<ConversationState>().set("pending", pending);
          return;
        }

        // Idle: record the message and start a turn for it.
        yield* startNextTurn(conversationId, message);
      },
    ),

    // Read-only view of the general conversation.
    history: schemas(
      {input: z.void(), output: z.array(MessageSchema)},
      function* (): Operation<Message[]> {
        return (yield* sharedState<ConversationState>().get("history")) ?? [];
      },
    ),

    // The active turn reports its single summary here. Record it as the turn's
    // assistant message, clear the active turn, then start the next queued
    // message (if any) so the conversation keeps draining deterministically.
    recordSummary: schemas(
      {input: SummarySchema, output: z.void()},
      function* (summary: Summary): Operation<void> {
        const conversationId = handlerRequest().key;
        if (!conversationId) {
          throw new TerminalError(
            "Agent.recordSummary requires a conversation key",
          );
        }

        const history =
          (yield* state<ConversationState>().get("history")) ?? [];
        history.push({role: "assistant", text: summary.text});
        state<ConversationState>().set("history", history);
        state<ConversationState>().clear("turnId");

        const pending =
          (yield* state<ConversationState>().get("pending")) ?? [];
        const next = pending.shift();
        if (next !== undefined) {
          state<ConversationState>().set("pending", pending);
          yield* startNextTurn(conversationId, next);
        }
      },
    ),

    // Direct control API: signal the active turn, if one is running. When no
    // message is passed, the literal word "interrupt"/"steer" is sent.
    //
    // Exclusive (not shared): a shared control handler could run between `ask`
    // starting a turn and committing `turnId`, observe no active turn, and drop
    // the command. `ask` never awaits the turn, so exclusivity stays responsive.
    interrupt: schemas(
      {input: z.string().optional(), output: z.void()},
      function* (reason?: string): Operation<void> {
        const turnId = yield* state<ConversationState>().get("turnId");
        if (turnId) {
          interruptTurn(turnId, reason ?? "interrupt");
        }
      },
    ),
    steer: schemas(
      {input: z.string().optional(), output: z.void()},
      function* (message?: string): Operation<void> {
        const turnId = yield* state<ConversationState>().get("turnId");
        if (turnId) {
          steerTurn(turnId, message ?? "steer");
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
