// Shared domain types, defined as zod schemas so the schema is the single
// source of truth and the TypeScript types are derived from it (`z.infer`).
// Both are exported: consumers use the `*Schema` value where they need runtime
// validation / a JSON schema, and the plain type everywhere else.

import {z} from "zod";

// A message in the per-turn detailed conversation (and the model's context):
// assistant text, tool calls/results, or a steer recorded into the turn.
export const MessageSchema = z.object({
  role: z.enum(["user", "assistant", "tool"]),
  text: z.string(),
});
export type Message = z.infer<typeof MessageSchema>;

// How a turn ended.
export const TurnStatusSchema = z.enum(["completed", "interrupted", "failed"]);
export type TurnStatus = z.infer<typeof TurnStatusSchema>;

// An entry in the general conversation. A `user` entry is a plain message; an
// `assistant` entry is a turn's summary and carries that turn's identity and
// status, so a client can see how the turn ended and query its detailed
// conversation (the Turn object keyed by `turnId`).
export const ConversationEntrySchema = z.discriminatedUnion("role", [
  z.object({role: z.literal("user"), text: z.string()}),
  z.object({
    role: z.literal("assistant"),
    text: z.string(),
    turnId: z.string(),
    status: TurnStatusSchema,
  }),
]);
export type ConversationEntry = z.infer<typeof ConversationEntrySchema>;

// The general conversation owned by the Agent: the user-facing thread. `turnId`
// is the active turn's invocation id (unset when idle); `pending` holds messages
// received while a turn was running, to be run as their own turns afterwards.
export const ConversationStateSchema = z.object({
  history: z.array(ConversationEntrySchema),
  turnId: z.string(),
  pending: z.array(z.string()),
});
export type ConversationState = z.infer<typeof ConversationStateSchema>;

// The per-turn detailed conversation owned by a Turn object: the trace of one
// turn's steps, kept separate from the general conversation.
export const TurnStateSchema = z.object({
  history: z.array(MessageSchema),
});
export type TurnState = z.infer<typeof TurnStateSchema>;

// Input to a turn: which conversation it belongs to, and the conversation
// history so far (ending with the message that triggered it) as the model's
// context.
export const TurnRequestSchema = z.object({
  conversationId: z.string(),
  history: z.array(ConversationEntrySchema),
});
export type TurnRequest = z.infer<typeof TurnRequestSchema>;

// The single outcome a turn reports back to the general conversation: its own
// id (so the Agent can confirm identity and a client can find the detail), how
// it ended, and the summary text.
export const TurnOutcomeSchema = z.object({
  turnId: z.string(),
  status: TurnStatusSchema,
  text: z.string(),
});
export type TurnOutcome = z.infer<typeof TurnOutcomeSchema>;
