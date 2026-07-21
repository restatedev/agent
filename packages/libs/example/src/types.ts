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

// What to do with a new message that arrives while a turn is already running:
//   - queue     -> run it as its own turn after the active one finishes
//   - steer     -> redirect the running turn with the message
//   - interrupt -> stop the running turn (the message is the reason)
export const AskDispositionSchema = z.enum(["queue", "steer", "interrupt"]);
export type AskDisposition = z.infer<typeof AskDispositionSchema>;

// A user message, plus how to treat it if a turn is in flight (default: queue).
export const AskSchema = z.object({
  message: z.string(),
  ifBusy: AskDispositionSchema.optional(),
});
export type Ask = z.infer<typeof AskSchema>;

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
