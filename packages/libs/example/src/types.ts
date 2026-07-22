// Shared domain types, defined as zod schemas so the schema is the single
// source of truth and the TypeScript types are derived from it (`z.infer`).
// Both are exported: consumers use the `*Schema` value where they need runtime
// validation / a JSON schema, and the plain type everywhere else.

import {z} from "zod";

// How a turn ended.
export const TurnStatusSchema = z.enum(["completed", "interrupted", "failed"]);
export type TurnStatus = z.infer<typeof TurnStatusSchema>;

// How a user message entered the agent's execution. Optional for compatibility
// with conversations persisted before this field was introduced.
export const UserMessageDeliverySchema = z.enum([
  "turn",
  "steer",
  "queued",
  "interrupt",
]);
export type UserMessageDelivery = z.infer<typeof UserMessageDeliverySchema>;

// An entry in the general conversation. A `user` entry records whether it
// started work, redirected it, queued behind it, or interrupted it. An
// `assistant` entry is a turn's summary and carries that turn's identity and
// status, so a client can correlate it with Restate's observability tooling.
export const ConversationEntrySchema = z.discriminatedUnion("role", [
  z.object({
    role: z.literal("user"),
    text: z.string(),
    delivery: UserMessageDeliverySchema.optional(),
  }),
  z.object({
    role: z.literal("assistant"),
    text: z.string(),
    turnId: z.string(),
    status: TurnStatusSchema,
  }),
]);
export type ConversationEntry = z.infer<typeof ConversationEntrySchema>;

// Input to a turn: which Agent object it belongs to and the conversation
// history the model should see.
export const TurnRequestSchema = z.object({
  agentId: z.string(),
  history: z.array(ConversationEntrySchema),
});
export type TurnRequest = z.infer<typeof TurnRequestSchema>;

// The single outcome a turn reports back to the general conversation: its own
// id (so the Agent can confirm identity), how it ended, and the summary text.
export const TurnOutcomeSchema = z.object({
  turnId: z.string(),
  status: TurnStatusSchema,
  text: z.string(),
  // Number of steering signals this turn actually consumed, in FIFO order.
  // The Agent compares this with what it sent so completion cannot dead-letter
  // a concurrently accepted steer.
  consumedSteering: z.number().int().nonnegative().default(0),
});
export type TurnOutcome = z.infer<typeof TurnOutcomeSchema>;
