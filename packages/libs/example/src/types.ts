// Shared domain types, defined as zod schemas so the schema is the single
// source of truth and the TypeScript types are derived from it (`z.infer`).
// Both are exported: consumers use the `*Schema` value where they need runtime
// validation / a JSON schema, and the plain type everywhere else.

import {z} from "zod";

// How a turn ended.
export const TurnStatusSchema = z.enum(["completed", "interrupted", "failed"]);
export type TurnStatus = z.infer<typeof TurnStatusSchema>;

// How a user message entered the agent's execution. Interruptions use the
// dedicated event entry below instead of masquerading as a user message.
export const UserMessageDeliverySchema = z.enum(["turn", "steer", "queued"]);
export type UserMessageDelivery = z.infer<typeof UserMessageDeliverySchema>;

// An entry in the general conversation. Messages record how they entered the
// execution, interrupt requests are explicit events, and assistant entries are
// terminal turn summaries that can be correlated with Restate observability.
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
  z.object({
    role: z.literal("event"),
    type: z.literal("interrupt"),
    turnId: z.string(),
    reason: z.string(),
  }),
]);
export type ConversationEntry = z.infer<typeof ConversationEntrySchema>;

// Input to a turn: which Agent object it belongs to, an optional checkpoint
// over older turns, and the exact uncompacted history the model should see.
export const TurnRequestSchema = z.object({
  agentId: z.string(),
  summary: z.string().min(1).optional(),
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

// A human approval requested by a tool running inside a Turn invocation.
export const ApprovalRequestSchema = z.object({
  approvalId: z.string().min(1),
  turnId: z.string().min(1),
  question: z.string().min(1),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

// The decision delivered back to the waiting tool over a durable signal.
export const ApprovalDecisionSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  reason: z.string().optional(),
});
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

// Public input used to resolve one pending approval on the Agent object.
export const ApprovalResolutionSchema = ApprovalDecisionSchema.extend({
  approvalId: z.string().min(1),
});
export type ApprovalResolution = z.infer<typeof ApprovalResolutionSchema>;

// Internal cleanup request used when a waiting tool is interrupted.
export const ApprovalCancellationSchema = ApprovalRequestSchema.pick({
  approvalId: true,
  turnId: true,
});
export type ApprovalCancellation = z.infer<typeof ApprovalCancellationSchema>;
