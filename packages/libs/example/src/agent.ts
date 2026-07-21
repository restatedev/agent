// Agent is the conversation: a VirtualObject keyed by conversation id that owns
// the durable history and the active turn's invocation id. It never runs the
// turn itself — `ask` starts a turn (see ./turn) with a one-way send and
// returns, so the Agent is never coupled to the turn's execution lifetime.
//
// Every handler declares its input/output as a zod schema (see ./types) via the
// SDK's `schemas()` helper, so payloads are validated on the wire in both
// directions.

import {TerminalError} from "@restatedev/restate-sdk";
import {
  handlerRequest,
  type Operation,
  object,
  schemas,
  sendClient,
  sharedState,
  state,
} from "@restatedev/restate-sdk-gen";
import {z} from "zod";
import {interruptTurn, steerTurn, TurnService} from "./turn";
import {
  AppendEntrySchema,
  type ConversationState,
  type Message,
  MessageSchema,
} from "./types";

export const Agent = object({
  name: "Agent",
  handlers: {
    // The single entry point for the user. Record the message, then decide what
    // to do with it based on whether a turn is already running:
    //   - "interrupt" in the message -> interrupt the running turn
    //   - "steer" in the message     -> steer the running turn
    //   - otherwise                  -> start a turn, but only if none is running
    ask: schemas(
      {input: z.string(), output: z.void()},
      function* (message: string): Operation<void> {
        const conversationId = handlerRequest().key;
        if (!conversationId) {
          throw new TerminalError("Agent.ask requires a conversation key");
        }

        // Always record the user's message first.
        const history =
          (yield* state<ConversationState>().get("history")) ?? [];
        history.push({role: "user", text: message});
        state<ConversationState>().set("history", history);

        // Is a turn already running for this conversation?
        const turnId = yield* state<ConversationState>().get("turnId");
        const text = message.toLowerCase();

        if (text.includes("interrupt")) {
          if (turnId) {
            interruptTurn(turnId, message);
          }
        } else if (text.includes("steer")) {
          if (turnId) {
            steerTurn(turnId, message);
          }
        } else if (!turnId) {
          // No turn running: start one and remember its invocation id.
          const started = yield* sendClient(TurnService).doTurn({
            conversationId,
            message,
          });
          state<ConversationState>().set("turnId", started.id);
        }
        // A normal message while a turn is running is just recorded above; we
        // do not start a second concurrent turn.
      },
    ),

    // Read-only view of the durable conversation history.
    history: schemas(
      {input: z.void(), output: z.array(MessageSchema)},
      function* (): Operation<Message[]> {
        return (yield* sharedState<ConversationState>().get("history")) ?? [];
      },
    ),

    // Serially receive a summary/outcome from the running turn. The final entry
    // marks the turn as no longer active.
    append: schemas(
      {input: AppendEntrySchema, output: z.void()},
      function* (entry): Operation<void> {
        const history =
          (yield* state<ConversationState>().get("history")) ?? [];
        history.push({role: "assistant", text: entry.text});
        state<ConversationState>().set("history", history);

        if (entry.final) {
          state<ConversationState>().clear("turnId");
        }
      },
    ),

    // Direct control API: signal the active turn, if one is running. Shared so
    // control signals don't queue behind appends. (ask() also routes here via
    // the "interrupt"/"steer" keywords.) When no message is passed, the literal
    // word "interrupt"/"steer" is sent as the message.
    interrupt: schemas(
      {input: z.string().optional(), output: z.void()},
      function* (reason?: string): Operation<void> {
        const turnId = yield* sharedState<ConversationState>().get("turnId");
        if (turnId) {
          interruptTurn(turnId, reason ?? "interrupt");
        }
      },
    ),
    steer: schemas(
      {input: z.string().optional(), output: z.void()},
      function* (message?: string): Operation<void> {
        const turnId = yield* sharedState<ConversationState>().get("turnId");
        if (turnId) {
          steerTurn(turnId, message ?? "steer");
        }
      },
    ),
  },
  options: {
    handlers: {
      history: {shared: true},
      interrupt: {shared: true},
      steer: {shared: true},
    },
  },
});
