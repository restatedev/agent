// Shared domain types, defined as zod schemas so the schema is the single
// source of truth and the TypeScript types are derived from it (`z.infer`).
// Both are exported: consumers use the `*Schema` value where they need runtime
// validation / a JSON schema, and the plain type everywhere else.

import {z} from "zod";

// A single message. The general conversation uses `user`/`assistant`; the
// per-turn conversation additionally uses `tool` for tool calls and results.
export const MessageSchema = z.object({
  role: z.enum(["user", "assistant", "tool"]),
  text: z.string(),
});
export type Message = z.infer<typeof MessageSchema>;

// The general conversation owned by the Agent: the user-facing thread. It holds
// one `user` message per ask and one `assistant` summary per turn. `turnId` is
// the active turn's invocation id (unset when idle); `pending` holds messages
// received while a turn was running, to be run as their own turns afterwards.
export const ConversationStateSchema = z.object({
  history: z.array(MessageSchema),
  turnId: z.string(),
  pending: z.array(z.string()),
});
export type ConversationState = z.infer<typeof ConversationStateSchema>;

// The per-turn detailed conversation owned by a Turn object: the trace of one
// turn's steps (assistant chunks + tool calls/results), kept separate from the
// general conversation.
export const TurnStateSchema = z.object({
  history: z.array(MessageSchema),
});
export type TurnState = z.infer<typeof TurnStateSchema>;

// Input to a turn: which conversation it belongs to, and the conversation
// history so far (ending with the message that triggered it) as the model's
// context.
export const TurnRequestSchema = z.object({
  conversationId: z.string(),
  history: z.array(MessageSchema),
});
export type TurnRequest = z.infer<typeof TurnRequestSchema>;

// The single summary a turn reports back to the general conversation.
export const SummarySchema = z.object({
  text: z.string(),
});
export type Summary = z.infer<typeof SummarySchema>;
