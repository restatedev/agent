// Shared domain types, defined as zod schemas so the schema is the single
// source of truth and the TypeScript types are derived from it (`z.infer`).
// Both are exported: consumers use the `*Schema` value where they need runtime
// validation / a JSON schema, and the plain type everywhere else.

import {z} from "zod";

// A single message in a conversation.
export const MessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  text: z.string(),
});
export type Message = z.infer<typeof MessageSchema>;

// Durable per-conversation state owned by the Agent. `turnId` is the invocation
// id of the active turn, and is unset when no turn is running.
export const ConversationStateSchema = z.object({
  history: z.array(MessageSchema),
  turnId: z.string(),
});
export type ConversationState = z.infer<typeof ConversationStateSchema>;

// Input to a turn: which conversation it belongs to, and the user's message.
export const TurnRequestSchema = z.object({
  conversationId: z.string(),
  message: z.string(),
});
export type TurnRequest = z.infer<typeof TurnRequestSchema>;

// A concise message the turn reports back to the Agent. The final entry marks
// the turn as no longer active.
export const AppendEntrySchema = z.object({
  text: z.string(),
  final: z.boolean().optional(),
});
export type AppendEntry = z.infer<typeof AppendEntrySchema>;
